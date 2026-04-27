/**
 * @module index
 * @description Server entry and exported Express app.
 *
 * Import `{ app }` in tests. The HTTP server and BullMQ workers start only
 * when this file is the program entry and Jest is not running.
 */

import type { Request, Response, NextFunction } from 'express';
import { createApp, attachTerminalHandlers, shutdownRateLimitStore } from './app';
import { JobType, JobPayload, QueueManager, AddJobOptions } from './queue';
import { authMiddleware, AuthenticatedRequest } from './middleware/auth';
import { auditService } from './audit/service';
import { validateEnvironment } from './config/environment';
import { createRateLimiter } from './middleware/rateLimiter';
import { rateLimitConfig } from './config/rateLimit';

// Validate environment at startup
validateEnvironment();

const queueManager = QueueManager.getInstance();

const app = createApp({ includeTerminalHandlers: false });

const DLQ_DEFAULT_LIMIT = 50;
const DLQ_MAX_LIMIT = 100;

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin role required' });
    return;
  }

  next();
}


const strictLimiter = createRateLimiter(rateLimitConfig.strict);

app.post('/api/v1/jobs', strictLimiter, async (req: Request, res: Response) => {
  try {
    const { type, payload, options } = req.body as {
      type?: string;
      payload?: unknown;
      options?: AddJobOptions;
    };

    if (!type || payload === undefined) {
      return res.status(400).json({ error: 'Job type and payload are required' });
    }

    if (!Object.values(JobType).includes(type as JobType)) {
      return res.status(400).json({ error: `Invalid job type: ${type}` });
    }

    const { jobId, deduplicated } = await queueManager.addJob(
      type as JobType,
      payload as JobPayload,
      options,
    );
    const httpStatus = deduplicated ? 200 : 201;
    return res.status(httpStatus).json({ jobId, type, status: 'queued', deduplicated });
  } catch (error) {
    console.error('Failed to enqueue job', error);
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

app.get('/api/v1/jobs/dlq', authMiddleware, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const typeQuery = req.query['type'];
    const limitQuery = req.query['limit'];
    const offsetQuery = req.query['offset'];

    const jobType = typeof typeQuery === 'string' ? typeQuery : undefined;
    if (jobType && !Object.values(JobType).includes(jobType as JobType)) {
      return res.status(400).json({ error: `Invalid job type: ${jobType}` });
    }

    const limit = Math.min(
      Math.max(parsePositiveInt(limitQuery, DLQ_DEFAULT_LIMIT), 1),
      DLQ_MAX_LIMIT,
    );
    const offset = Math.max(parsePositiveInt(offsetQuery, 0), 0);

    const entries = await queueManager.getFailedJobs({
      jobType: jobType as JobType | undefined,
      limit,
      offset,
    });

    auditService.log({
      action: 'ADMIN_ACTION',
      severity: 'INFO',
      actor: req.user!.id,
      resource: 'jobs-dlq',
      resourceId: jobType ?? 'all',
      metadata: {
        operation: 'view',
        count: entries.length,
        limit,
        offset,
      },
      ipAddress: req.ip,
      correlationId: req.headers['x-correlation-id'] as string | undefined,
    });

    return res.status(200).json({ entries, limit, offset, count: entries.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: `Failed to get DLQ entries: ${message}` });
  }
});

app.post('/api/v1/jobs/dlq/reprocess', authMiddleware, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { type, jobId, reason } = req.body as {
      type?: string;
      jobId?: string;
      reason?: string;
    };

    if (!type || !jobId || !reason || typeof reason !== 'string' || reason.trim().length < 5) {
      return res.status(400).json({
        error: 'type, jobId, and reason (min 5 chars) are required',
      });
    }

    if (!Object.values(JobType).includes(type as JobType)) {
      return res.status(400).json({ error: `Invalid job type: ${type}` });
    }

    const replayResult = await queueManager.reprocessFailedJob(type as JobType, jobId);

    auditService.log({
      action: 'ADMIN_ACTION',
      severity: 'WARNING',
      actor: req.user!.id,
      resource: 'jobs-dlq',
      resourceId: jobId,
      metadata: {
        operation: 'reprocess',
        reason: reason.trim(),
        jobType: type,
        replayJobId: replayResult.replayJobId,
        deduplicated: replayResult.deduplicated,
      },
      ipAddress: req.ip,
      correlationId: req.headers['x-correlation-id'] as string | undefined,
    });

    const statusCode = replayResult.deduplicated ? 200 : 202;
    return res.status(statusCode).json(replayResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.startsWith('Failed job not found')) {
      return res.status(404).json({ error: message });
    }

    if (message.includes('not in failed state')) {
      return res.status(409).json({ error: message });
    }

    return res.status(500).json({ error: `Failed to reprocess DLQ job: ${message}` });
  }
});

app.get('/api/v1/jobs/:type/:jobId', async (req: Request, res: Response) => {
  try {
    const { type, jobId } = req.params;

    if (!Object.values(JobType).includes(type as JobType)) {
      return res.status(400).json({ error: `Invalid job type: ${type}` });
    }

    const status = await queueManager.getJobStatus(type as JobType, jobId);

    if (!status) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.json(status);
  } catch (error) {
    console.error('Failed to get job status', error);
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

attachTerminalHandlers(app);

export { app };
export default app;

const isMainModule =
  typeof require !== 'undefined' &&
  (require as NodeRequire).main === module;
const isJest = Boolean(process.env.JEST_WORKER_ID);
const shouldBootstrapServer = (isMainModule && !isJest) || process.env.FORCE_START_INDEX === '1';

async function initializeQueues(): Promise<void> {
  if (isJest) {
    return;
  }
  for (const jobType of Object.values(JobType)) {
    await queueManager.initializeQueue(jobType);
  }
}

async function gracefulShutdown(): Promise<void> {
  if (!isJest) {
    await queueManager.shutdown();
    shutdownRateLimitStore();
  }
  process.exit(0);
}

async function startServer(): Promise<void> {
  const PORT = Number(process.env.PORT) || 3001;
  if (!isJest) {
    await initializeQueues();
  }

  if (!isJest) {
    app.listen(PORT, () => {
      console.log(`TalentTrust API listening on http://localhost:${PORT}`);
    });
  }
}

if (isJest) {
  // Tests import `app` only; do not start listeners or Redis-backed queues here.
} else {
  process.on('SIGTERM', () => {
    void gracefulShutdown();
  });
  process.on('SIGINT', () => {
    void gracefulShutdown();
  });
}

if (shouldBootstrapServer) {
  void startServer();
}
