import path from 'path';
import Database from 'better-sqlite3';
import type { AuditEntry, AuditQuery, CreateAuditEntryInput, IntegrityReport } from './types';
import { AuditStore, auditStore } from './store';
import { SqliteAuditRepository } from './sqliteRepository';

export interface AuditLogRepository {
  append(input: CreateAuditEntryInput): AuditEntry;
  getById(id: string): AuditEntry | undefined;
  query(query?: AuditQuery): AuditEntry[];
  /**
   * Streams entries without materialising the full result set in memory.
   */
  stream(query?: AuditQuery): IterableIterator<AuditEntry>;
  count(): number;
  verifyIntegrity(): IntegrityReport;
}

export function createDefaultAuditRepository(): AuditLogRepository {
  const backend = process.env['AUDIT_STORAGE_BACKEND'] ?? 'memory';

  if (backend === 'memory') {
    return auditStore;
  }

  if (backend === 'sqlite') {
    const dbPath =
      process.env['AUDIT_DB_PATH'] ??
      (process.env['NODE_ENV'] === 'test'
        ? ':memory:'
        : path.join(process.cwd(), 'talenttrust-audit.db'));
    const db = new Database(dbPath);
    return new SqliteAuditRepository(db);
  }

  throw new Error(`Unsupported AUDIT_STORAGE_BACKEND: ${backend}`);
}
