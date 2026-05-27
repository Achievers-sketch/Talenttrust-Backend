/**
 * @module webhookDelivery
 *
 * Outbound webhook delivery service with per-provider token-bucket rate
 * limiting, HMAC-SHA256 payload signing, and idempotency enforcement.
 *
 * ## Security
 * - Provider signing secrets are read exclusively from environment variables
 *   (`WEBHOOK_SECRET_<PROVIDER_ID_UPPER>`).  They are **never** logged,
 *   stored in memory beyond the signing operation, or included in any
 *   error message.
 * - The `X-Webhook-Signature` header uses the format
 *   `sha256=<hex-digest>` (compatible with GitHub-style webhook verification).
 *
 * ## Idempotency
 * Each delivery attempt carries a caller-supplied `deliveryId`.  The service
 * tracks delivered IDs in an in-process `Set`; duplicate calls with the same
 * ID are silently skipped.  In a multi-process deployment the caller should
 * use a distributed lock or deduplicate upstream.
 *
 * ## Rate Limiting
 * Deliveries are paced through {@link TokenBucketLimiter}.  A slow provider
 * only blocks its own bucket — other providers are unaffected.
 */

import { createHmac } from 'crypto';
import { TokenBucketLimiter, defaultLimiter, redactId } from './rateLimit';
import { recordDelivered } from './webhookMetrics';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payload passed to {@link WebhookDeliveryService.deliver}. */
export interface DeliveryRequest {
  /** Opaque provider identifier — used for rate-limit bucketing and secret lookup. */
  providerId: string;
  /** Globally unique delivery identifier used for idempotency. */
  deliveryId: string;
  /** Destination URL for the webhook POST. */
  targetUrl: string;
  /** Arbitrary JSON-serialisable payload body. */
  payload: unknown;
}

/** Result returned by {@link WebhookDeliveryService.deliver}. */
export interface DeliveryResult {
  /** `true` if the webhook was sent; `false` if it was a duplicate (skipped). */
  sent: boolean;
  /** HTTP status code from the target, or `undefined` for duplicates. */
  statusCode?: number;
}

// ---------------------------------------------------------------------------
// WebhookDeliveryService
// ---------------------------------------------------------------------------

/**
 * Manages outbound webhook delivery with rate limiting, signing, and
 * idempotency.
 *
 * @example
 * ```ts
 * const svc = new WebhookDeliveryService();
 * await svc.deliver({
 *   providerId: 'acme',
 *   deliveryId: 'evt-001',
 *   targetUrl: 'https://hooks.acme.com/inbound',
 *   payload: { event: 'contract.signed', contractId: '123' },
 * });
 * ```
 */
export class WebhookDeliveryService {
  private readonly limiter: TokenBucketLimiter;
  private readonly deliveredIds: Set<string> = new Set();

  /**
   * @param limiter - Token-bucket limiter to use.  Defaults to the shared
   *   {@link defaultLimiter} singleton so all service instances share the
   *   same per-provider buckets within a process.
   */
  constructor(limiter: TokenBucketLimiter = defaultLimiter) {
    this.limiter = limiter;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Deliver a webhook to the target URL.
   *
   * The call will wait (be paced) until the provider's token bucket has
   * capacity before sending.  Duplicate `deliveryId` values are silently
   * skipped to guarantee at-most-once delivery within a process lifetime.
   *
   * @param request - Delivery parameters.
   * @returns Result indicating whether the webhook was sent.
   */
  public async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const { providerId, deliveryId, targetUrl, payload } = request;

    // --- Idempotency check ---------------------------------------------------
    if (this.deliveredIds.has(deliveryId)) {
      console.log(
        `[webhookDelivery] Duplicate deliveryId="${deliveryId}" for provider ` +
          `"${redactId(providerId)}" — skipping.`,
      );
      return { sent: false };
    }

    // --- Rate limiting -------------------------------------------------------
    await this.limiter.acquireToken(providerId);

    // --- Payload signing -----------------------------------------------------
    const body = JSON.stringify(payload);
    const signature = this.signPayload(providerId, body);

    // --- HTTP delivery -------------------------------------------------------
    const statusCode = await this.postWebhook(targetUrl, body, signature, providerId);

    // --- Post-delivery bookkeeping ------------------------------------------
    this.deliveredIds.add(deliveryId);
    recordDelivered(providerId);

    console.log(
      `[webhookDelivery] Delivered deliveryId="${deliveryId}" to provider ` +
        `"${redactId(providerId)}" — HTTP ${statusCode}.`,
    );

    return { sent: true, statusCode };
  }

  /**
   * Check whether a delivery ID has already been processed.
   *
   * @param deliveryId - The delivery ID to check.
   */
  public isDelivered(deliveryId: string): boolean {
    return this.deliveredIds.has(deliveryId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Compute an HMAC-SHA256 signature for the given body using the provider's
   * secret.  The secret is read from the environment variable
   * `WEBHOOK_SECRET_<PROVIDER_ID_UPPER>` (e.g. `WEBHOOK_SECRET_ACME`).
   *
   * SECURITY: The secret value is never stored, logged, or included in any
   * thrown error.  If the env var is absent an error is thrown with only the
   * variable *name* (not value) in the message.
   *
   * @param providerId - Provider identifier used to derive the env-var name.
   * @param body - Serialised request body to sign.
   * @returns Signature string in the format `sha256=<hex>`.
   */
  private signPayload(providerId: string, body: string): string {
    const envKey = `WEBHOOK_SECRET_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const secret = process.env[envKey];

    if (!secret) {
      throw new Error(
        `[webhookDelivery] Missing signing secret for provider "${redactId(providerId)}". ` +
          `Expected environment variable: ${envKey}`,
      );
    }

    const hmac = createHmac('sha256', secret);
    hmac.update(body);
    return `sha256=${hmac.digest('hex')}`;
  }

  /**
   * Perform the HTTP POST to the webhook target.
   *
   * Uses the built-in `fetch` API (Node ≥ 18).  Network errors are re-thrown
   * with the provider ID redacted.
   *
   * @param url - Destination URL.
   * @param body - Serialised JSON body.
   * @param signature - HMAC signature header value.
   * @param providerId - Used only for redacted error logging.
   * @returns HTTP status code from the target server.
   */
  private async postWebhook(
    url: string,
    body: string,
    signature: string,
    providerId: string,
  ): Promise<number> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body,
      });
      return response.status;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[webhookDelivery] Network error delivering to provider ` +
          `"${redactId(providerId)}": ${message}`,
      );
    }
  }
}
