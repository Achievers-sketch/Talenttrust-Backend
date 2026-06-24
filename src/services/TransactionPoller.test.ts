import { TransactionPoller, IBlockchainProvider } from './TransactionPoller';
import { Transaction, TransactionStatus, transactionsDb } from '../models/Transaction';
import { closeDb } from '../db/database';

// Run against in-memory DB for tests
process.env.DB_PATH = ':memory:';

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
 * Computes the expected backoff delay with jitter (mocked Math.random() = 0.5)
 * for a given retry count using the poller formula:
 * `initialDelay * 2^(retryCount - 1) * 0.75`.
 */
function expectedBackoffDelay(initialDelay: number, retryCount: number): number {
  const exponential = initialDelay * Math.pow(2, retryCount - 1);
  return exponential * 0.75; // Because Math.random() is mocked to 0.5
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

  beforeAll(() => {
    process.env.DB_PATH = ':memory:';
  });

  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // Jitter multiplier becomes 0.75
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
    it('creates a PENDING transaction when the hash is not yet tracked', async () => {
      const txHash = '0xnew';
      mockProvider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: txHash });

      await poller.poll(txHash);

      const stored = transactionsDb.get(txHash);
      expect(stored).toBeDefined();
      expect(stored?.status).toBe(TransactionStatus.SUCCESS);
      expect(stored?.retryCount).toBe(0);
    });

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

  describe('exponential backoff schedule with full jitter', () => {
    it('schedules delays using full-jitter bounds', async () => {
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

      // Stop further polling
      const tx = transactionsDb.get(txHash);
      if (tx) {
        tx.status = TransactionStatus.SUCCESS;
        transactionsDb.set(txHash, tx);
      }
      jest.runAllTimers();
      await pollPromise;
    });

    it('does not invoke the provider again until the backoff interval passes', async () => {
      const txHash = '0xbackoff-timing';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      const delay = expectedBackoffDelay(initialDelay, 1);
      await advanceTimersAndFlush(delay - 1);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      // Complete the first backoff window.
      await advanceTimersAndFlush(1);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(2);

      const tx = transactionsDb.get(txHash);
      if (tx) {
        tx.status = TransactionStatus.SUCCESS;
        transactionsDb.set(txHash, tx);
      }
      jest.runAllTimers();
      await pollPromise;
    });
  });

  describe('TIMEOUT transition', () => {
    it('sets TIMEOUT after maxRetries exhausted with persistently null receipts', async () => {
      const txHash = '0xtimeout';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);

      // Attempt 1: retryCount 0 → 1
      await flushMicrotasks();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      // Attempt 2: retryCount 1 → 2
      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(transactionsDb.get(txHash)?.retryCount).toBe(2);

      // Attempt 3: retryCount 2 → 3
      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 2));
      expect(transactionsDb.get(txHash)?.retryCount).toBe(3);

      // Attempt 4: retryCount >= maxRetries → TIMEOUT
      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 3));

      const stored = transactionsDb.get(txHash);
      expect(stored?.status).toBe(TransactionStatus.TIMEOUT);
      expect(stored?.lastCheckedAt).toBeInstanceOf(Date);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(maxRetries);

      await pollPromise;
    });
  });

  describe('early termination when status is no longer PENDING', () => {
    it('returns early when status is changed externally to a non-PENDING value', async () => {
      const txHash = '0xexternal-success';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      const tx = transactionsDb.get(txHash);
      expect(tx).toBeDefined();
      tx!.status = TransactionStatus.SUCCESS;
      transactionsDb.set(txHash, tx!);

      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      await pollPromise;
    });

    it('returns early when status is changed externally to FAILED', async () => {
      const txHash = '0xexternal-failed';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();

      const tx = transactionsDb.get(txHash);
      expect(tx).toBeDefined();
      tx!.status = TransactionStatus.FAILED;
      transactionsDb.set(txHash, tx!);

      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      await pollPromise;
    });

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

    it('does not poll when the transaction is already in a terminal state', async () => {
      const txHash = '0xalready-done';
      seedTransaction(txHash, { status: TransactionStatus.SUCCESS });

      await poller.poll(txHash);

      expect(mockProvider.getTransactionReceipt).not.toHaveBeenCalled();
    });
  });

  describe('recovery routine', () => {
    it('re-enqueues polling for all PENDING transactions', async () => {
      seedTransaction('0xpending1');
      seedTransaction('0xpending2');
      seedTransaction('0xsuccess1', { status: TransactionStatus.SUCCESS });
      
      mockProvider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: 'hash' });
      
      await poller.recoverPendingTransactions();
      
      await flushMicrotasks();
      
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(2);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledWith('0xpending1');
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledWith('0xpending2');
    });
  });

  describe('orchestrator error handling', () => {
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
