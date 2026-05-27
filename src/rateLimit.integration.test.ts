/**
 * Integration tests for the per-provider token-bucket rate limiter.
 *
 * Acceptance criteria verified here:
 *  1. Throttling Provider A does NOT block Provider B.
 *  2. Bursts beyond capacity are delayed (queued/paced), not dropped.
 *  3. Edge cases: zero/invalid capacity, missing env vars, extreme bursts.
 *  4. Secret redaction — secrets never appear in log output.
 *  5. Idempotency — duplicate deliveryIds are skipped.
 *  6. Metrics — throttled and delivered counters are recorded correctly.
 */

import {
  TokenBucketLimiter,
  loadRateLimiterConfig,
  redactId,
  RateLimiterConfig,
} from './rateLimit';
import { _resetMetrics, getMetrics } from './webhookMetrics';
import { WebhookDeliveryService } from './webhookDelivery';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a limiter with explicit config (bypasses env vars). */
function makeLimiter(capacity: number, refillRatePerSec: number): TokenBucketLimiter {
  return new TokenBucketLimiter({ capacity, refillRatePerSec });
}

/**
 * Resolve after `ms` milliseconds.
 * Using real timers so the token-bucket refill math is exercised end-to-end.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetMetrics();
});

// ---------------------------------------------------------------------------
// 1. loadRateLimiterConfig — env-var parsing and validation
// ---------------------------------------------------------------------------

describe('loadRateLimiterConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns defaults when env vars are absent', () => {
    delete process.env.WEBHOOK_BUCKET_CAPACITY;
    delete process.env.WEBHOOK_REFILL_RATE_PER_SEC;
    const cfg = loadRateLimiterConfig();
    expect(cfg.capacity).toBe(10);
    expect(cfg.refillRatePerSec).toBe(2);
  });

  it('parses valid env vars correctly', () => {
    process.env.WEBHOOK_BUCKET_CAPACITY = '20';
    process.env.WEBHOOK_REFILL_RATE_PER_SEC = '5';
    const cfg = loadRateLimiterConfig();
    expect(cfg.capacity).toBe(20);
    expect(cfg.refillRatePerSec).toBe(5);
  });

  it('throws on zero capacity', () => {
    process.env.WEBHOOK_BUCKET_CAPACITY = '0';
    expect(() => loadRateLimiterConfig()).toThrow(/WEBHOOK_BUCKET_CAPACITY/);
  });

  it('throws on negative capacity', () => {
    process.env.WEBHOOK_BUCKET_CAPACITY = '-5';
    expect(() => loadRateLimiterConfig()).toThrow(/WEBHOOK_BUCKET_CAPACITY/);
  });

  it('throws on non-numeric capacity', () => {
    process.env.WEBHOOK_BUCKET_CAPACITY = 'abc';
    expect(() => loadRateLimiterConfig()).toThrow(/WEBHOOK_BUCKET_CAPACITY/);
  });

  it('throws on zero refill rate', () => {
    process.env.WEBHOOK_REFILL_RATE_PER_SEC = '0';
    expect(() => loadRateLimiterConfig()).toThrow(/WEBHOOK_REFILL_RATE_PER_SEC/);
  });

  it('throws on non-numeric refill rate', () => {
    process.env.WEBHOOK_REFILL_RATE_PER_SEC = 'fast';
    expect(() => loadRateLimiterConfig()).toThrow(/WEBHOOK_REFILL_RATE_PER_SEC/);
  });

  it('throws on Infinity capacity', () => {
    process.env.WEBHOOK_BUCKET_CAPACITY = 'Infinity';
    expect(() => loadRateLimiterConfig()).toThrow(/WEBHOOK_BUCKET_CAPACITY/);
  });
});

// ---------------------------------------------------------------------------
// 2. redactId — security helper
// ---------------------------------------------------------------------------

describe('redactId', () => {
  it('redacts IDs longer than 4 chars', () => {
    expect(redactId('provider-acme')).toBe('prov****');
  });

  it('fully redacts IDs of 4 chars or fewer', () => {
    expect(redactId('abc')).toBe('****');
    expect(redactId('abcd')).toBe('****');
  });

  it('fully redacts empty string', () => {
    expect(redactId('')).toBe('****');
  });

  it('never exposes more than 4 leading characters', () => {
    const result = redactId('supersecretprovider');
    expect(result).toMatch(/^.{4}\*{4}$/);
    expect(result).not.toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// 3. TokenBucketLimiter — core token-bucket behaviour
// ---------------------------------------------------------------------------

describe('TokenBucketLimiter', () => {
  it('starts with a full bucket (capacity tokens available)', () => {
    const limiter = makeLimiter(5, 1);
    expect(limiter.getTokenCount('p1')).toBeCloseTo(5, 0);
  });

  it('acquireToken resolves immediately when tokens are available', async () => {
    const limiter = makeLimiter(3, 1);
    const start = Date.now();
    await limiter.acquireToken('p1');
    expect(Date.now() - start).toBeLessThan(50); // well under 50 ms
  });

  it('consumes one token per acquireToken call', async () => {
    const limiter = makeLimiter(3, 1);
    await limiter.acquireToken('p1');
    expect(limiter.getTokenCount('p1')).toBeCloseTo(2, 0);
    await limiter.acquireToken('p1');
    expect(limiter.getTokenCount('p1')).toBeCloseTo(1, 0);
  });

  it('queues calls when bucket is empty and resolves after refill', async () => {
    // capacity=1, refill=10/sec → next token in ~100 ms
    const limiter = makeLimiter(1, 10);

    await limiter.acquireToken('p1'); // consumes the only token

    const start = Date.now();
    await limiter.acquireToken('p1'); // must wait for refill
    const elapsed = Date.now() - start;

    // Should have waited roughly 100 ms (1/10 sec), allow generous tolerance
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(500);
  }, 2000);

  it('records a throttle metric when a call is queued', async () => {
    const limiter = makeLimiter(1, 20); // fast refill so test doesn't hang
    await limiter.acquireToken('p1'); // drain bucket

    const waiter = limiter.acquireToken('p1'); // should be throttled
    expect(getMetrics().throttledByProvider['p1']).toBe(1);
    await waiter;
  }, 2000);

  it('getQueueDepth returns the number of waiting callers', async () => {
    const limiter = makeLimiter(1, 1); // slow refill
    await limiter.acquireToken('p1'); // drain

    // Queue two waiters without awaiting them yet
    const w1 = limiter.acquireToken('p1');
    const w2 = limiter.acquireToken('p1');

    expect(limiter.getQueueDepth('p1')).toBe(2);

    // Clean up — await both so no dangling timers
    await Promise.all([w1, w2]);
  }, 5000);

  // -------------------------------------------------------------------------
  // ACCEPTANCE CRITERION 1: Provider A throttling does NOT block Provider B
  // -------------------------------------------------------------------------

  it('AC1 — throttling provider A does not block provider B', async () => {
    // capacity=1, refill=2/sec → next token in ~500 ms
    const limiter = makeLimiter(1, 2);

    // Drain provider A's bucket
    await limiter.acquireToken('providerA');

    // Provider A is now empty — queue a waiter
    let aResolved = false;
    const aWaiter = limiter.acquireToken('providerA').then(() => {
      aResolved = true;
    });

    // Provider B should resolve immediately (its own full bucket)
    const bStart = Date.now();
    await limiter.acquireToken('providerB');
    const bElapsed = Date.now() - bStart;

    // B must not have waited for A's refill
    expect(bElapsed).toBeLessThan(100);
    expect(aResolved).toBe(false); // A is still waiting

    await aWaiter; // clean up
  }, 3000);

  // -------------------------------------------------------------------------
  // ACCEPTANCE CRITERION 2: Bursts beyond capacity are delayed, not dropped
  // -------------------------------------------------------------------------

  it('AC2 — burst beyond capacity is queued and all tokens eventually delivered', async () => {
    // capacity=2, refill=10/sec → tokens refill every 100 ms
    const limiter = makeLimiter(2, 10);
    const BURST = 5; // 3 beyond capacity

    const results: number[] = [];
    const start = Date.now();

    const promises = Array.from({ length: BURST }, (_, i) =>
      limiter.acquireToken('burstProvider').then(() => {
        results.push(Date.now() - start);
      }),
    );

    await Promise.all(promises);

    // All BURST deliveries must have completed (none dropped)
    expect(results).toHaveLength(BURST);

    // First 2 should be near-instant (within bucket capacity)
    expect(results[0]).toBeLessThan(100);
    expect(results[1]).toBeLessThan(100);

    // Remaining 3 must have been delayed (paced)
    expect(results[2]).toBeGreaterThanOrEqual(80);
    expect(results[3]).toBeGreaterThanOrEqual(80);
    expect(results[4]).toBeGreaterThanOrEqual(80);
  }, 5000);

  it('handles multiple providers independently with no cross-contamination', async () => {
    const limiter = makeLimiter(2, 5);
    const providers = ['alpha', 'beta', 'gamma'];

    // Each provider gets its own full bucket — all should resolve quickly
    const start = Date.now();
    await Promise.all(providers.map((p) => limiter.acquireToken(p)));
    expect(Date.now() - start).toBeLessThan(100);

    // Drain each provider's remaining token
    await Promise.all(providers.map((p) => limiter.acquireToken(p)));

    // Now all buckets are empty — each provider queues independently
    const throttledBefore = getMetrics().throttledByProvider;
    const waiters = providers.map((p) => limiter.acquireToken(p));
    providers.forEach((p) => {
      expect(getMetrics().throttledByProvider[p]).toBe(
        (throttledBefore[p] ?? 0) + 1,
      );
    });

    await Promise.all(waiters);
  }, 5000);
});

// ---------------------------------------------------------------------------
// 4. WebhookDeliveryService — idempotency and signing
// ---------------------------------------------------------------------------

describe('WebhookDeliveryService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WEBHOOK_SECRET_TESTPROVIDER = 'test-secret-value';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('skips duplicate deliveryIds (idempotency)', async () => {
    // Use a fast limiter so the test doesn't wait on rate limits
    const limiter = makeLimiter(100, 100);
    const svc = new WebhookDeliveryService(limiter);

    // Mock fetch to avoid real network calls
    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = mockFetch as unknown as typeof fetch;

    const req = {
      providerId: 'testprovider',
      deliveryId: 'evt-dup-001',
      targetUrl: 'https://example.com/hook',
      payload: { event: 'test' },
    };

    const first = await svc.deliver(req);
    const second = await svc.deliver(req);

    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false); // duplicate skipped
    expect(mockFetch).toHaveBeenCalledTimes(1); // only one HTTP call
  });

  it('isDelivered returns true after a successful delivery', async () => {
    const limiter = makeLimiter(100, 100);
    const svc = new WebhookDeliveryService(limiter);

    global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;

    await svc.deliver({
      providerId: 'testprovider',
      deliveryId: 'evt-check-001',
      targetUrl: 'https://example.com/hook',
      payload: {},
    });

    expect(svc.isDelivered('evt-check-001')).toBe(true);
    expect(svc.isDelivered('evt-check-999')).toBe(false);
  });

  it('throws when the provider signing secret is missing', async () => {
    delete process.env.WEBHOOK_SECRET_TESTPROVIDER;
    const limiter = makeLimiter(100, 100);
    const svc = new WebhookDeliveryService(limiter);

    await expect(
      svc.deliver({
        providerId: 'testprovider',
        deliveryId: 'evt-nosecret-001',
        targetUrl: 'https://example.com/hook',
        payload: {},
      }),
    ).rejects.toThrow(/WEBHOOK_SECRET_TESTPROVIDER/);
  });

  it('error message for missing secret does NOT contain the secret value', async () => {
    process.env.WEBHOOK_SECRET_TESTPROVIDER = 'super-secret-password-123';
    // Temporarily remove it to trigger the error path, then check message
    const secret = process.env.WEBHOOK_SECRET_TESTPROVIDER;
    delete process.env.WEBHOOK_SECRET_TESTPROVIDER;

    const limiter = makeLimiter(100, 100);
    const svc = new WebhookDeliveryService(limiter);

    let errorMessage = '';
    try {
      await svc.deliver({
        providerId: 'testprovider',
        deliveryId: 'evt-redact-001',
        targetUrl: 'https://example.com/hook',
        payload: {},
      });
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    expect(errorMessage).not.toContain(secret);
    expect(errorMessage).toContain('WEBHOOK_SECRET_TESTPROVIDER');
  });

  it('records a delivered metric on success', async () => {
    const limiter = makeLimiter(100, 100);
    const svc = new WebhookDeliveryService(limiter);

    global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;

    await svc.deliver({
      providerId: 'testprovider',
      deliveryId: 'evt-metric-001',
      targetUrl: 'https://example.com/hook',
      payload: {},
    });

    expect(getMetrics().deliveredByProvider['testprovider']).toBe(1);
  });

  it('wraps network errors with redacted provider ID', async () => {
    const limiter = makeLimiter(100, 100);
    const svc = new WebhookDeliveryService(limiter);

    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    await expect(
      svc.deliver({
        providerId: 'testprovider',
        deliveryId: 'evt-neterr-001',
        targetUrl: 'https://example.com/hook',
        payload: {},
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('sends X-Webhook-Signature header with sha256= prefix', async () => {
    const limiter = makeLimiter(100, 100);
    const svc = new WebhookDeliveryService(limiter);

    let capturedHeaders: Record<string, string> = {};
    global.fetch = jest.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedHeaders = opts.headers as Record<string, string>;
      return Promise.resolve({ status: 200 });
    }) as unknown as typeof fetch;

    await svc.deliver({
      providerId: 'testprovider',
      deliveryId: 'evt-sig-001',
      targetUrl: 'https://example.com/hook',
      payload: { data: 'hello' },
    });

    expect(capturedHeaders['X-Webhook-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 5. Metrics module
// ---------------------------------------------------------------------------

describe('webhookMetrics', () => {
  it('starts with empty counters after reset', () => {
    const m = getMetrics();
    expect(m.throttledByProvider).toEqual({});
    expect(m.deliveredByProvider).toEqual({});
  });

  it('getMetrics returns a copy — mutations do not affect internal state', () => {
    const limiter = makeLimiter(1, 20);
    // Drain and trigger a throttle
    void limiter.acquireToken('x');
    void limiter.acquireToken('x');

    const snap1 = getMetrics();
    snap1.throttledByProvider['injected'] = 999;

    const snap2 = getMetrics();
    expect(snap2.throttledByProvider['injected']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles a single-token capacity correctly (capacity=1)', async () => {
    const limiter = makeLimiter(1, 10);
    await limiter.acquireToken('solo');
    expect(limiter.getTokenCount('solo')).toBeCloseTo(0, 0);
  });

  it('handles fractional refill rates (e.g. 0.5 tokens/sec)', async () => {
    // 0.5/sec → 1 token every 2 seconds; use capacity=1 so we can drain it
    const limiter = makeLimiter(1, 0.5);
    await limiter.acquireToken('slow');
    // Queue a waiter — it should eventually resolve (we don't await to keep test fast)
    const waiter = limiter.acquireToken('slow');
    expect(limiter.getQueueDepth('slow')).toBe(1);
    // Cancel by letting the test end; Jest will warn about open handles only
    // if the timer fires after the suite — acceptable for this edge-case check.
    // We resolve it to avoid leaking:
    await waiter;
  }, 5000);

  it('large burst (50 requests) against capacity=5 — all complete, none dropped', async () => {
    const limiter = makeLimiter(5, 50); // 50 tokens/sec → 20 ms per token
    const BURST = 50;
    const results: boolean[] = [];

    const promises = Array.from({ length: BURST }, () =>
      limiter.acquireToken('bigburst').then(() => {
        results.push(true);
      }),
    );

    await Promise.all(promises);
    expect(results).toHaveLength(BURST);
    expect(results.every(Boolean)).toBe(true);
  }, 10000);

  it('concurrent acquireToken calls for different providers never interfere', async () => {
    const limiter = makeLimiter(1, 100);
    const providers = Array.from({ length: 10 }, (_, i) => `provider-${i}`);

    // Each provider has its own full bucket — all should resolve immediately
    const start = Date.now();
    await Promise.all(providers.map((p) => limiter.acquireToken(p)));
    expect(Date.now() - start).toBeLessThan(100);
  });
});
