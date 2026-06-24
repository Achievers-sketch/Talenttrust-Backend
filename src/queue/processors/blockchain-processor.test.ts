/**
 * Blockchain Processor Tests
 *
 * Covers RPC-backed event ingestion, idempotent replay, circuit-breaker
 * behaviour, cursor-based resume, and input/SSRF validation. The RPC client and
 * indexer are mocked so tests are deterministic and never touch the network.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { rpc } from '@stellar/stellar-sdk';

import {
  processBlockchainSync,
  BlockchainSyncDeps,
  BlockchainSyncStats,
  EventSink,
  RpcEventSource,
} from './blockchain-processor';
import { BlockchainSyncPayload } from '../types';
import { SmartContractEvent, EventType } from '../../services/indexer';
import { buildEventKey } from '../../contracts/dedupe';
import { ContractEvent } from '../../contracts/types';
import { CircuitBreaker } from '../../circuit-breaker/CircuitBreaker';
import { CircuitOpenError } from '../../circuit-breaker/errors';
import { InMemoryCursorRepository } from '../../contracts/cursor.repository';

const SAFE_RPC_URL = 'https://soroban-testnet.stellar.org';

/** Build a raw-ish RPC event. Topics/values stay as plain values for clarity. */
function chainEvent(overrides: Partial<{
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  contractId: string;
  topics: string[];
  value: unknown;
}> = {}): rpc.Api.EventResponse {
  const raw = {
    id: overrides.id ?? 'evt-1',
    type: 'contract',
    ledger: overrides.ledger ?? 1,
    ledgerClosedAt: overrides.ledgerClosedAt ?? '2024-01-01T00:00:00Z',
    pagingToken: 'pt',
    inSuccessfulContractCall: true,
    txHash: overrides.txHash ?? 'tx-1',
    contractId: overrides.contractId ?? 'CCONTRACT',
    topic: overrides.topics ?? ['escrow_created'],
    value: 'value' in overrides ? overrides.value : { amount: 100 },
  };
  return raw as unknown as rpc.Api.EventResponse;
}

/** Wrap events in a getEvents response page. */
function page(
  events: rpc.Api.EventResponse[],
  cursor = ''
): rpc.Api.GetEventsResponse {
  return {
    latestLedger: 1000,
    events,
    cursor,
  } as unknown as rpc.Api.GetEventsResponse;
}

/** Controllable RPC double that records every request it receives. */
class FakeRpc implements RpcEventSource {
  public latestLedger = 1000;
  public calls: rpc.Server.GetEventsRequest[] = [];
  public latestCalls = 0;

  public getEventsImpl: (
    req: rpc.Server.GetEventsRequest
  ) => Promise<rpc.Api.GetEventsResponse> = async () => page([]);

  public getLatestImpl?: () => Promise<rpc.Api.GetLatestLedgerResponse>;

  async getEvents(
    req: rpc.Server.GetEventsRequest
  ): Promise<rpc.Api.GetEventsResponse> {
    this.calls.push(req);
    return this.getEventsImpl(req);
  }

  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    this.latestCalls += 1;
    if (this.getLatestImpl) {
      return this.getLatestImpl();
    }
    return {
      id: 'ledger',
      sequence: this.latestLedger,
      protocolVersion: '22',
    } as unknown as rpc.Api.GetLatestLedgerResponse;
  }
}

/** Indexer double that records persisted events. */
class RecordingIndexer implements EventSink {
  public events: SmartContractEvent[] = [];

  async processEvent(
    event: SmartContractEvent
  ): Promise<{ status: string; eventId: string }> {
    this.events.push(event);
    return { status: 'indexed', eventId: `ev-${this.events.length}` };
  }
}

const silentLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function makeDeps(overrides: Partial<BlockchainSyncDeps> = {}): BlockchainSyncDeps {
  return {
    rpcSource: new FakeRpc(),
    indexer: new RecordingIndexer(),
    breaker: new CircuitBreaker({ name: 'test', failureThreshold: 3, timeout: 60_000 }),
    cursors: new InMemoryCursorRepository(),
    dedupeKeys: new Set<string>(),
    rpcUrl: SAFE_RPC_URL,
    contractId: undefined,
    log: silentLog,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Blockchain Processor', () => {
  describe('input validation', () => {
    it('rejects unsupported networks', async () => {
      const payload = { network: 'ethereum' } as unknown as BlockchainSyncPayload;
      await expect(processBlockchainSync(payload, makeDeps())).rejects.toThrow(
        'Invalid network: ethereum'
      );
    });

    it('rejects an inverted block range', async () => {
      const payload: BlockchainSyncPayload = {
        network: 'soroban',
        startBlock: 100,
        endBlock: 50,
      };
      await expect(processBlockchainSync(payload, makeDeps())).rejects.toThrow(
        'Start block must be less than or equal to end block'
      );
    });

    it('rejects an RPC URL that fails the SSRF guard', async () => {
      const deps = makeDeps({ rpcUrl: 'http://127.0.0.1:8000/rpc' });
      await expect(
        processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps)
      ).rejects.toThrow('SSRF protection');
    });
  });

  describe('event ingestion', () => {
    it('persists fetched events and reports stats', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () =>
        page([
          chainEvent({ id: 'a', ledger: 1, topics: ['escrow_created'] }),
          chainEvent({ id: 'b', ledger: 2, topics: ['escrow_completed'] }),
        ]);
      const indexer = new RecordingIndexer();
      const deps = makeDeps({ rpcSource, indexer });

      const result = await processBlockchainSync(
        { network: 'soroban', startBlock: 1, endBlock: 5 },
        deps
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Blockchain sync completed');
      const stats = result.data as BlockchainSyncStats;
      expect(stats.eventsIngested).toBe(2);
      expect(stats.duplicatesSkipped).toBe(0);
      expect(stats.blocksProcessed).toBe(5);
      expect(stats.lastSyncedBlock).toBe(5);
      expect(indexer.events).toHaveLength(2);
      expect(indexer.events[0].eventType).toBe(EventType.EscrowCreated);
      expect(indexer.events[1].eventType).toBe(EventType.EscrowCompleted);
    });

    it('preserves raw topics and value in the persisted payload', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () =>
        page([chainEvent({ id: 'a', ledger: 3, topics: ['custom_topic'], value: { x: 1 } })]);
      const indexer = new RecordingIndexer();
      const deps = makeDeps({ rpcSource, indexer });

      await processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps);

      const persisted = indexer.events[0];
      expect(persisted.eventType).toBe(EventType.EscrowCreated); // unknown topic -> default
      expect(persisted.payload).toMatchObject({
        topics: ['custom_topic'],
        value: { x: 1 },
        ledger: 3,
      });
    });

    it('classifies dispute lifecycle topics', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () =>
        page([
          chainEvent({ id: 'd1', ledger: 1, topics: ['dispute_initiated'] }),
          chainEvent({ id: 'd2', ledger: 2, topics: ['dispute_resolved'] }),
        ]);
      const indexer = new RecordingIndexer();
      const deps = makeDeps({ rpcSource, indexer });

      await processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps);

      expect(indexer.events.map((e) => e.eventType)).toEqual([
        EventType.DisputeInitiated,
        EventType.DisputeResolved,
      ]);
    });

    it('skips events that carry no contract id', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () =>
        page([
          chainEvent({ id: 'a', ledger: 1, contractId: '' }),
          chainEvent({ id: 'b', ledger: 2, contractId: 'CCONTRACT' }),
        ]);
      const indexer = new RecordingIndexer();
      const deps = makeDeps({ rpcSource, indexer });

      const result = await processBlockchainSync(
        { network: 'soroban', startBlock: 1, endBlock: 5 },
        deps
      );

      expect((result.data as BlockchainSyncStats).eventsIngested).toBe(1);
      expect(indexer.events).toHaveLength(1);
      expect(indexer.events[0].contractId).toBe('CCONTRACT');
    });

    it('passes the configured contract id as an RPC filter', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () => page([]);
      const deps = makeDeps({ rpcSource, contractId: 'CFILTERED' });

      await processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps);

      expect(rpcSource.calls[0].filters).toEqual([
        { type: 'contract', contractIds: ['CFILTERED'] },
      ]);
    });
  });

  describe('idempotency', () => {
    it('skips duplicate events within a single batch', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () =>
        page([
          chainEvent({ id: 'dup', ledger: 1 }),
          chainEvent({ id: 'dup', ledger: 1 }),
        ]);
      const indexer = new RecordingIndexer();
      const deps = makeDeps({ rpcSource, indexer });

      const result = await processBlockchainSync(
        { network: 'soroban', startBlock: 1, endBlock: 5 },
        deps
      );

      const stats = result.data as BlockchainSyncStats;
      expect(stats.eventsIngested).toBe(1);
      expect(stats.duplicatesSkipped).toBe(1);
      expect(indexer.events).toHaveLength(1);
    });

    it('does not double-write when the same batch is replayed', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () =>
        page([chainEvent({ id: 'a', ledger: 1 }), chainEvent({ id: 'b', ledger: 2 })]);
      const indexer = new RecordingIndexer();
      const dedupeKeys = new Set<string>();
      const deps = makeDeps({ rpcSource, indexer, dedupeKeys });

      const first = await processBlockchainSync(
        { network: 'soroban', startBlock: 1, endBlock: 5 },
        deps
      );
      const second = await processBlockchainSync(
        { network: 'soroban', startBlock: 1, endBlock: 5 },
        deps
      );

      expect((first.data as BlockchainSyncStats).eventsIngested).toBe(2);
      expect((second.data as BlockchainSyncStats).eventsIngested).toBe(0);
      expect((second.data as BlockchainSyncStats).duplicatesSkipped).toBe(2);
      expect(indexer.events).toHaveLength(2); // never re-persisted
    });

    it('seeds the dedupe registry with the canonical event key', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () =>
        page([chainEvent({ id: 'a', ledger: 7, contractId: 'CCONTRACT' })]);
      const dedupeKeys = new Set<string>();
      const deps = makeDeps({ rpcSource, dedupeKeys });

      await processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 10 }, deps);

      const expectedKey = buildEventKey({
        contractId: 'CCONTRACT',
        eventId: 'a',
        sequence: 7,
      } as ContractEvent);
      expect(dedupeKeys.has(expectedKey)).toBe(true);
    });
  });

  describe('resume / checkpointing', () => {
    it('resumes from the ledger after the stored cursor', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () => page([]);
      const cursors = new InMemoryCursorRepository();
      await cursors.updateCursor('soroban', 20);
      const deps = makeDeps({ rpcSource, cursors });

      await processBlockchainSync({ network: 'soroban', endBlock: 25 }, deps);

      expect(rpcSource.calls[0].startLedger).toBe(21);
    });

    it('starts from zero when no cursor exists', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () => page([]);
      const deps = makeDeps({ rpcSource });

      await processBlockchainSync({ network: 'soroban', endBlock: 5 }, deps);

      expect(rpcSource.calls[0].startLedger).toBe(0);
    });

    it('checkpoints the last synced ledger after the batch', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () => page([chainEvent({ ledger: 3 })]);
      const cursors = new InMemoryCursorRepository();
      const deps = makeDeps({ rpcSource, cursors });

      await processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps);

      const cursor = await cursors.getCursor('soroban');
      expect(cursor?.lastSequence).toBe(5);
    });

    it('uses a contract-scoped cursor source when a contract id is set', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () => page([]);
      const cursors = new InMemoryCursorRepository();
      const deps = makeDeps({ rpcSource, cursors, contractId: 'CSCOPED' });

      await processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps);

      expect(await cursors.getCursor('soroban:CSCOPED')).not.toBeNull();
      expect(await cursors.getCursor('soroban')).toBeNull();
    });

    it('returns early for an empty range without calling getEvents', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.latestLedger = 10;
      const cursors = new InMemoryCursorRepository();
      await cursors.updateCursor('soroban', 20);
      const deps = makeDeps({ rpcSource, cursors });

      const result = await processBlockchainSync({ network: 'soroban' }, deps);

      expect(result.success).toBe(true);
      expect(result.message).toContain('up to date');
      expect((result.data as BlockchainSyncStats).blocksProcessed).toBe(0);
      expect(rpcSource.calls).toHaveLength(0);
    });
  });

  describe('chain head discovery', () => {
    it('queries the latest ledger when no endBlock is supplied', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.latestLedger = 4;
      rpcSource.getEventsImpl = async () => page([chainEvent({ ledger: 2 })]);
      const deps = makeDeps({ rpcSource });

      const result = await processBlockchainSync({ network: 'soroban', startBlock: 0 }, deps);

      expect(rpcSource.latestCalls).toBe(1);
      expect((result.data as BlockchainSyncStats).endBlock).toBe(4);
    });
  });

  describe('batching', () => {
    it('scans large ranges across multiple batches', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () => page([]);
      const deps = makeDeps({ rpcSource });

      const result = await processBlockchainSync(
        { network: 'soroban', startBlock: 1, endBlock: 25 },
        deps
      );

      expect((result.data as BlockchainSyncStats).blocksProcessed).toBe(25);
      expect(rpcSource.calls.map((c) => c.startLedger)).toEqual([1, 11, 21]);
    });

    it('follows the paging cursor and stops at the window edge', async () => {
      const rpcSource = new FakeRpc();
      const responses = [
        page([chainEvent({ id: 'p1', ledger: 1 })], 'cursor-1'),
        page([chainEvent({ id: 'p2', ledger: 2 }), chainEvent({ id: 'over', ledger: 99 })], 'cursor-2'),
      ];
      let call = 0;
      rpcSource.getEventsImpl = async () => responses[call++] ?? page([]);
      const indexer = new RecordingIndexer();
      const deps = makeDeps({ rpcSource, indexer });

      const result = await processBlockchainSync(
        { network: 'soroban', startBlock: 1, endBlock: 5 },
        deps
      );

      // Two pages consumed; the ledger-99 event is outside the window and ignored.
      expect(rpcSource.calls).toHaveLength(2);
      expect(rpcSource.calls[1].cursor).toBe('cursor-1');
      expect((result.data as BlockchainSyncStats).eventsIngested).toBe(2);
      expect(indexer.events.map((e) => e.payload)).toEqual([
        expect.objectContaining({ ledger: 1 }),
        expect.objectContaining({ ledger: 2 }),
      ]);
    });
  });

  describe('xdr decoding', () => {
    it('decodes real XDR topics, value, and Contract id', async () => {
      const contractAddress = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 1));
      const rawEvent = {
        id: 'xdr-1',
        type: 'contract',
        ledger: 2,
        ledgerClosedAt: '2024-02-02T00:00:00Z',
        pagingToken: 'pt',
        inSuccessfulContractCall: true,
        txHash: 'tx-xdr',
        contractId: new StellarSdk.Contract(contractAddress),
        topic: [StellarSdk.xdr.ScVal.scvSymbol('escrow_completed')],
        value: StellarSdk.xdr.ScVal.scvU32(42),
      } as unknown as rpc.Api.EventResponse;

      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () => page([rawEvent]);
      const indexer = new RecordingIndexer();
      const deps = makeDeps({ rpcSource, indexer });

      await processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps);

      const persisted = indexer.events[0];
      expect(persisted.contractId).toBe(contractAddress);
      expect(persisted.eventType).toBe(EventType.EscrowCompleted);
      expect(persisted.payload).toMatchObject({
        topics: ['escrow_completed'],
        value: 42,
      });
    });

    it('tolerates a null event value', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () =>
        page([chainEvent({ id: 'n', ledger: 1, value: null })]);
      const indexer = new RecordingIndexer();
      const deps = makeDeps({ rpcSource, indexer });

      await processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps);

      expect(indexer.events[0].payload).toMatchObject({ value: null });
    });
  });

  describe('default dependency wiring', () => {
    it('builds production deps from env when none are injected', async () => {
      // Default deps are constructed before validation runs; an inverted range
      // exercises that wiring without performing any network I/O.
      await expect(
        processBlockchainSync({ network: 'soroban', startBlock: 5, endBlock: 4 })
      ).rejects.toThrow('Start block must be less than or equal to end block');
    });
  });

  describe('circuit breaker and RPC failures', () => {
    it('fails the job when the circuit is open', async () => {
      const breaker = new CircuitBreaker({ name: 'rpc', failureThreshold: 1, timeout: 60_000 });
      await expect(breaker.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow();
      expect(breaker.getState()).toBe('OPEN');

      const rpcSource = new FakeRpc();
      const deps = makeDeps({ rpcSource, breaker });

      await expect(
        processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps)
      ).rejects.toBeInstanceOf(CircuitOpenError);
      // Breaker short-circuited before any real RPC call.
      expect(rpcSource.calls).toHaveLength(0);
    });

    it('fails the job (for retry) when getEvents errors', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () => {
        throw new Error('rpc unavailable');
      };
      const deps = makeDeps({ rpcSource });

      await expect(
        processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps)
      ).rejects.toThrow('Soroban RPC getEvents failed: rpc unavailable');
    });

    it('fails the job when the chain-head lookup times out', async () => {
      const rpcSource = new FakeRpc();
      rpcSource.getLatestImpl = async () => {
        throw new Error('timeout');
      };
      const deps = makeDeps({ rpcSource });

      await expect(
        processBlockchainSync({ network: 'soroban', startBlock: 0 }, deps)
      ).rejects.toThrow('Soroban RPC getLatestLedger failed: timeout');
    });

    it('trips the breaker open after repeated RPC failures', async () => {
      const breaker = new CircuitBreaker({ name: 'rpc', failureThreshold: 1, timeout: 60_000 });
      const rpcSource = new FakeRpc();
      rpcSource.getEventsImpl = async () => {
        throw new Error('down');
      };
      const deps = makeDeps({ rpcSource, breaker });

      await expect(
        processBlockchainSync({ network: 'soroban', startBlock: 1, endBlock: 5 }, deps)
      ).rejects.toThrow();
      expect(breaker.getState()).toBe('OPEN');
    });
  });
});
