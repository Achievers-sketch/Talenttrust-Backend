# Event Ingestion Idempotency

## Overview

The event ingestion system guarantees **exactly-once execution** of side effects under high concurrent duplicate submissions. This document describes the concurrency strategy, SQLite locking considerations, TTL windows, and operational guidelines.

---

## Guarantees

1. **Exactly-once execution:** Only one concurrent request executes the side effect for a given idempotency key.
2. **Deterministic deduplication:** N-1 concurrent duplicates receive the same cached response without re-executing the side effect.
3. **No lock errors:** `SQLITE_BUSY` errors are retried transparently with exponential backoff.
4. **TTL safety:** Handles race conditions during TTL expiration and purge operations via grace periods.

---

## Architecture

### Idempotency Key Computation

```typescript
idempotencyKey = HMAC-SHA256(providerId + eventType + eventId + timestampWindow)
```

**Components:**
- **Provider ID:** Opaque provider identifier (not a secret).
- **Event Type:** Event category (e.g., `contract.signed`, `payment.completed`).
- **Event ID:** Globally unique event identifier from the provider.
- **Timestamp Window:** Timestamp rounded to a 5-minute window to handle clock skew.

**Security:** The key is a one-way HMAC-SHA256 hash. Provider secrets are never included.

### Database Schema

```sql
CREATE TABLE idempotency_store (
  idempotency_key TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  response_body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_expires_at ON idempotency_store(expires_at);
```

**Key Design Decisions:**
- **PRIMARY KEY on `idempotency_key`:** Enforces uniqueness at the database level (atomic constraint checking).
- **Index on `expires_at`:** Optimizes purge queries (`DELETE WHERE expires_at <= ?`).

---

## Concurrency Strategy

### SQLite Locking Behavior

SQLite uses **file-level locking** with limited concurrent write support:
- **Shared Lock:** Multiple readers can hold shared locks simultaneously.
- **Reserved Lock:** One writer can hold a reserved lock while readers continue.
- **Exclusive Lock:** Only one exclusive lock can be held; blocks all readers and writers.

**Challenge:** Multiple simultaneous writes can cause `SQLITE_BUSY` errors.

### Solution: WAL Mode + BEGIN IMMEDIATE + Retry Logic

1. **Write-Ahead Logging (WAL) Mode:**
   - Enabled via `PRAGMA journal_mode = WAL`.
   - Allows concurrent reads while a write is in progress.
   - Reduces lock contention compared to rollback journal mode.

2. **BEGIN IMMEDIATE Transactions:**
   - Acquires a **reserved lock** upfront (before any writes).
   - Prevents deadlocks by ensuring the lock is available before starting the transaction.
   - Syntax: `BEGIN IMMEDIATE` (not `BEGIN` or `BEGIN DEFERRED`).

3. **INSERT OR IGNORE:**
   - Leverages SQLite's atomic constraint checking.
   - If a duplicate key exists, the insert is silently ignored (`changes = 0`).
   - Eliminates TOCTOU (Time-Of-Check-Time-Of-Use) race conditions.

4. **Retry Logic with Exponential Backoff:**
   - Catches `SQLITE_BUSY` errors and retries up to 3 times.
   - Backoff delays: 10ms, 25ms, 50ms (configurable).
   - After 3 retries, the error is propagated to the caller.

### Transaction Flow

```typescript
function processEvent(event: IncomingEvent): Promise<EventResponse> {
  const idempotencyKey = computeIdempotencyKey(event);
  
  // Phase 1: Check for existing entry (read-only, no lock)
  const existing = store.get(idempotencyKey);
  if (existing && !isExpired(existing)) {
    return JSON.parse(existing.responseBody); // Cache HIT
  }
  
  // Phase 2: Attempt atomic insert (with retry on SQLITE_BUSY)
  BEGIN IMMEDIATE;
  try {
    INSERT OR IGNORE INTO idempotency_store (...) VALUES (...);
    
    if (changes === 0) {
      // Another concurrent request won the race
      COMMIT;
      const winner = store.get(idempotencyKey);
      return JSON.parse(winner.responseBody); // Deduplicated
    }
    
    // We won the race — execute side effect
    const response = await executeSideEffect(event);
    
    UPDATE idempotency_store SET response_body = ? WHERE idempotency_key = ?;
    COMMIT;
    
    return response;
  } catch (err) {
    ROLLBACK;
    throw err;
  }
}
```

---

## TTL and Expiration

### Configuration

| Environment Variable              | Default  | Description                                    |
|-----------------------------------|----------|------------------------------------------------|
| `IDEMPOTENCY_TTL_MS`              | `86400000` | TTL for idempotency entries (24 hours).       |
| `IDEMPOTENCY_GRACE_PERIOD_MS`     | `60000`    | Grace period for TTL checks (60 seconds).      |
| `IDEMPOTENCY_TIMESTAMP_WINDOW_MS` | `300000`   | Timestamp window for key computation (5 min).  |

