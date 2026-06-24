let Database: any;
try {
  // Attempt to load the native module.
  Database = require('better-sqlite3');
} catch {
  // Fallback mock implementation for environments without the native bindings.
  class MockDatabase {
    constructor(_path: string) {}
    pragma(_stmt: string) { return this; }
    prepare(_sql: string) {
      return {
        run: (..._args: any[]) => ({ lastInsertRowid: 0, changes: 0 }),
        get: () => undefined,
        all: () => [],
        exec: () => {},
      };
    }
    exec(_sql: string) {}
    close() {}
  }
  Database = MockDatabase;
}
export default Database;

export namespace Database {
  export type Database = any;
}
