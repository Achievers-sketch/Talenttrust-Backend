/**
 * Blockchain Synchronization Processor
 *
 * Ingests on-chain Soroban contract events into the local indexer. The job
 * scans a ledger range, fetches events through the Stellar/Soroban RPC layer
 * (guarded by a circuit breaker), and persists each event idempotently so that
 * replayed or retried batches never double-write.
 *
 * Progress is checkpointed after every batch via a cursor, so a restarted job
 * resumes from the last synced ledger instead of re-scanning from zero.
 */

import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';

import { BlockchainSyncPayload, JobResult } from '../types';
import { SorobanRpcService } from '../../services/soroban/SorobanRpcService';
import {
  EventType,
  SmartContractEvent,
  indexerService,
} from '../../services/indexer';
import { buildEventKey } from '../../contracts/dedupe';
import { ContractEvent } from '../../contracts/types';
import { CircuitBreaker } from '../../circuit-breaker/CircuitBreaker';
import { CircuitOpenError } from '../../circuit-breaker/errors';
import {
  CursorRepository,
  InMemoryCursorRepository,
} from '../../contracts/cursor.repository';
import { isSafeUrl } from '../../utils/ssrf';
import { validateEnv } from '../../config/env.schema';
import { logger, Logger } from '../../logger';

/** Number of ledgers fetched and checkpointed per iteration. */
const BATCH_SIZE = 10;

/** Max events requested per RPC page. */
const EVENTS_PAGE_LIMIT = 100;

/** Hard cap on pagination loops per batch to avoid runaway cursors. */
const MAX_PAGES_PER_BATCH = 50;

/** Networks this processor knows how to sync. */
const SUPPORTED_NETWORKS: ReadonlyArray<BlockchainSyncPayload['network']> = [
  'stellar',
  'soroban',
];

/**
 * Maps known on-chain topic symbols to the indexer's event taxonomy.
 * Unrecognized topics fall through to {@link classifyEvent}'s default.
 */
const TOPIC_EVENT_TYPES: Readonly<Record<string, EventType>> = {
  escrow_created: EventType.EscrowCreated,
  created: EventType.EscrowCreated,
  escrow_completed: EventType.EscrowCompleted,
  completed: EventType.EscrowCompleted,
  dispute_initiated: EventType.DisputeInitiated,
  dispute_resolved: EventType.DisputeResolved,
  resolved: EventType.DisputeResolved,
};

/**
 * Minimal RPC surface the sync worker depends on. {@link SorobanRpcService}
 * satisfies this interface; tests inject a lightweight mock.
 */
export interface RpcEventSource {
  getEvents(
    request: rpc.Server.GetEventsRequest
  ): Promise<rpc.Api.GetEventsResponse>;
  getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse>;
}

/**
 * Persistence sink for normalized events. The default
 * {@link indexerService} singleton implements this.
 */
export interface EventSink {
  processEvent(
    event: SmartContractEvent
  ): Promise<{ status: string; eventId: string }>;
}

