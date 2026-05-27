# Per-Provider Token-Bucket Rate Limiter

## Overview

Outbound webhook deliveries are rate-limited on a **per-provider** basis using a token-bucket algorithm. Each provider gets its own independent bucket, so a slow or throttled partner cannot starve deliveries to other providers.

Deliveries that exceed a provider's capacity are **queued and paced** — they are never dropped.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_BUCKET_CAPACITY` | `10` | Maximum tokens a single provider bucket can hold (burst ceiling). |
| `WEBHOOK_REFILL_RATE_PER_SEC` | `2` | Tokens added per second per provider bucket. |
| `WEBHOOK_SECRET_<PROVIDER_ID_UPPER>` | *(required)* | HMAC-SHA256 signing secret for each provider. Example: provider ID `acme` → `WEBHOOK_SECRET_ACME`. |

Both numeric values are validated at process startup. The process will throw a descriptive error and refuse to start if either value is zero, negative, non-numeric, or `Infinity`.

### Example `.env`

```
WEBHOOK_BUCKET_CAPACITY=10
WEBHOOK_REFILL_RATE_PER_SEC=2
WEBHOOK_SECRET_ACME=<secret from secrets manager>
WEBHOOK_SECRET_PARTNERX=<secret from secrets manager>
```

---

## Algorithm

```
tokens = min(capacity, tokens + elapsed_seconds × refillRatePerSec)
```

- On each `acquireToken(providerId)` call the bucket is refilled based on elapsed wall-clock time.
- If `tokens >= 1` the token is consumed immediately and the call resolves.
- If `tokens < 1` the caller is added to a FIFO queue. A `setTimeout` fires when the next token is due and drains as many queued callers as the refilled token count allows. The timer re-schedules itself until the queue is empty.

---

## Shared State — Per-Process Behaviour

**Bucket state is held in-process (a plain `Map`).** Each Node.js process maintains its own independent buckets.

### Implications for blue/green and multi-replica deployments

| Scenario | Behaviour |
|---|---|
| Single process | Full rate limiting as configured. |
| Blue/green (one active at a time) | Effective — only one process handles traffic at a time. |
| Multiple replicas behind a load balancer | Each replica enforces its own limit independently. Effective per-replica rate is `capacity / N` where `N` is the number of replicas. |

### Upgrade path to shared state

If strict cross-replica rate limiting is required, replace the `Map<string, BucketState>` in `TokenBucketLimiter` with a Redis-backed store (e.g. using the `INCR` + `EXPIRE` pattern or a Lua script for atomic token consumption). The public `acquireToken` / `getTokenCount` interface is unchanged — only the storage layer needs to swap.

---

## Idempotency

`WebhookDeliveryService` tracks delivered IDs in an in-process `Set`. Duplicate `deliveryId` values within the same process lifetime are silently skipped (return `{ sent: false }`).

For cross-process or cross-restart idempotency, the caller should use a distributed lock or deduplicate upstream before calling `deliver()`.

---

## Payload Signing

Every outbound webhook is signed with HMAC-SHA256:

```
X-Webhook-Signature: sha256=<64-char hex digest>
```

The signing secret is read from `WEBHOOK_SECRET_<PROVIDER_ID_UPPER>` at delivery time and is never stored, logged, or included in error messages.

---

## Metrics

`webhookMetrics.ts` exposes two counters per provider:

- `throttledByProvider` — incremented each time a delivery is queued (token not immediately available).
- `deliveredByProvider` — incremented on each successful HTTP delivery.

Call `getMetrics()` to retrieve a point-in-time snapshot. These are in-process counters; export to Prometheus, CloudWatch, or a push-gateway for cross-process aggregation.

---

## Security Notes

1. **No secrets in source.** All signing secrets live in environment variables or a secrets manager. `.env` is in `.gitignore`.
2. **Secret redaction in logs.** Provider IDs are truncated to 4 characters + `****` in all log output (see `redactId()`). Secret values are never passed to the rate limiter or metrics modules.
3. **Error messages.** When a signing secret is missing, the error message contains only the environment variable *name* (e.g. `WEBHOOK_SECRET_ACME`), never the value.
4. **Input validation.** `loadRateLimiterConfig()` rejects zero, negative, non-numeric, and `Infinity` values at boot, preventing silent misconfiguration.
5. **Signature verification.** The `X-Webhook-Signature` header uses `sha256=<hex>` format. Receiving partners should verify this header before processing the payload.

---

## File Map

| File | Purpose |
|---|---|
| `src/rateLimit.ts` | `TokenBucketLimiter` class, `loadRateLimiterConfig`, `redactId`, `defaultLimiter` singleton |
| `src/webhookDelivery.ts` | `WebhookDeliveryService` — rate limiting, signing, idempotency |
| `src/webhookMetrics.ts` | In-process counters for throttled/delivered events |
| `src/rateLimit.integration.test.ts` | Integration tests covering all acceptance criteria |
