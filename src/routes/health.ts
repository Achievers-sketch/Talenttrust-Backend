/**
 * @module routes/health
 * @description Health-check route.
 *
 * Used by load balancers and CI smoke tests to verify the service is alive.
 *
 * @route GET /health
 * @returns {{ status: string, service: string }} 200 JSON payload
 */

import { Router, Request, Response } from 'express';
import { registry } from '../docs/openapi-registry';

export const healthRouter = Router();

registry.registerPath({
  method: 'get',
  path: '/health',
  summary: 'Health check',
  responses: {
    200: {
      description: 'Service is healthy',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'healthy' },
              timestamp: { type: 'string', example: new Date().toISOString() },
              version: { type: 'string', example: '0.1.0' }
            }
          }
        }
      }
    }
  }
});

healthRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  });
});

healthRouter.post('/', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  });
});
