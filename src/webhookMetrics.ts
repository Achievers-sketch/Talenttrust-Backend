/**
 * @module webhookMetrics
 *
 * Lightweight in-process metrics collector for webhook delivery events.
 * In a production multi-process deployment these counters are per-process;
 * export them to a Prometheus push-gateway or similar aggregator if
 * cross-process totals are required.
 *
 * SECURITY: This module never receives or stores provider secrets.
 * Only opaque provider IDs (strings) are recorded.
 */

/** Shape of the metrics snapshot returned by {@link getMetrics}. */
export interface WebhookMetricsSnapshot {
  /** Total throttled-delivery events recorded since process start, keyed by provider ID. */
  throttledByProvider: Record<string, number>;
  /** Total successful delivery events recorded since process start, keyed by provider ID. */
  deliveredByProvider: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Internal mutable state (module-level singletons, reset-able for tests)
// ---------------------------------------------------------------------------

let throttledByProvider: Record<string, number> = {};
let deliveredByProvider: Record<string, number> = {};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record that a webhook delivery was throttled (token not immediately
 * available) for the given provider.
 *
 * @param providerId - Opaque provider identifier. Must NOT contain secrets.
 */
export function recordThrottled(providerId: string): void {
  throttledByProvider[providerId] = (throttledByProvider[providerId] ?? 0) + 1;
}

/**
 * Record that a webhook was successfully delivered for the given provider.
 *
 * @param providerId - Opaque provider identifier. Must NOT contain secrets.
 */
export function recordDelivered(providerId: string): void {
  deliveredByProvider[providerId] = (deliveredByProvider[providerId] ?? 0) + 1;
}

/**
 * Return a point-in-time snapshot of all recorded metrics.
 * The returned object is a deep copy; mutations do not affect internal state.
 */
export function getMetrics(): WebhookMetricsSnapshot {
  return {
    throttledByProvider: { ...throttledByProvider },
    deliveredByProvider: { ...deliveredByProvider },
  };
}

/**
 * Reset all counters to zero.
 * Intended for use in tests only — do not call in production code.
 *
 * @internal
 */
export function _resetMetrics(): void {
  throttledByProvider = {};
  deliveredByProvider = {};
}
