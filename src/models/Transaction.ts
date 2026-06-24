import { getDb } from '../db/database';

/**
 * Transaction statuses.
 */
export enum TransactionStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  TIMEOUT = 'TIMEOUT',
}

/**
 * Interface representing a blockchain transaction in the system.
 */
export interface Transaction {
  hash: string;
  status: TransactionStatus;
  receipt?: any;
  lastCheckedAt?: Date;
  retryCount: number;
}

/**
 * SQLite-backed storage for transactions.
 */
export const transactionsDb = {
  get(hash: string): Transaction | undefined {
    const row = getDb().prepare('SELECT * FROM transactions WHERE hash = ?').get(hash) as any;
    if (!row) return undefined;
    return {
      hash: row.hash,
      status: row.status as TransactionStatus,
      receipt: row.receipt ? JSON.parse(row.receipt) : undefined,
      lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at) : undefined,
      retryCount: row.retry_count,
    };
  },

  set(hash: string, tx: Transaction): typeof transactionsDb {
    getDb().prepare(`
      INSERT INTO transactions (hash, status, receipt, last_checked_at, retry_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        status = excluded.status,
        receipt = excluded.receipt,
        last_checked_at = excluded.last_checked_at,
        retry_count = excluded.retry_count
    `).run(
      tx.hash,
      tx.status,
      tx.receipt ? JSON.stringify(tx.receipt) : null,
      tx.lastCheckedAt ? tx.lastCheckedAt.toISOString() : null,
      tx.retryCount
    );
    return this;
  },

  delete(hash: string): boolean {
    const info = getDb().prepare('DELETE FROM transactions WHERE hash = ?').run(hash);
    return info.changes > 0;
  },

  clear(): void {
    getDb().prepare('DELETE FROM transactions').run();
  },

  values(): IterableIterator<Transaction> {
    const rows = getDb().prepare('SELECT * FROM transactions').all() as any[];
    const mapped = rows.map(row => ({
      hash: row.hash,
      status: row.status as TransactionStatus,
      receipt: row.receipt ? JSON.parse(row.receipt) : undefined,
      lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at) : undefined,
      retryCount: row.retry_count,
    }));
    return mapped.values();
  }
};
