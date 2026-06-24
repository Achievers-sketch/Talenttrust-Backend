/**
 * @module api/jobs
 *
 * Background job orchestration for webhook delivery and DLQ management.
 *
 * ## Responsibilities
 * - Initialize the DLQ store (in-memory or Redis-backed).
 * - Start the DLQ metrics sampling loop.
 * - Provide a health-check endpoint for monitoring.
 * - Expose authenticated endpoints for idempotent DLQ message replay.
 *
 * ## Configuration (environment variables)
 * | Variable                  | Default | Description                                    |
 * |---------------------------|---------|------------------------------------------------|
 * | `DLQ_METRICS_INTERVAL_MS` | `30000` | DLQ metrics sampling interval in milliseconds. |
 *
 * ## Usage
 * Call {@link initializeJobs} once at application startup (e.g., from `index.ts`).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import { InMemoryDlqStore, type DlqStore } from '../dlqStore';
import { startDlqMetricsSampling, incrementDlqReplay } from '../webhookMetrics';
import { redactPayload } from '../utils/redact';
import { WebhookDeliveryService } from '../services/WebhookDeliveryService';
import { IdempotencyLayer } from '../events/idempotency';
import { isAdminAuth } from '../middleware/auth';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let dlqStore: DlqStore | null = null;
let stopSampling: (() => void) | null = null;

const router = Router();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Load DLQ metrics sampling interval from environment variables.
 *
 * @returns Sampling interval in milliseconds.
 */
function loadDlqMetricsInterval(): number {
  const raw = process.env.DLQ_METRICS_INTERVAL_MS ?? '30000';
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `[api/jobs] Invalid DLQ_METRICS_INTERVAL_MS="${raw}". ` +
        'Must be a finite positive number greater than zero.',
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Public API & Lifecycle Orchestration
// ---------------------------------------------------------------------------

/**
 * Initialize background jobs: DLQ store and metrics sampling.
 *
 * This function is idempotent — calling it multiple times will stop the
 * previous sampling loop and start a new one.
 *
 * @param customDlqStore - Optional custom DLQ store (for testing or Redis-backed stores).
 * @returns The initialized DLQ store.
 */
export function initializeJobs(customDlqStore?: DlqStore): DlqStore {
  // Stop any existing sampling loop
  if (stopSampling !== null) {
    stopSampling();
    stopSampling = null;
  }

  // Initialize DLQ store
  dlqStore = customDlqStore ?? new InMemoryDlqStore();

  // Start DLQ metrics sampling
  const intervalMs = loadDlqMetricsInterval();
  stopSampling = startDlqMetricsSampling(dlqStore, intervalMs);

  console.log(
    `[api/jobs] DLQ metrics sampling started (interval: ${intervalMs} ms).`,
  );

  return dlqStore;
}

/**
 * Stop all background jobs and clean up resources.
 *
 * Intended for graceful shutdown or testing.
 */
export function shutdownJobs(): void {
  if (stopSampling !== null) {
    stopSampling();
    stopSampling = null;
  }

  dlqStore = null;

  console.log('[api/jobs] Background jobs stopped.');
}

/**
 * Get the current DLQ store instance.
 *
 * @returns The DLQ store, or `null` if {@link initializeJobs} has not been called.
 */
export function getDlqStore(): DlqStore | null {
  return dlqStore;
}

// ---------------------------------------------------------------------------
// REST API Routing Interface Endpoints
// ---------------------------------------------------------------------------

/**
 * POST /jobs/dlq/:id/replay
 * Replays an individual dead letter queue message back through the delivery stack.
 */
router.post(
  '/jobs/dlq/:id/replay',
  isAdminAuth,
  param('id').isString().notEmpty().withMessage('Invalid DLQ record ID'),
  body('reason').isString().isLength({ min: 5 }).withMessage('Audit trail reason must be at least 5 characters long'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      if (!dlqStore) {
        res.status(503).json({ error: 'DLQ store is not initialized' });
        return;
      }

      const { id } = req.params;
      const { reason } = req.body;
      
      const dlqItem = await dlqStore.getEntryById(id);
      if (!dlqItem) {
        res.status(404).json({ error: 'DLQ item not found' });
        return;
      }

      // Check the event idempotency layer cache before delivery
      const isDuplicate = await IdempotencyLayer.isEventProcessed(dlqItem.eventId);
      if (isDuplicate) {
        incrementDlqReplay('idempotent_noop');
        res.status(200).json({ status: 'ignored', reason: 'Idempotent no-op: Event already delivered' });
        return;
      }

      // Redact sensitive payload properties before delivery logic processing
      const safePayload = redactPayload(dlqItem.payload);

      const deliverySuccess = await WebhookDeliveryService.deliverRaw(dlqItem.targetUrl, dlqItem.eventId, safePayload);

      if (deliverySuccess) {
        await dlqStore.removeEntry(id);
        await IdempotencyLayer.markEventProcessed(dlqItem.eventId);
        incrementDlqReplay('success');
        res.status(200).json({ status: 'success', message: 'DLQ record replayed and processed', auditReason: reason });
      } else {
        await dlqStore.incrementReplayAttempts(id);
        incrementDlqReplay('failed');
        res.status(500).json({ status: 'failed', error: 'Delivery transmission failed during retry execution' });
      }
    } catch (error) {
      incrementDlqReplay('error');
      next(error);
    }
  }
);

/**
 * POST /jobs/dlq/replay
 * Performs batch replay over an arbitrary array of target active DLQ item IDs.
 */
router.post(
  '/jobs/dlq/replay',
  isAdminAuth,
  body('ids').isArray({ min: 1 }).withMessage('An array of valid IDs is required'),
  body('reason').isString().isLength({ min: 5 }).withMessage('Audit trail reason must be at least 5 characters long'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      if (!dlqStore) {
        res.status(503).json({ error: 'DLQ store is not initialized' });
        return;
      }

      const { ids, reason }: { ids: string[]; reason: string } = req.body;
      const summary = { successCount: 0, noOpCount: 0, failureCount: 0 };

      for (const id of ids) {
        const dlqItem = await dlqStore.getEntryById(id);
        if (!dlqItem) {
          summary.failureCount++;
          continue;
        }

        const isDuplicate = await IdempotencyLayer.isEventProcessed(dlqItem.eventId);
        if (isDuplicate) {
          incrementDlqReplay('idempotent_noop');
          summary.noOpCount++;
          continue;
        }

        const safePayload = redactPayload(dlqItem.payload);
        const deliverySuccess = await WebhookDeliveryService.deliverRaw(dlqItem.targetUrl, dlqItem.eventId, safePayload);

        if (deliverySuccess) {
          await dlqStore.removeEntry(id);
          await IdempotencyLayer.markEventProcessed(dlqItem.eventId);
          incrementDlqReplay('success');
          summary.successCount++;
        } else {
          await dlqStore.incrementReplayAttempts(id);
          incrementDlqReplay('failed');
          summary.failureCount++;
        }
      }

      res.status(200).json({ status: 'batch_completed', auditReason: reason, details: summary });
    } catch (error) {
      next(error);
    }
  }
);

export { router as jobsRouter };