/** Collaborators required to run a sync. Defaults wire the real Soroban stack. */
export interface BlockchainSyncDeps {
  rpcSource: RpcEventSource;
  indexer: EventSink;
  breaker: CircuitBreaker;
  cursors: CursorRepository;
  /** In-process registry of dedupe keys already persisted. */
  dedupeKeys: Set<string>;
  rpcUrl: string;
  contractId?: string;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** Statistics returned by a completed sync. */
export interface BlockchainSyncStats {
  network: string;
  startBlock: number;
  endBlock: number;
  blocksProcessed: number;
  eventsIngested: number;
  duplicatesSkipped: number;
  lastSyncedBlock: number;
}

/** Normalized, JSON-friendly view of a Soroban contract event. */
interface NormalizedChainEvent {
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  topics: string[];
  value: unknown;
  txHash: string;
}

// Process-wide singletons so resume and dedupe survive across job runs.
const sharedBreaker = new CircuitBreaker({
  name: 'soroban-rpc',
  failureThreshold: 3,
  timeout: 30_000,
});
const sharedCursors: CursorRepository = new InMemoryCursorRepository();
const sharedDedupeKeys = new Set<string>();

/**
 * Build the production dependency set from validated environment config.
 * Only invoked when a caller does not supply its own deps (e.g. real jobs).
 */
function resolveDefaultDeps(): BlockchainSyncDeps {
  const env = validateEnv();
  return {
    rpcSource: new SorobanRpcService(env.SOROBAN_RPC_URL),
    indexer: indexerService,
    breaker: sharedBreaker,
    cursors: sharedCursors,
    dedupeKeys: sharedDedupeKeys,
    rpcUrl: env.SOROBAN_RPC_URL,
    contractId: env.SOROBAN_CONTRACT_ID,
    log: logger,
  };
}

/**
 * Process a blockchain synchronization job.
 *
 * Fetches Soroban contract events for the requested ledger range and persists
 * them through the indexer. RPC failures (including an open circuit) are thrown
 * so the queue retries the job rather than silently reporting success.
 *
 * @param payload - Network and optional block range to sync.
 * @param deps - Injectable collaborators; defaults to the real Soroban stack.
 * @returns Job result with sync statistics.
 * @throws If the network/range is invalid, the RPC URL is unsafe, or RPC fails.
 */
export async function processBlockchainSync(
  payload: BlockchainSyncPayload,
  deps: BlockchainSyncDeps = resolveDefaultDeps()
): Promise<JobResult> {
  if (!SUPPORTED_NETWORKS.includes(payload.network)) {
    throw new Error(`Invalid network: ${payload.network}`);
  }

  if (
    payload.startBlock !== undefined &&
    payload.endBlock !== undefined &&
    payload.startBlock > payload.endBlock
  ) {
    throw new Error('Start block must be less than or equal to end block');
  }

  // SSRF guard: never egress to a private/internal or malformed RPC host.
  if (!isSafeUrl(deps.rpcUrl)) {
    throw new Error(
      'SOROBAN_RPC_URL must be a public URL and cannot point to internal resources (SSRF protection)'
    );
  }

  const sourceId = buildSourceId(payload.network, deps.contractId);
  const startBlock = await resolveStartBlock(payload, sourceId, deps);
  const endBlock = await resolveEndBlock(payload, deps);

  // Nothing new on-chain since the last checkpoint — succeed without scanning.
  if (startBlock > endBlock) {
    deps.log.info('Blockchain sync already up to date', {
      network: payload.network,
      startBlock,
      endBlock,
    });
    return {
      success: true,
      message: `Blockchain sync up to date for ${payload.network}`,
      data: emptyStats(payload.network, startBlock, endBlock),
    };
  }

  const stats = await ingestRange(
    payload.network,
    sourceId,
    startBlock,
    endBlock,
    deps
  );

  deps.log.info('Blockchain sync completed', {
    network: payload.network,
    eventsIngested: stats.eventsIngested,
    duplicatesSkipped: stats.duplicatesSkipped,
    lastSyncedBlock: stats.lastSyncedBlock,
  });

  return {
    success: true,
    message: `Blockchain sync completed for ${payload.network}`,
    data: stats,
  };
}

/**
 * Resolve the first ledger to scan. An explicit `startBlock` always wins;
 * otherwise resume from the ledger after the last checkpointed one.
 */
async function resolveStartBlock(
  payload: BlockchainSyncPayload,
  sourceId: string,
  deps: BlockchainSyncDeps
): Promise<number> {
  if (payload.startBlock !== undefined) {
    return payload.startBlock;
  }

  const cursor = await deps.cursors.getCursor(sourceId);
  if (cursor && cursor.lastSequence >= 0) {
    return cursor.lastSequence + 1;
  }

  return 0;
}

/**
 * Resolve the last ledger to scan. Falls back to the current chain head so we
 * never scan past settled ledgers when no explicit `endBlock` is given.
 */
async function resolveEndBlock(
  payload: BlockchainSyncPayload,
  deps: BlockchainSyncDeps
): Promise<number> {
  if (payload.endBlock !== undefined) {
    return payload.endBlock;
  }

  try {
    const latest = await deps.breaker.execute(() =>
      deps.rpcSource.getLatestLedger()
    );
    return latest.sequence;
  } catch (error) {
    throw asRpcError('getLatestLedger', error);
  }
}

/**
 * Scan the ledger range batch-by-batch, ingesting events and checkpointing
 * progress after each batch so a restart resumes cleanly.
 */
async function ingestRange(
  network: string,
  sourceId: string,
  startBlock: number,
  endBlock: number,
  deps: BlockchainSyncDeps
): Promise<BlockchainSyncStats> {
  let blocksProcessed = 0;
  let eventsIngested = 0;
  let duplicatesSkipped = 0;
  let lastSyncedBlock = startBlock - 1;

  for (let batchStart = startBlock; batchStart <= endBlock; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endBlock);
    const events = await fetchBatchEvents(batchStart, batchEnd, deps);

    for (const event of events) {
      const outcome = await ingestEvent(event, deps);
      if (outcome === 'ingested') {
        eventsIngested += 1;
      } else {
        duplicatesSkipped += 1;
      }
    }

    blocksProcessed += batchEnd - batchStart + 1;
    lastSyncedBlock = batchEnd;

    // Checkpoint only after a batch fully succeeds so retries resume here.
    await deps.cursors.updateCursor(sourceId, batchEnd, { network });
    deps.log.info('Blockchain batch synced', {
      network,
      batchStart,
      batchEnd,
      eventsIngested,
      duplicatesSkipped,
    });
  }

  return {
    network,
    startBlock,
    endBlock,
    blocksProcessed,
    eventsIngested,
    duplicatesSkipped,
    lastSyncedBlock,
  };
}

/**
 * Fetch all contract events within `[batchStart, batchEnd]`, following the RPC
 * paging cursor and stopping once events spill past the window. Every RPC call
 * runs through the circuit breaker.
 */
