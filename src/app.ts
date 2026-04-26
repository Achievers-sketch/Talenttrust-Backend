/**
 * @module app
 * @description Express application factory.
 *
 * Separates app configuration from server bootstrap so the app can be
 * imported in tests without binding to a port.
 *
 * @security
 *  - express.json() body parser is scoped to this app instance only.
 *  - All routes return JSON; no HTML rendering surface.
 *  - CORS and Helmet security headers are applied via applySecurityMiddleware.
 */

import express from 'express';
import { healthRouter } from './routes/health';
import contractsModuleRouter from './routes/contracts.routes';
import reputationRouter from './routes/reputation.routes';
import dependencyScanRouter from './routes/dependency-scan.routes';
import { adminRouter } from './routes/admin.routes';
import { requestIdMiddleware } from './middleware/requestId';
import { notFoundHandler, errorHandler } from './middleware/errorHandlers';

interface AppFactoryOptions {
  includeTerminalHandlers?: boolean;
}

export function attachTerminalHandlers(app: express.Application): void {
  // ── 404 handler ──────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // ── Global error handler ─────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  });
}

/**
 * Creates and configures the Express application.
 *
 * @returns Configured Express app instance (not yet listening).
 */
export function createApp(options: AppFactoryOptions = {}): express.Application {
  const app = express();
  const { includeTerminalHandlers = true } = options;

  // ── Security Middleware ───────────────────────────────────────────────────
  applySecurityMiddleware(app);

  const metricsService = new MetricsService(
    process.env['SERVICE_NAME'] ?? 'talenttrust-backend',
  );

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(metricsService.trackHttpRequest.bind(metricsService));

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use('/api/v1/contracts', contractsModuleRouter);
  app.use('/api/v1/reputation', reputationRouter);
  app.use('/api/v1/dependency-scan', dependencyScanRouter);
  app.use('/api/v1/admin', adminRouter);

  if (includeTerminalHandlers) {
    attachTerminalHandlers(app);
  }

  return app;
}

/** Shutdown handler for graceful termination. */
export function shutdownRateLimitStore(): void {
  rateLimitStore.destroy();
  console.log('[rateLimit] Store shutdown complete');
}
