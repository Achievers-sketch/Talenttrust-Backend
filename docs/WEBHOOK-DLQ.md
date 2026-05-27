# Webhook DLQ (Dead Letter Queue)

This document describes the webhook DLQ persistence implementation and the
graceful-shutdown drain phase that prevents avoidable DLQ entries during
blue/green deployment switches.

---

## Overview

Failed webhook deliveries are persisted to durable SQLite storage for later
inspection and replay.  The drain phase ensures that in-flight deliveries are
given a chance to complete naturally before the process exits; only deliveries
that cannot finish within the grace window are force-flushed to the DLQ.

---

## Components

### Storage (`src/queue/webhook-dlq.ts`)

- SQLite-backed persistent storage
- Deduplication via SHA-256 hash key (`webhookId` + payload)
- Unique constraint prevents duplicate entries
- `webhookSecret` is **never** returned in API responses or stored in plain text

### Retry Policy (`src/queue/webhook-retry-policy.ts`)

- Max 5 retry attempts
- Exponential backoff: 1 s → 2 s → 4 s → 8 s → 16 s
- 10 % jitter to prevent thundering herd
- Max delay cap: 30 s

### Admin Endpoints (`src/routes/admin.routes.ts`)

| Method | Endpoint                              | Description        |
|--------|---------------------------------------|--------------------|
| GET    | /api/v1/admin/webhook-dlq             | List DLQ entries   |
| GET    | /api/v1/admin/webhook-dlq/:id         | Get single entry   |
| POST   | /api/v1/admin/webhook-dlq/:id/replay  | Replay webhook     |

---

## Graceful-Shutdown Drain Phase

### Why it exists

Without a drain phase, a SIGTERM during a blue/green switch can interrupt
in-flight HTTP calls to webhook endpoints mid-flight.  The delivery is then
counted as a failure and written to the DLQ even though the remote server may
have already received the payload — causing spurious DLQ entries and potential
duplicate deliveries on replay.

### Lifecycle

```
SIGTERM received
      │
      ▼
1. HTTP server.close()          ← no new requests accepted from the network
      │
      ▼
2. webhookService.stopAccepting() ← gate closed; no new deliveries start
      │
      ├─ inFlightCount == 0 ──► log webhook_deliveries_drained, continue
      │
      └─ inFlightCount > 0
            │
            ├─ drain() resolves within WEBHOOK_DRAIN_TIMEOUT_MS
            │       └─► log webhook_deliveries_drained, continue
            │
            └─ timeout expires
                    ├─► log webhook_drain_timeout
                    ├─► flushToDLQ()   ← remaining deliveries written to DLQ
                    └─► log webhook_drain_flushed_to_dlq, continue
      │
      ▼
3. BullMQ workers close (force=false)
      │
      ▼
4. Downstream connections close (Redis, Postgres, …)
      │
      ▼
5. process.exit(0)
```

### Blue/green interaction

`deploy:switch-green` updates the router **before** sending SIGTERM to the old
color.  This means the old instance stops receiving new traffic before the drain
phase starts, so most in-flight deliveries will already be complete by the time
the grace timeout begins.  The timeout is therefore a safety net for the rare
case where a delivery is still in-flight at the moment the router switches.

### Implementing `DrainableWebhookService`

Any service passed to `registerShutdownHandlers` via `options.webhookService`
must satisfy the `DrainableWebhookService` interface exported from
`src/shutdown.ts`:

```ts
import { DrainableWebhookService } from './shutdown';

class WebhookDeliveryService implements DrainableWebhookService {
  private _inFlight = 0;
  private _accepting = true;

  get inFlightCount(): number {
    return this._inFlight;
  }

  /** Idempotent gate — call on SIGTERM before waiting. */
  stopAccepting(): void {
    this._accepting = false;
  }

  /** Resolves when all in-flight deliveries have settled. */
  async drain(): Promise<void> {
    // Wait until _inFlight reaches 0, e.g. via a Promise that resolves
    // when the last in-flight counter decrements to zero.
  }

  /**
   * Force-moves every remaining in-flight delivery to the DLQ.
   * Must be idempotent.  Must NOT include raw webhookSecret in the payload.
   */
  async flushToDLQ(): Promise<void> {
    // Cancel pending HTTP calls and write each to WebhookDLQStorage.
  }
}
```

---

## Capacity Management

### Overflow Policy: Oldest-Evict

When the DLQ reaches its maximum capacity (default: 10,000 entries), the system automatically evicts the oldest pending entry to make room for new failures.

**Behavior:**
- Default max capacity: 10,000 entries
- When at capacity, the oldest pending (not-yet-replayed) entry is evicted
- Replayed entries are not evicted (they are kept for historical reference)
- The eviction occurs before the new entry is added

**Rationale:**
- Ensures the DLQ doesn't grow unbounded
- Prioritizes newer failures which may be more actionable
- Replayed entries are preserved for audit and historical tracking

**Configuration:**
```typescript
const storage = new WebhookDLQStorage(':memory:', { 
  maxCapacity: 10000  // configurable
});
```

### Environment

| Variable | Description | Default |
|----------|-------------|---------|
| WEBHOOK_DLQ_PATH | SQLite DB path | `./data/webhook-dlq.db` |

## Poison Message Handling

A poison message is a webhook that consistently fails on every replay attempt, typically due to malformed data or an unrecoverable downstream issue.

### Behavior

- Default max replay attempts: 5
- Each failed replay increments the `replay_attempts` counter
- When `replay_attempts >= maxReplayAttempts`, the message is **permanently dropped**
- The entry is deleted from the database and cannot be recovered

**Rationale:**
- Prevents infinite retry loops
- Prevents DLQ pollution with unrecoverable messages
- Limits resource consumption on repeated failed attempts

**Configuration:**
```typescript
const storage = new WebhookDLQStorage(':memory:', { 
  maxReplayAttempts: 5  // configurable
});
```

### Tracking

The `WebhookDLQEntry` includes a `replayAttempts` field that tracks how many times an entry has been replayed:

```typescript
interface WebhookDLQEntry {
  // ... other fields
  replayAttempts: number;
}
```

## Metrics

DLQ operations are tracked via Prometheus counters in `webhookMetrics.ts`:

| Metric | Labels | Description |
|--------|--------|-------------|
| `webhook_dlq_operations_total` | `operation` | Total DLQ operations |

**Operations tracked:**

| Operation | Description |
|-----------|-------------|
| `enqueue` | Entry added to DLQ |
| `drop_overflow` | Entry evicted due to capacity overflow |
| `drop_poison` | Entry dropped after exceeding max replay attempts |

## Security

- All endpoints require admin JWT role
- `webhookSecret` is never returned in API responses
- Replay requires a reason (min 5 chars) for audit