### Grace Period

**Problem:** A duplicate event arrives exactly as the original entry's TTL expires.

**Solution:** Add a 60-second grace period to TTL checks:

```sql
SELECT * FROM idempotency_store 
WHERE idempotency_key = ? 
AND expires_at > (NOW - GRACE_PERIOD);
```

This ensures that entries are still considered valid for a short time after expiration, handling clock skew and race conditions.

### Purge Operation

**Problem:** A duplicate event arrives during a purge operation (deletion of expired entries).

**Solution:**
1. The purge job uses `BEGIN EXCLUSIVE` to acquire an exclusive lock.
2. This blocks all reads and writes during the purge.
3. If a duplicate arrives mid-purge, it waits for the lock to be released.
4. After the purge completes, the duplicate is treated as a new event (re-executes side effect).

**Purge Query:**
```sql
BEGIN EXCLUSIVE;
DELETE FROM idempotency_store WHERE expires_at <= NOW;
COMMIT;
```

**Scheduling:** Run the purge job every 1 hour (configurable via cron or background worker).

---

## Error Handling

### SQLITE_BUSY Errors

**Cause:** Multiple concurrent writes attempting to acquire the same lock.

**Handling:**
1. Catch `SQLITE_BUSY` or `database is locked` errors.
2. Retry with exponential backoff (10ms, 25ms, 50ms).
3. After 3 retries, return `503 Service Unavailable` to the caller.

**Configuration:**

| Environment Variable          | Default | Description                                    |
|-------------------------------|---------|------------------------------------------------|
| `IDEMPOTENCY_MAX_RETRIES`     | `3`     | Maximum retry attempts for SQLITE_BUSY errors. |
| `IDEMPOTENCY_RETRY_DELAY_MS`  | `10`    | Initial retry delay in milliseconds.           |

### Side Effect Failures

**Behavior:**
- If the side effect throws an error, the error is propagated to the caller.
- The placeholder entry remains in the database (with `status: 202, message: 'processing'`).
- The entry will expire naturally via TTL.
- Retries will re-execute the side effect (no caching of errors).

---

## Observability

### Metrics

Track the following metrics using Prometheus or similar:

| Metric                          | Type    | Description                                    |
|---------------------------------|---------|------------------------------------------------|
| `idempotency_cache_hits_total`  | Counter | Number of cache hits (deduplicated requests).  |
| `idempotency_cache_misses_total`| Counter | Number of cache misses (new events).           |
| `idempotency_lock_retries_total`| Counter | Number of SQLITE_BUSY retries.                 |
| `idempotency_purge_duration_seconds` | Histogram | Duration of purge operations.             |

### Logging

**Log Format:**
```
[idempotency] Cache HIT for key=abcd1234****, provider=acme****, eventType=contract.signed
[idempotency] Cache MISS for key=abcd1234****, provider=acme****, eventType=contract.signed — executing side effect
[idempotency] Lost race for key=abcd1234****, provider=acme****, eventType=contract.signed
```

**Security:**
- Idempotency keys are redacted (first 8 chars + `****`).
- Provider IDs are sanitized (first 4 chars + `****`).
- Event payloads are never logged.
- Provider secrets are never logged.

---

## Testing

### Deterministic Integration Tests

**Test 1: Concurrent Identical Events**
```typescript
it('processes exactly 1 side effect for N concurrent identical events', async () => {
  const N = 10;
  const event = makeEvent('acme', 'contract.signed', 'evt-001');
  const mock = makeMockSideEffect();
  
  const results = await Promise.all(
    Array.from({ length: N }, () => processor.processEvent(event, mock.fn))
  );
  
  expect(mock.callCount).toBe(1); // Exactly 1 execution
  expect(results.every(r => r.status === 200)).toBe(true); // All get same response
});
```

**Test 2: TTL Expiration Race**
```typescript
it('handles duplicate arriving after TTL expiration', async () => {
  // Insert entry with TTL = 100ms
  await processor.processEvent(event, mock.fn);
  
  // Wait for TTL to expire
  await sleep(150);
  
  // Duplicate after expiration — should execute again
  await processor.processEvent(event, mock.fn);
  
  expect(mock.callCount).toBe(2);
});
```

**Test 3: Purge Interleaving**
```typescript
it('handles duplicate arriving during purge operation', async () => {
  // Insert expired entry
  await processor.processEvent(event, mock.fn);
  await sleep(150);
  
  // Start purge and concurrent duplicate
  await Promise.all([
    store.purgeExpired(),
    processor.processEvent(event, mock.fn)
  ]);
  
  expect(mock.callCount).toBe(2); // Re-executed after purge
});
```

### Coverage

