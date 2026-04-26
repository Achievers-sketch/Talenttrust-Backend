/**
 * @module routes/admin
 * @description Admin-only routes for operational visibility.
 *
 * @route GET /api/v1/admin/queue-health
 * @route GET /api/v1/admin/webhook-dlq
 * @route GET /api/v1/admin/webhook-dlq/:id
 * @route POST /api/v1/admin/webhook-dlq/:id/replay
 * @security Requires admin role via JWT authentication
 */

import { Router, Response } from 'express';
import { QueueManager, getWebhookDLQStorage } from '../queue';
import { requireAuth, requireRole } from '../middleware/authorization';

export const adminRouter = Router();

adminRouter.get(
  '/queue-health',
  requireAuth,
  requireRole('admin'),
  async (_req, res: Response) => {
    const queueManager = QueueManager.getInstance();
    const queues = await queueManager.getHealth();
    const failures = await queueManager.getRecentFailures(10);

    res.status(200).json({
      status: 'success',
      data: {
        queues,
        failures,
        timestamp: Date.now(),
      },
    });
  }
);

const DLQ_DEFAULT_LIMIT = 50;
const DLQ_MAX_LIMIT = 100;

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

adminRouter.get(
  '/webhook-dlq',
  requireAuth,
  requireRole('admin'),
  async (req, res: Response) => {
    const limitQuery = req.query['limit'];
    const offsetQuery = req.query['offset'];
    const sinceQuery = req.query['since'];
    const untilQuery = req.query['until'];

    const limit = Math.min(
      Math.max(parsePositiveInt(limitQuery, DLQ_DEFAULT_LIMIT), 1),
      DLQ_MAX_LIMIT
    );
    const offset = Math.max(parsePositiveInt(offsetQuery, 0), 0);
    const since = typeof sinceQuery === 'string' ? sinceQuery : undefined;
    const until = typeof untilQuery === 'string' ? untilQuery : undefined;

    const dlqStorage = getWebhookDLQStorage();
    const entries = dlqStorage.listEntries({ limit, offset, since, until });
    const stats = await dlqStorage.getStats();

    const sanitizedEntries = entries.map(entry => {
      const { webhookSecret, ...rest } = entry;
      return rest;
    });

    res.status(200).json({
      entries: sanitizedEntries,
      stats,
      pagination: { limit, offset, count: entries.length },
    });
  }
);

adminRouter.get(
  '/webhook-dlq/:id',
  requireAuth,
  requireRole('admin'),
  async (req, res: Response) => {
    const { id } = req.params;

    const dlqStorage = getWebhookDLQStorage();
    const entry = dlqStorage.getEntry(id);

    if (!entry) {
      res.status(404).json({ error: 'DLQ entry not found' });
      return;
    }

    const { webhookSecret, ...sanitized } = entry;
    res.status(200).json(sanitized);
  }
);

adminRouter.post(
  '/webhook-dlq/:id/replay',
  requireAuth,
  requireRole('admin'),
  async (req, res: Response) => {
    const { id } = req.params;
    const { reason } = req.body as { reason?: string };

    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      res.status(400).json({ error: 'reason (min 5 chars) is required' });
      return;
    }

    const dlqStorage = getWebhookDLQStorage();
    const entry = dlqStorage.getEntry(id);

    if (!entry) {
      res.status(404).json({ error: 'DLQ entry not found' });
      return;
    }

    if (entry.replayedAt) {
      res.status(409).json({ error: 'Entry already replayed', replayedAt: entry.replayedAt });
      return;
    }

    const { WebhookService } = await import('../services/webhook.service');
    const service = new WebhookService();
    const result = await service.replayDLQEntry(id);

    if (result.success) {
      res.status(202).json({
        status: 'success',
        entryId: id,
        message: result.message,
      });
    } else {
      res.status(500).json({
        status: 'error',
        entryId: id,
        message: result.message,
      });
    }
  }
);