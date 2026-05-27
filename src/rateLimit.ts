/**
 * @module rateLimit
 *
 * Per-provider token-bucket rate limiter for outbound webhook deliveries.
 *
 * ## Algorithm
 * Each provider gets its own token bucket.  Tokens refill continuously at
 * `refillRatePerSec` tokens/second up to `capacity`.  When a caller requests
 * a token and the bucket is empty the call is queued and resolved as soon as
 * enough tokens have refilled — deliveries are **paced/queued, never dropped**.
 *
 * ## State
 * Buckets are held in-process (a plain `Map`).  In a blue/green or
 * multi-replica deployment each process maintains its own independent bucket
 * state.  This is intentional: the implementation does not require Redis or
 * any shared store.  See `docs/request-limits-implementation.md` for the
 * trade-off discussion and upgrade path.
 *
 * ## Configuration (environment variables)
 * | Variable                        | Default | Description                              |
 * |---------------------------------|---------|------------------------------------------|
 * | `WEBHOOK_BUCKET_CAPACITY`       | `10`    | Max tokens per provider bucket           |
 * | `WEBHOOK_REFILL_RATE_PER_SEC`   | `2`     | Tokens added per second per provider     |
 *
 * Both values are validated at construction time; the process will throw a
 * descriptive error on invalid configuration rather than silently misbehaving.
 *
 * ## Security
 * Provider secrets are **never** passed to or stored by this module.
 * Only opaque provider IDs appear in log output.
 */

import { recordThrottled } from './webhookMetrics';

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/** Validated, parsed rate-limiter configuration. */
export interface RateLimiterConfig {
  /** Maximum number of tokens a single provider bucket can hold. */
  capacity: number;
  /** Number of tokens added to each bucket per second. */
  refillRatePerSec: number;
}

/**
 * Parse and validate rate-limiter configuration from environment variables.
 *
 * @throws {Error} If any value is missing, non-numeric, non-positive, or
 *   `capacity` is zero (which would make every delivery block forever).
 */
export function loadRateLimiterConfig(): RateLimiterConfig {
  const rawCapacity = process.env.WEBHOOK_BUCKET_CAPACITY ?? '10';
  const rawRefill = process.env.WEBHOOK_REFILL_RATE_PER_SEC ?? '2';

  const capacity = Number(rawCapacity);
  const refillRatePerSec = Number(rawRefill);

  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(
      `[rateLimit] Invalid WEBHOOK_BUCKET_CAPACITY="${rawCapacity}". ` +
        'Must be a finite positive number greater than zero.',
    );
  }

  if (!Number.isFinite(refillRatePerSec) || refillRatePerSec <= 0) {
    throw new Error(
      `[rateLimit] Invalid WEBHOOK_REFILL_RATE_PER_SEC="${rawRefill}". ` +
        'Must be a finite positive number greater than zero.',
    );
  }

  return { capacity, refillRatePerSec };
}

// ---------------------------------------------------------------------------
// Internal bucket state
// ---------------------------------------------------------------------------

/** Runtime state for a single provider's token bucket. */
interface BucketState {
  /** Current token count (may be fractional between refill ticks). */
  tokens: number;
  /** Timestamp (ms) of the last refill calculation. */
  lastRefillMs: number;
  /** Pending waiters in FIFO order. Each resolves when a token is available. */
  queue: Array<() => void>;
}

// ---------------------------------------------------------------------------
// TokenBucketLimiter
// ---------------------------------------------------------------------------

/**
 * Per-provider token-bucket rate limiter.
 *
 * Instantiate once at application startup (or use the module-level singleton
 * {@link defaultLimiter}) and share the instance across all delivery workers.
 *
 * @example
 * ```ts
 * const limiter = new TokenBucketLimiter();
 * await limiter.acquireToken('provider-acme');
 * // safe to send the webhook now
 * ```
 */
export class TokenBucketLimiter {
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private readonly buckets: Map<string, BucketState> = new Map();

