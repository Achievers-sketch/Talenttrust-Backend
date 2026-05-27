/**
 * @module redact
 * @description Utilities for redacting secrets and signatures from log output.
 *
 * Never log raw HMAC signatures, signing secrets, or nonces.  Pass any
 * string through `redactSecret` before including it in a log record.
 */

const REDACTED = '[REDACTED]';

/**
 * Replaces a secret value with a fixed redaction marker.
 *
 * @param _value - The sensitive value (unused; accepted so call-sites are explicit).
 * @returns The redaction marker string.
 */
export function redactSecret(_value: unknown): string {
  return REDACTED;
}

/**
 * Redacts all values in an object whose keys match known sensitive patterns.
 *
 * @param obj - Plain object to sanitise.
 * @returns A new object with sensitive values replaced by `[REDACTED]`.
 */
export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE = /secret|signature|token|key|password|authorization|nonce/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k)) {
      out[k] = REDACTED;
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactObject(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
