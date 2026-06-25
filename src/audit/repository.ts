import path from 'path';
import type { AuditEntry, AuditQuery, CreateAuditEntryInput, IntegrityReport } from './types';
import { AuditStore, auditStore } from './store';
import { SqliteAuditRepository } from './sqliteRepository';
import * as Database from '../db/betterSqlite3';

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
    // Load the native driver only when the SQLite backend is selected so
    // in-memory tests can run on machines without compiled bindings.
    const db = new Database.default(dbPath);
    return new SqliteAuditRepository(db);
  }

  throw new Error(`Unsupported AUDIT_STORAGE_BACKEND: ${backend}`);
}
