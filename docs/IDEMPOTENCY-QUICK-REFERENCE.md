# Idempotency Quick Reference

## Core Guarantees

✅ **Exactly-once execution** — Only 1 concurrent request executes the side effect  
✅ **Deterministic deduplication** — N-1 requests get cached response  
✅ **No lock errors** — `SQLITE_BUSY` retried transparently  
✅ **TTL safety** — Grace period handles expiration races  

---

## Environment Variables

```bash
IDEMPOTENCY_DB_PATH=/var/lib/talenttrust/idempotency.db
IDEMPOTENCY_SECRET=<random-secret>
IDEMPOTENCY_TTL_MS=86400000           # 24 hours
IDEMPOTENCY_GRACE_PERIOD_MS=60000     # 60 seconds
IDEMPOTENCY_TIMESTAMP_WINDOW_MS=300000 # 5 minutes
IDEMPOTENCY_MAX_RETRIES=3
IDEMPOTENCY_RETRY_DELAY_MS=10
```

---

## Usage

### Initialize

```typescript
import { IdempotencyStore } from './src/events/idempotencyStore';
import { EventProcessor } from './src/events/idempotency';

const store = new IdempotencyStore('./data/idempotency.db');
const processor = new EventProcessor(store);
```

### Process Event

```typescript
const response = await processor.processEvent(event, async (evt) => {
  // Execute side effect (e.g., write to database, send webhook)
  return { status: 200, message: 'ok' };
});
```

### Purge Expired Entries

```typescript
const purged = store.purgeExpired();
console.log(`Removed ${purged} expired entries`);
```

---

## Concurrency Strategy

| Mechanism | Purpose |
|-----------|---------|
| **WAL Mode** | Better concurrent read performance |
| **BEGIN IMMEDIATE** | Acquire write lock upfront (prevent deadlocks) |
| **INSERT OR IGNORE** | Atomic constraint checking (eliminate TOCTOU) |
| **Retry Logic** | Handle transient `SQLITE_BUSY` errors |
| **Single Connection** | Serialize writes (avoid lock contention) |

---

## Transaction Flow

```
1. Check for existing entry (read-only, no lock)
   ↓ Cache HIT → return cached response
   ↓ Cache MISS
2. BEGIN IMMEDIATE (acquire write lock)
3. INSERT OR IGNORE (atomic)
   ↓ changes = 0 → another request won → fetch their response
   ↓ changes > 0 → we won
4. Execute side effect
5. UPDATE response_body
6. COMMIT
```

---

## Testing

```bash
# Run idempotency tests
npm test -- idempotency.test.ts

# Run with coverage
npm run test:ci -- idempotency.test.ts
```

**Key Tests:**
- ✅ 10 concurrent identical events → exactly 1 side effect
- ✅ 50 concurrent identical events → exactly 1 side effect
- ✅ TTL expiration race → handled correctly
- ✅ Purge interleaving → no lock errors
- ✅ No `SQLITE_BUSY` errors leak

---

## Troubleshooting

### High `SQLITE_BUSY` Error Rate

**Solution:**
1. Increase `IDEMPOTENCY_MAX_RETRIES` (3 → 5)
2. Increase `IDEMPOTENCY_RETRY_DELAY_MS` (10ms → 20ms)
3. Migrate to PostgreSQL for higher concurrency

### Duplicate Side Effects

**Solution:**
1. Verify schema: `sqlite3 idempotency.db ".schema"`
2. Check for `PRIMARY KEY` on `idempotency_key`
3. Verify `BEGIN IMMEDIATE` in `idempotencyStore.ts`

### Purge Job Blocking Requests

**Solution:**
1. Run purge more frequently (every 30 min)
2. Batch deletes: `DELETE ... LIMIT 1000`
3. Run during low-traffic periods

---

## Security Checklist

- ✅ No secrets in database
- ✅ Idempotency keys are HMAC-SHA256 hashes
- ✅ Provider IDs sanitized in logs (first 4 chars + `****`)
- ✅ Idempotency keys redacted in logs (first 8 chars + `****`)
- ✅ Event payloads never logged
- ✅ Database file access restricted (`chmod 600`)

---

## Performance

| Metric | Value |
|--------|-------|
| **Throughput** | ~1,000 events/sec (single process) |
| **Cache HIT Latency** | ~1ms |
| **Cache MISS Latency** | ~10-50ms |
| **Worst Case Latency** | ~85ms (3 retries) |

---

## File Locations

```
src/events/
├── types.ts              # Type definitions
├── idempotencyStore.ts   # SQLite store + concurrency handling
├── idempotency.ts        # Event processor
└── idempotency.test.ts   # Integration tests

docs/
├── EVENT_INGESTION_IDEMPOTENCY.md  # Full documentation
└── IDEMPOTENCY-QUICK-REFERENCE.md  # This file
```

---

## Purge Job (Cron)

```bash
# Every hour
0 * * * * /usr/bin/node /app/scripts/purge-idempotency.js
```

**Script:**
```typescript
import { IdempotencyStore } from './src/events/idempotencyStore';

const store = new IdempotencyStore(process.env.IDEMPOTENCY_DB_PATH);
const purged = store.purgeExpired();
console.log(`[purge] Removed ${purged} expired entries`);
store.close();
```

---

## Migration to PostgreSQL

**When to Migrate:**
- High concurrent write load (>1,000 events/sec)
- Multi-process deployment with shared state

**Schema:**
```sql
CREATE TABLE idempotency_store (
  idempotency_key TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  response_body TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX idx_expires_at ON idempotency_store(expires_at);
```

**Transaction:**
```sql
BEGIN;
INSERT INTO idempotency_store (...) VALUES (...)
ON CONFLICT (idempotency_key) DO NOTHING;
COMMIT;
```
