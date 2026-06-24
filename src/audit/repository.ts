  if (backend === 'sqlite') {
    const dbPath =
      process.env['AUDIT_DB_PATH'] ??
      (process.env['NODE_ENV'] === 'test'
        ? ':memory:'
        : path.join(process.cwd(), 'talenttrust-audit.db'));
    // Load the native driver only when the SQLite backend is selected so
    // in-memory tests can run on machines without compiled bindings.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const db = new Database.default(dbPath);
    return new SqliteAuditRepository(db);
  }

  throw new Error(`Unsupported AUDIT_STORAGE_BACKEND: ${backend}`);
}
