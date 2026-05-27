/**
 * @module events/types
 *
 * Type definitions for event ingestion and idempotency.
 */

/**
 * Incoming event payload from external providers.
 */
export interface IncomingEvent {
  /** Opaque provider identifier. Must NOT contain secrets. */
  providerId: string;
  /** Event type (e.g., "contract.signed", "payment.completed"). */
  eventType: string;
  /** Globally unique event identifier from the provider. */
  eventId: string;
  /** Event timestamp (ms since epoch). */
  timestamp: number;
  /** Arbitrary JSON-serializable event payload. */
  payload: unknown;
  /** Optional HMAC signature for verification. */
  signature?: string;
}

/**
 * Response returned after processing an event.
 */
export interface EventResponse {
  /** HTTP-like status code (200 = success, 409 = duplicate, etc.). */
  status: number;
  /** Human-readable message. */
  message: string;
  /** Optional response data. */
  data?: unknown;
}

/**
 * Idempotency store entry.
 */
export interface IdempotencyEntry {
  /** Computed idempotency key (HMAC-SHA256 hash). */
  idempotencyKey: string;
  /** Provider ID (sanitized for storage). */
  providerId: string;
  /** Event type. */
  eventType: string;
  /** Event ID from provider. */
  eventId: string;
  /** Serialized response body (JSON string). */
  responseBody: string;
  /** Timestamp (ms) when the entry was created. */
  createdAt: number;
  /** Timestamp (ms) when the entry expires. */
  expiresAt: number;
}

/**
 * Configuration for idempotency behavior.
 */
export interface IdempotencyConfig {
  /** TTL for idempotency entries in milliseconds (default: 24 hours). */
  ttlMs: number;
  /** Grace period for TTL checks in milliseconds (default: 60 seconds). */
  gracePeriodMs: number;
  /** Maximum retry attempts for SQLITE_BUSY errors (default: 3). */
  maxRetries: number;
  /** Initial retry delay in milliseconds (default: 10ms). */
  retryDelayMs: number;
  /** Timestamp window for idempotency key computation in milliseconds (default: 5 minutes). */
  timestampWindowMs: number;
}
