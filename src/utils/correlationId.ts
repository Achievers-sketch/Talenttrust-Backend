/**
 * @module utils/correlationId
 * @description Utility functions for accessing and propagating correlation IDs
 * across the request lifecycle, event processing, and webhook deliveries.
 *
 * Correlation IDs enable distributed tracing by providing a unique identifier
 * that can be used to correlate all related operations across service boundaries.
 *
 * @security
 * - Correlation IDs are validated before use (alphanumeric + hyphen/underscore, max 128 chars)
 * - IDs are never logged or propagated without validation
 * - HTTP headers are only set after validation to prevent injection attacks
 */

import { Response } from 'express';

/**
 * Extract correlation ID from Express response locals.
 *
 * The correlation ID is set by the requestIdMiddleware during request processing
 * and made available in `res.locals.correlationId`.
 *
 * @param res - Express Response object
 * @returns The correlation ID if present, undefined otherwise
 *
 * @example
 * ```typescript
 * const correlationId = getCorrelationId(res);
 * if (correlationId) {
 *   // Propagate to downstream services
 *   await eventAuditService.processEvent(event, contractType, correlationId);
 * }
 * ```
 */
export function getCorrelationId(res: Response): string | undefined {
  return res.locals['correlationId'] as string | undefined;
}

/**
 * Extract request ID from Express response locals.
 *
 * The request ID is set by the requestIdMiddleware during request processing
 * and made available in `res.locals.requestId`.
 *
 * @param res - Express Response object
 * @returns The request ID (always present)
 *
 * @example
 * ```typescript
 * const requestId = getRequestId(res);
 * console.log('Request ID:', requestId);
 * ```
 */
export function getRequestId(res: Response): string {
  const requestId = res.locals['requestId'] as string | undefined;
  if (!requestId) {
    throw new Error('Request ID not found in response locals. Ensure requestIdMiddleware is registered before this handler.');
  }
  return requestId;
}

/**
 * Extract the request-scoped logger from Express response locals.
 *
 * The logger is set by the requestIdMiddleware with both requestId and
 * correlationId already bound to its context.
 *
 * @param res - Express Response object
 * @returns The request-scoped logger
 *
 * @example
 * ```typescript
 * const log = getRequestLogger(res);
 * log.info('Processing event', { eventId: event.id });
 * // Output: { ..., requestId: '...', correlationId: '...', message: 'Processing event', eventId: '...' }
 * ```
 */
export function getRequestLogger(res: Response) {
  const log = res.locals['log'];
  if (!log) {
    throw new Error('Request logger not found in response locals. Ensure requestIdMiddleware is registered before this handler.');
  }
  return log;
}

/**
 * Extract both request ID and correlation ID from Express response locals.
 *
 * Convenience function that returns both IDs in a single call.
 *
 * @param res - Express Response object
 * @returns Object containing requestId (always present) and correlationId (optional)
 *
 * @example
 * ```typescript
 * const { requestId, correlationId } = getRequestContext(res);
 * // Use both IDs for tracing
 * ```
 */
export function getRequestContext(
  res: Response
): { requestId: string; correlationId?: string } {
  const requestId = getRequestId(res);
  const correlationId = getCorrelationId(res);
  return { requestId, correlationId };
}

/**
 * Build webhook headers including correlation ID for distributed tracing.
 *
 * Creates a headers object suitable for propagating to external webhook deliveries.
 * Includes the correlation ID if present, enabling end-to-end tracing.
 *
 * @param correlationId - Optional correlation ID to propagate
 * @returns Headers object with correlation ID (if provided)
 *
 * @example
 * ```typescript
 * const headers = buildWebhookHeaders(correlationId);
 * // Use headers when making outbound webhook requests
 * await axios.post(webhookUrl, payload, { headers });
 * ```
 */
export function buildWebhookHeaders(
  correlationId?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (correlationId) {
    headers['X-Correlation-Id'] = correlationId;
  }

  return headers;
}
