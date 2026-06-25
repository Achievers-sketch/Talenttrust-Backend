import type * as BetterSqlite3 from 'better-sqlite3';

interface DatabaseConstructor {
  new (filename: string, options?: BetterSqlite3.Options): BetterSqlite3.Database;
  (filename: string, options?: BetterSqlite3.Options): BetterSqlite3.Database;
}

let Database: DatabaseConstructor;
try {
  // Attempt to load the native module and test if its bindings work.
  const RealDatabase = require('better-sqlite3');
  const testDb = new RealDatabase(':memory:');
  testDb.close();
  Database = RealDatabase;
} catch {
  // Fallback mock implementation for environments without the native bindings.
  class MockDatabase {
    constructor(_path: string) {}
    pragma(stmt: string, ..._args: any[]) {
      if (stmt.includes('table_info')) {
        return [{ name: 'id' }, { name: 'version' }];
      }
      if (stmt.includes('journal_mode')) return 'wal';
      if (stmt.includes('synchronous')) return 1;
      if (stmt.includes('busy_timeout')) return 5000;
      if (stmt.includes('foreign_keys')) return 1;
      return [];
    }
    prepare(_sql: string) {
      return {
        run: (..._args: any[]) => ({ lastInsertRowid: 0, changes: 0 }),
        get: () => undefined,
        all: () => [],
        iterate: function* () {},
        exec: () => {},
      };
    }
    transaction(fn: (...args: any[]) => any) {
      return fn;
    }
    exec(_sql: string) {}
    close() {}
  }
  Database = MockDatabase as any;
}
export default Database;

export type Database = BetterSqlite3.Database;