async function fetchBatchEvents(
  batchStart: number,
  batchEnd: number,
  deps: BlockchainSyncDeps
): Promise<NormalizedChainEvent[]> {
  const filters: rpc.Api.EventFilter[] = deps.contractId
    ? [{ type: 'contract', contractIds: [deps.contractId] }]
    : [{ type: 'contract' }];

  const collected: NormalizedChainEvent[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_BATCH; page += 1) {
    const request: rpc.Server.GetEventsRequest = cursor
      ? { filters, cursor, limit: EVENTS_PAGE_LIMIT }
      : { filters, startLedger: batchStart, limit: EVENTS_PAGE_LIMIT };

    let response: rpc.Api.GetEventsResponse;
    try {
      response = await deps.breaker.execute(() => deps.rpcSource.getEvents(request));
    } catch (error) {
      throw asRpcError('getEvents', error);
    }

    const pageEvents = response.events ?? [];
    let windowEnded = false;

    for (const raw of pageEvents) {
      if (raw.ledger > batchEnd) {
        windowEnded = true;
        break;
      }
      const normalized = normalizeEvent(raw);
      if (normalized.contractId) {
        collected.push(normalized);
      }
    }

    cursor = response.cursor || undefined;
    if (windowEnded || pageEvents.length === 0 || !cursor) {
      break;
    }
  }

  return collected;
}

/**
 * Persist a single event idempotently.
 *
 * The dedupe key is built with the shared {@link buildEventKey} helper from the
 * contract ID, event ID, and ledger sequence. Keys already seen in this process
 * are skipped so replayed batches do not double-write.
 *
 * @returns `'ingested'` when newly persisted, `'duplicate'` when skipped.
 */
async function ingestEvent(
  event: NormalizedChainEvent,
  deps: BlockchainSyncDeps
): Promise<'ingested' | 'duplicate'> {
  // buildEventKey only reads the identity fields (contractId/eventId/sequence).
  const dedupeKey = buildEventKey({
    contractId: event.contractId,
    eventId: event.id,
    sequence: event.ledger,
  } as ContractEvent);

  if (deps.dedupeKeys.has(dedupeKey)) {
    return 'duplicate';
  }

  const smartEvent: SmartContractEvent = {
    contractId: event.contractId,
    eventType: classifyEvent(event.topics),
    idempotencyKey: dedupeKey,
    payload: {
      topics: event.topics,
      value: event.value,
      txHash: event.txHash,
      ledger: event.ledger,
    },
    timestamp: event.ledgerClosedAt,
  };

  await deps.indexer.processEvent(smartEvent);
  deps.dedupeKeys.add(dedupeKey);
  return 'ingested';
}

/**
 * Classify an event by its topics. Falls back to `EscrowCreated` for
 * unrecognized topics; the raw topics are preserved in the event payload so
 * downstream consumers can reclassify if needed.
 */
function classifyEvent(topics: string[]): EventType {
  for (const topic of topics) {
    const mapped = TOPIC_EVENT_TYPES[topic.toLowerCase()];
    if (mapped) {
      return mapped;
    }
  }
  return EventType.EscrowCreated;
}

/**
 * Convert a raw RPC event into a normalized, JSON-friendly shape, decoding
 * XDR topics/values where present. Tolerates already-decoded values so tests
 * can supply plain objects.
 */
function normalizeEvent(raw: rpc.Api.EventResponse): NormalizedChainEvent {
  return {
    id: raw.id,
    contractId: decodeContractId(raw.contractId),
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt ?? new Date().toISOString(),
    topics: (raw.topic ?? []).map((topic) => String(decodeScVal(topic))),
    value: decodeScVal(raw.value),
    txHash: raw.txHash,
  };
}

/** Stringify a contract id whether it arrives as a string or `Contract`. */
function decodeContractId(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return value ? String(value) : '';
}

/** Decode an XDR ScVal to a native value, tolerating already-native inputs. */
function decodeScVal(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof xdr.ScVal) {
    try {
      return scValToNative(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

/** Compose a stable cursor source id for a network/contract pair. */
function buildSourceId(network: string, contractId?: string): string {
  return contractId ? `${network}:${contractId}` : network;
}

/** Stats object for an empty (already-synced) range. */
function emptyStats(
  network: string,
  startBlock: number,
  endBlock: number
): BlockchainSyncStats {
  return {
    network,
    startBlock,
    endBlock,
    blocksProcessed: 0,
    eventsIngested: 0,
    duplicatesSkipped: 0,
    lastSyncedBlock: startBlock - 1,
  };
}

/**
 * Normalize an RPC failure into an Error suitable for failing the job.
 * Circuit-open errors pass through unchanged so callers can detect them.
 */
function asRpcError(operation: string, error: unknown): Error {
  if (error instanceof CircuitOpenError) {
    return error;
  }
  const reason = error instanceof Error ? error.message : 'unknown RPC error';
  return new Error(`Soroban RPC ${operation} failed: ${reason}`);
}