  /**
   * @param config - Parsed configuration.  Defaults to
   *   {@link loadRateLimiterConfig} (reads env vars) when omitted.
   */
  constructor(config?: RateLimiterConfig) {
    const resolved = config ?? loadRateLimiterConfig();
    this.capacity = resolved.capacity;
    this.refillRatePerSec = resolved.refillRatePerSec;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Acquire one token for the given provider.
   *
   * Resolves immediately when a token is available.  If the bucket is empty
   * the returned promise is queued and resolves as soon as the next refill
   * produces a token — the delivery is **paced, not dropped**.
   *
   * @param providerId - Opaque provider identifier.  Must NOT contain secrets.
   * @returns A promise that resolves when the caller may proceed with delivery.
   */
  public async acquireToken(providerId: string): Promise<void> {
    this.refillBucket(providerId);
    const bucket = this.getBucket(providerId);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    // Bucket is empty — queue the caller and record the throttle event.
    recordThrottled(providerId);
    console.log(
      `[rateLimit] Provider "${redactId(providerId)}" throttled — queuing delivery.`,
    );

    return new Promise<void>((resolve) => {
      bucket.queue.push(resolve);
      this.scheduleRefill(providerId);
    });
  }

  /**
   * Return the current token count for a provider without consuming a token.
   * Useful for observability and testing.
   *
   * @param providerId - Opaque provider identifier.
   */
  public getTokenCount(providerId: string): number {
    this.refillBucket(providerId);
    return this.getBucket(providerId).tokens;
  }

  /**
   * Return the number of queued (waiting) deliveries for a provider.
   *
   * @param providerId - Opaque provider identifier.
   */
  public getQueueDepth(providerId: string): number {
    return this.getBucket(providerId).queue.length;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Retrieve or lazily create the bucket state for a provider.
   */
  private getBucket(providerId: string): BucketState {
    if (!this.buckets.has(providerId)) {
      this.buckets.set(providerId, {
        tokens: this.capacity,
        lastRefillMs: Date.now(),
        queue: [],
      });
    }
    // Non-null assertion is safe: we just set it above if absent.
    return this.buckets.get(providerId)!;
  }

  /**
   * Apply elapsed-time token refill to the named bucket using the continuous
   * token-bucket formula:
   *
   *   newTokens = min(capacity, currentTokens + elapsed_sec * refillRate)
   */
  private refillBucket(providerId: string): void {
    const bucket = this.getBucket(providerId);
    const nowMs = Date.now();
    const elapsedSec = (nowMs - bucket.lastRefillMs) / 1_000;
    const added = elapsedSec * this.refillRatePerSec;

    bucket.tokens = Math.min(this.capacity, bucket.tokens + added);
    bucket.lastRefillMs = nowMs;
  }

  /**
   * Schedule a `setTimeout` to drain the queue for a provider once enough
   * time has elapsed to produce the next token.
   *
   * Only one timer is scheduled per provider at a time; the drain loop
   * re-schedules itself while the queue is non-empty.
   */
  private scheduleRefill(providerId: string): void {
    const bucket = this.getBucket(providerId);
    // Time (ms) until the next whole token is available.
    const msUntilToken = Math.ceil((1 / this.refillRatePerSec) * 1_000);

    setTimeout(() => {
      this.refillBucket(providerId);
      this.drainQueue(providerId);
    }, msUntilToken);
  }

  /**
   * Resolve as many queued waiters as the current token count allows,
   * then re-schedule if the queue is still non-empty.
   */
  private drainQueue(providerId: string): void {
    const bucket = this.getBucket(providerId);

    while (bucket.queue.length > 0 && bucket.tokens >= 1) {
      bucket.tokens -= 1;
      const resolve = bucket.queue.shift()!;
      resolve();
    }

    if (bucket.queue.length > 0) {
      this.scheduleRefill(providerId);
    }
  }
}

// ---------------------------------------------------------------------------
// Security helper
// ---------------------------------------------------------------------------

/**
 * Redact a provider ID for safe log output.
 *
 * Shows only the first 4 characters followed by `****` to aid debugging
 * without leaking full identifiers that might encode sensitive routing info.
 *
 * @param id - Raw provider identifier.
 * @returns Redacted string safe for log output.
 */
export function redactId(id: string): string {
  if (id.length <= 4) {
    return '****';
  }
  return `${id.slice(0, 4)}****`;
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/**
 * Shared default limiter instance, initialised once at module load time.
 * Configuration is read from environment variables (see module docs).
 *
 * Import and use this in `WebhookDeliveryService` and anywhere else that
 * needs rate-limited webhook delivery.
 */
export const defaultLimiter: TokenBucketLimiter = new TokenBucketLimiter();