All tests are deterministic (no arbitrary `setTimeout` sleeps). Tests explicitly fail if:
- The `PRIMARY KEY` constraint is removed from the schema.
- The `BEGIN IMMEDIATE` transaction is replaced with `BEGIN DEFERRED`.
- The retry logic is removed.

**Run Tests:**
```bash
npm test -- idempotency.test.ts
npm run test:ci -- idempotency.test.ts
```

---

## Production Deployment

### Database Location

**Development:**
```bash
IDEMPOTENCY_DB_PATH=./data/idempotency.db
```

**Production:**
```bash
IDEMPOTENCY_DB_PATH=/var/lib/talenttrust/idempotency.db
```

**In-Memory (Testing Only):**
```bash
IDEMPOTENCY_DB_PATH=:memory:
```

### Backup and Recovery

**SQLite WAL Mode:**
- The database consists of three files: `idempotency.db`, `idempotency.db-wal`, `idempotency.db-shm`.
- Back up all three files together to ensure consistency.

**Backup Command:**
```bash
sqlite3 /var/lib/talenttrust/idempotency.db ".backup /backup/idempotency-$(date +%Y%m%d).db"
```

**Restore Command:**
```bash
cp /backup/idempotency-20260527.db /var/lib/talenttrust/idempotency.db
```

### Purge Job

**Cron Schedule (Every Hour):**
```cron
0 * * * * /usr/bin/node /app/scripts/purge-idempotency.js
```

**Purge Script:**
```typescript
import { IdempotencyStore } from './src/events/idempotencyStore';

const store = new IdempotencyStore('/var/lib/talenttrust/idempotency.db');
const purged = store.purgeExpired();
console.log(`[purge] Removed ${purged} expired entries`);
store.close();
```

---

## Security Considerations

1. **No secrets in database:** Provider secrets are never stored. Only opaque provider IDs and event metadata.

2. **Idempotency keys are one-way hashes:** HMAC-SHA256 keys cannot be reversed to recover the original event data.

3. **Payload encryption at rest:** If event payloads contain sensitive data, encrypt the `response_body` column before storage:
   ```typescript
   const encrypted = encrypt(JSON.stringify(response), SECRET_KEY);
   store.updateResponse(idempotencyKey, encrypted);
   ```

4. **Access control:** Restrict file-system access to the SQLite database file (`chmod 600`).

5. **Log redaction:** All logs redact idempotency keys (first 8 chars) and provider IDs (first 4 chars).

---

## Troubleshooting

### High SQLITE_BUSY Error Rate

**Symptom:** Logs show frequent `SQLITE_BUSY` retries.

**Possible Causes:**
- High concurrent write load.
- Long-running transactions blocking the lock.

**Solutions:**
1. Increase `IDEMPOTENCY_MAX_RETRIES` (default: 3 → 5).
2. Increase `IDEMPOTENCY_RETRY_DELAY_MS` (default: 10ms → 20ms).
3. Consider migrating to a client-server database (PostgreSQL, MySQL) for higher concurrency.

---

### Duplicate Side Effects Executing

**Symptom:** Side effects execute more than once for the same event.

**Possible Causes:**
- `PRIMARY KEY` constraint missing from schema.
- `BEGIN IMMEDIATE` replaced with `BEGIN DEFERRED`.
- Idempotency key computation is non-deterministic.

**Solutions:**
1. Verify schema: `sqlite3 idempotency.db ".schema idempotency_store"`.
2. Check transaction mode in `idempotencyStore.ts`.
3. Run deterministic tests: `npm test -- idempotency.test.ts`.

---

### Purge Job Blocking Requests

**Symptom:** Requests hang during purge operation.

**Possible Causes:**
- Purge job holds `EXCLUSIVE` lock for too long.
- Large number of expired entries to delete.

**Solutions:**
1. Run purge more frequently (every 30 minutes instead of 1 hour).
2. Batch deletes: `DELETE FROM idempotency_store WHERE expires_at <= ? LIMIT 1000`.
3. Run purge during low-traffic periods (e.g., 3 AM).

---

## File Map

| File | Purpose |
|---|---|
| `src/events/types.ts` | Type definitions for events and idempotency |
| `src/events/idempotencyStore.ts` | SQLite store with concurrency handling |
| `src/events/idempotency.ts` | Event processor with idempotency guarantees |
| `src/events/idempotency.test.ts` | Deterministic integration tests |
| `docs/EVENT_INGESTION_IDEMPOTENCY.md` | This document |

---

## References

- [SQLite WAL Mode](https://www.sqlite.org/wal.html)
- [SQLite Locking](https://www.sqlite.org/lockingv3.html)
- [better-sqlite3 Documentation](https://github.com/WiseLibs/better-sqlite3)
- [Idempotency Patterns](https://stripe.com/docs/api/idempotent_requests)
