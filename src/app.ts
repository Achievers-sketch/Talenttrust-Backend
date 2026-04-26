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
import { requestIdMiddleware } from './middleware/requestId';
import { notFoundHandler, errorHandler } from './middleware/errorHandlers';
import { MetricsService } from './observability/metrics-service';
import { RateLimitStore } from './lib/rateLimitStore';

// Module-level store instance for shutdown handler
let rateLimitStore: RateLimitStore;

/**
 * Creates and configures the Express application.
 *
 * @returns Configured Express app instance (not yet listening).
 */
export function createApp(): express.Application {
  const app = express();

  // ── Security Middleware ───────────────────────────────────────────────────
  applySecurityMiddleware(app);

  const metricsService = new MetricsService(
    process.env['SERVICE_NAME'] ?? 'talenttrust-backend',
  );

  rateLimitStore = new RateLimitStore({ sweepIntervalMs: 60_000 });

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(metricsService.trackHttpRequest.bind(metricsService));

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use('/api/v1/contracts', contractsModuleRouter);
  app.use('/api/v1/reputation', reputationRouter);
  app.use('/api/v1/dependency-scan', dependencyScanRouter);

  // ── 404 handler ──────────────────────────────────────────────────────────
  app.use(notFoundHandler);

  // ── Global error handler ─────────────────────────────────────────────────
  app.use(errorHandler);

  return app;
}

/** Shutdown handler for graceful termination. */
export function shutdownRateLimitStore(): void {
  if (rateLimitStore) {
    rateLimitStore.destroy();
    console.log('[rateLimit] Store shutdown complete');
  }
}
