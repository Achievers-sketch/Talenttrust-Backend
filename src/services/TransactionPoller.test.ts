import { TransactionPoller, IBlockchainProvider } from './TransactionPoller';
import { Transaction, TransactionStatus, transactionsDb } from '../models/Transaction';

/**
 * Minimal blockchain receipt shape used by {@link TransactionPoller}.
 */
interface MockReceipt {
  status: 0 | 1;
  transactionHash: string;
}

/**
 * Creates a Jest mock of {@link IBlockchainProvider} with a stubbed
 * `getTransactionReceipt` implementation.
 */
function createMockProvider(): jest.Mocked<IBlockchainProvider> {
  return {
    getTransactionReceipt: jest.fn(),
  };
}

/**
 * Yields control until all pending microtasks (Promise continuations) have run.
 * Required when using fake timers because `await` chains resolve on microtasks,
 * not on timer ticks.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve);
  });
}

/**
 * Advances fake timers by `ms` milliseconds and drains the microtask queue so
 * polling continuations can execute.
 */
async function advanceTimersAndFlush(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

/**
 * Runs only the next scheduled timer (one backoff interval) and drains microtasks.
 */
async function runNextBackoffTick(): Promise<void> {
  jest.runOnlyPendingTimers();
  await flushMicrotasks();
}

/**
 * Computes the expected backoff delay for a given retry count using the poller formula:
 * `initialDelay * 2^(retryCount - 1)`.
 */
function expectedBackoffDelay(initialDelay: number, retryCount: number): number {
  return initialDelay * Math.pow(2, retryCount - 1);
}

/**
 * Seeds the in-memory transaction store with a pre-existing record.
 */
function seedTransaction(
  hash: string,
  overrides: Partial<Omit<Transaction, 'hash'>> = {},
): Transaction {
  const transaction: Transaction = {
    hash,
    status: TransactionStatus.PENDING,
    retryCount: 0,
    ...overrides,
  };
  transactionsDb.set(hash, transaction);
  return transaction;
}

describe('TransactionPoller', () => {
  let mockProvider: jest.Mocked<IBlockchainProvider>;
  let poller: TransactionPoller;

  /** Small base delay keeps timer-based tests fast while preserving the formula. */
  const initialDelay = 100;
  const maxRetries = 3;

  beforeEach(() => {
    jest.useFakeTimers();
    transactionsDb.clear();
    mockProvider = createMockProvider();
    poller = new TransactionPoller(mockProvider, maxRetries, initialDelay);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('constructor defaults', () => {
    it('uses maxRetries=5 and initialDelay=1000 when omitted', () => {
      const defaultPoller = new TransactionPoller(mockProvider);
      expect((defaultPoller as unknown as { maxRetries: number }).maxRetries).toBe(5);
      expect((defaultPoller as unknown as { initialDelay: number }).initialDelay).toBe(1000);
    });
  });

  describe('transaction registration', () => {
    /**
     * Transition: (missing) → PENDING on first `poll` call.
     */
    it('creates a PENDING transaction when the hash is not yet tracked', async () => {
      const txHash = '0xnew';
      mockProvider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: txHash });

      await poller.poll(txHash);

      const stored = transactionsDb.get(txHash);
      expect(stored).toBeDefined();
      expect(stored?.status).toBe(TransactionStatus.SUCCESS);
      expect(stored?.retryCount).toBe(0);
    });

    /**
     * Transition: preserves existing retryCount when re-polling a known hash.
     */
    it('reuses an existing transaction record instead of resetting state', async () => {
      const txHash = '0xexisting';
      seedTransaction(txHash, { retryCount: 2 });
      mockProvider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: txHash });

      await poller.poll(txHash);

      expect(transactionsDb.get(txHash)?.retryCount).toBe(2);
      expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.SUCCESS);
    });
  });

  describe('receipt-driven status transitions', () => {
    /**
     * Transition: PENDING → SUCCESS when receipt.status === 1.
     */
    it('sets SUCCESS and stores the receipt when the chain reports status 1', async () => {
      const txHash = '0xsuccess';
      const receipt: MockReceipt = { status: 1, transactionHash: txHash };
      mockProvider.getTransactionReceipt.mockResolvedValueOnce(receipt);

      await poller.poll(txHash);

      const stored = transactionsDb.get(txHash);
      expect(stored?.status).toBe(TransactionStatus.SUCCESS);
      expect(stored?.receipt).toEqual(receipt);
      expect(stored?.lastCheckedAt).toBeInstanceOf(Date);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledWith(txHash);
    });

    /**
     * Transition: PENDING → FAILED when receipt.status === 0 (reverted).
     */
    it('sets FAILED and stores the receipt when the chain reports status 0', async () => {
      const txHash = '0xreverted';
      const receipt: MockReceipt = { status: 0, transactionHash: txHash };
      mockProvider.getTransactionReceipt.mockResolvedValueOnce(receipt);

      await poller.poll(txHash);

      const stored = transactionsDb.get(txHash);
      expect(stored?.status).toBe(TransactionStatus.FAILED);
      expect(stored?.receipt).toEqual(receipt);
      expect(stored?.lastCheckedAt).toBeInstanceOf(Date);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    });

    /**
     * Transition: PENDING → SUCCESS after multiple null receipts (not yet mined).
     */
    it('keeps polling through null receipts until a final receipt arrives', async () => {
      const txHash = '0xpending-then-success';
      mockProvider.getTransactionReceipt
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ status: 1, transactionHash: txHash });

      const pollPromise = poller.poll(txHash);

      await flushMicrotasks();
      expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.PENDING);
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      await runNextBackoffTick();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(2);

      await runNextBackoffTick();
      expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.SUCCESS);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(3);

      await pollPromise;
    });
  });

  describe('RPC error resilience', () => {
    /**
     * Transition: PENDING (unchanged) on RPC throw; logs warning and retries after backoff.
     */
    it('logs a warning, increments retryCount, and continues polling after an RPC error', async () => {
      const txHash = '0xrpc-error';
      const rpcError = new Error('RPC unavailable');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      mockProvider.getTransactionReceipt
        .mockRejectedValueOnce(rpcError)
        .mockResolvedValueOnce({ status: 1, transactionHash: txHash });

      const pollPromise = poller.poll(txHash);

      await flushMicrotasks();
      expect(warnSpy).toHaveBeenCalledWith(
        `RPC error while fetching receipt for ${txHash}:`,
        rpcError,
      );
      expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.PENDING);
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      await runNextBackoffTick();
      expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.SUCCESS);

      await pollPromise;
      warnSpy.mockRestore();
    });
  });

  describe('exponential backoff schedule', () => {
    /**
     * Asserts each scheduled delay matches `initialDelay * 2^(retryCount - 1)`.
     */
    it('schedules delays using initialDelay * 2^(retryCount - 1)', async () => {
      const txHash = '0xbackoff-formula';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      await flushMicrotasks();
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      const firstScheduledDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
      expect(firstScheduledDelay).toBe(expectedBackoffDelay(initialDelay, 1));

      await runNextBackoffTick();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(2);

      const secondScheduledDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
      expect(secondScheduledDelay).toBe(expectedBackoffDelay(initialDelay, 2));

      await runNextBackoffTick();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(3);

      const thirdScheduledDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
      expect(thirdScheduledDelay).toBe(expectedBackoffDelay(initialDelay, 3));

      // Stop further polling so the open promise can settle.
      const tx = transactionsDb.get(txHash);
      if (tx) {
        tx.status = TransactionStatus.SUCCESS;
      }
      jest.runAllTimers();
      await pollPromise;

      expect(expectedBackoffDelay(100, 1)).toBe(100);
      expect(expectedBackoffDelay(100, 2)).toBe(200);
      expect(expectedBackoffDelay(100, 3)).toBe(400);
      expect(expectedBackoffDelay(100, 4)).toBe(800);
    });

    /**
     * Verifies polling attempts occur only after each computed backoff interval elapses.
     */
    it('does not invoke the provider again until the backoff interval passes', async () => {
      const txHash = '0xbackoff-timing';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      // Less than the first backoff (100ms) — no second RPC call yet.
      await advanceTimersAndFlush(99);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      // Complete the first backoff window.
      await advanceTimersAndFlush(1);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(2);

      const tx = transactionsDb.get(txHash);
      if (tx) {
        tx.status = TransactionStatus.SUCCESS;
      }
      jest.runAllTimers();
      await pollPromise;
    });
  });

  describe('TIMEOUT transition', () => {
    /**
     * Transition: PENDING → TIMEOUT once retryCount reaches maxRetries without finality.
     */
    it('sets TIMEOUT after maxRetries exhausted with persistently null receipts', async () => {
      const txHash = '0xtimeout';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);

      // Attempt 1: retryCount 0 → 1, delay 100ms
      await flushMicrotasks();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      // Attempt 2: retryCount 1 → 2, delay 200ms
      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(transactionsDb.get(txHash)?.retryCount).toBe(2);

      // Attempt 3: retryCount 2 → 3, delay 400ms
      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 2));
      expect(transactionsDb.get(txHash)?.retryCount).toBe(3);

      // Attempt 4: retryCount >= maxRetries → TIMEOUT (no further RPC call)
      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 3));

      const stored = transactionsDb.get(txHash);
      expect(stored?.status).toBe(TransactionStatus.TIMEOUT);
      expect(stored?.lastCheckedAt).toBeInstanceOf(Date);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(maxRetries);

      await pollPromise;
    });
  });

  describe('early termination when status is no longer PENDING', () => {
    /**
     * Transition: external SUCCESS while polling → poller stops without further RPC calls.
     */
    it('returns early when status is changed externally to a non-PENDING value', async () => {
      const txHash = '0xexternal-success';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      const tx = transactionsDb.get(txHash);
      expect(tx).toBeDefined();
      tx!.status = TransactionStatus.SUCCESS;

      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      await pollPromise;
    });

    /**
     * Transition: external FAILED while polling → poller stops without further RPC calls.
     */
    it('returns early when status is changed externally to FAILED', async () => {
      const txHash = '0xexternal-failed';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();

      const tx = transactionsDb.get(txHash);
      expect(tx).toBeDefined();
      tx!.status = TransactionStatus.FAILED;

      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      await pollPromise;
    });

    /**
     * Transition: transaction removed from store → poller stops without further RPC calls.
     */
    it('returns early when the transaction record is deleted externally', async () => {
      const txHash = '0xdeleted';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      transactionsDb.delete(txHash);

      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      await pollPromise;
    });

    /**
     * Transition: already non-PENDING at poll start → no RPC calls made.
     */
    it('does not poll when the transaction is already in a terminal state', async () => {
      const txHash = '0xalready-done';
      seedTransaction(txHash, { status: TransactionStatus.SUCCESS });

      await poller.poll(txHash);

      expect(mockProvider.getTransactionReceipt).not.toHaveBeenCalled();
    });
  });

  describe('orchestrator error handling', () => {
    /**
     * Transition: fatal error in pollWithBackoff → caught by `poll`, logged, no unhandled rejection.
     */
    it('catches fatal pollWithBackoff errors and logs them without rejecting poll()', async () => {
      const txHash = '0xfatal';
      seedTransaction(txHash);
      const fatalError = new Error('Fatal orchestrator failure');
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const originalMethod = (poller as unknown as { pollWithBackoff: (hash: string) => Promise<void> })
        .pollWithBackoff;
      (poller as unknown as { pollWithBackoff: jest.Mock }).pollWithBackoff = jest
        .fn()
        .mockRejectedValue(fatalError);

      await expect(poller.poll(txHash)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        `Polling orchestrator failed for ${txHash}:`,
        fatalError,
      );

      (poller as unknown as { pollWithBackoff: typeof originalMethod }).pollWithBackoff = originalMethod;
      errorSpy.mockRestore();
    });
  });
});
