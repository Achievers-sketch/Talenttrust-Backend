import { Router, Request, Response, NextFunction } from 'express';
import { eventIngestionService } from '../events/registry';

const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { events, contractType } = req.body as {
      events?: unknown;
      contractType?: unknown;
    };

    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'events array is required' });
    }

    if (typeof contractType !== 'string' || contractType.trim().length === 0) {
      return res.status(400).json({ error: 'contractType is required' });
    }

    const correlationId = typeof req.headers['x-correlation-id'] === 'string'
      ? req.headers['x-correlation-id']
      : undefined;

    const results = await eventIngestionService.processBatch(events as any[], contractType, correlationId);
    const summary = {
      processed: results.length,
      accepted: results.filter((item) => item.status === 'accepted').length,
      duplicates: results.filter((item) => item.status === 'duplicate').length,
      rejected: results.filter((item) => item.status === 'rejected').length,
    };

    return res.status(200).json({ processed: results.length, results, summary });
  } catch (error) {
    next(error);
  }
});

router.post('/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event, contractType } = req.body as {
      event?: unknown;
      contractType?: unknown;
    };

    if (event === undefined) {
      return res.status(400).json({ error: 'event is required' });
    }

    if (typeof contractType !== 'string' || contractType.trim().length === 0) {
      return res.status(400).json({ error: 'contractType is required' });
    }

    const validation = eventIngestionService.validateEvent(event, contractType);
    return res.status(200).json(validation);
  } catch (error) {
    next(error);
  }
});

export default router;
