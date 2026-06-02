import axios from 'axios';
import crypto from 'crypto';
import { Counter, register } from 'prom-client';
import { ContractMetadataMismatchError } from './errors/appError';

/**
 * Counter to record contract metadata mismatches observed at runtime.
 * Label: contract - the contract id being verified.
 */
const mismatchCounter = new Counter({
  name: 'contract_metadata_mismatch_total',
  help: 'Total number of observed contract metadata mismatches',
  labelNames: ['contract'],
});

/**
 * Canonicalize an object to deterministically stable JSON for hashing.
 * Sorts object keys recursively so semantically-equal metadata produces
 * the same canonical string.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/** Compute SHA256 hex digest of canonicalized metadata */
export function computeMetadataHash(metadata: unknown): string {
  const canon = canonicalize(metadata);
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

export type Fetcher = (url: string, body?: any) => Promise<any>;

/**
 * Fetches metadata from a Soroban RPC for a given contract and verifies
 * it matches the expected SHA-256 hex hash if provided.
 *
 * The `fetcher` parameter is injectable for tests; by default axios.post
 * is used to call the provided `rpcUrl` with a JSON-RPC body.
 */
export async function fetchAndVerify(
  contractId: string,
  rpcUrl: string,
  expectedHash?: string,
  fetcher?: Fetcher,
): Promise<any> {
  if (!contractId) throw new Error('contractId is required');
  const call = fetcher ?? (async (u: string, body?: any) => (await axios.post(u, body)).data);

  // Minimal JSON-RPC body — callers/tests can replace fetcher with whatever
  // RPC method is appropriate for their environment.
  const body = { jsonrpc: '2.0', id: 1, method: 'get_contract_data', params: { contract_id: contractId } };
  const resp = await call(rpcUrl, body);
  const metadata = resp?.result ?? resp;

  if (expectedHash) {
    const observed = computeMetadataHash(metadata);
    if (observed.toLowerCase() !== expectedHash.toLowerCase()) {
      mismatchCounter.inc({ contract: contractId });
      throw new ContractMetadataMismatchError();
    }
  }

  return metadata;
}

/** Test helper: allow tests to read/reset the mismatch counter. */
export function getMismatchMetric(): Counter<string> {
  return mismatchCounter;
}

/** Reset Prometheus register (used in tests to avoid cross-test pollution). */
export function resetMetricsForTest(): void {
  try {
    register.clear();
  } catch (e) {
    // ignore
  }
}

export default {
  canonicalize,
  computeMetadataHash,
  fetchAndVerify,
  getMismatchMetric,
  resetMetricsForTest,
};
