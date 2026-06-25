import { createHash } from "crypto";
import Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  checksumSource?: string;
  up: (db: Database.Database) => void;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string | null;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "create_users_and_contracts_schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id          TEXT    PRIMARY KEY,
          username    TEXT    NOT NULL UNIQUE,
          email       TEXT    NOT NULL UNIQUE,
          role        TEXT    NOT NULL DEFAULT 'client'
                              CHECK (role IN ('client', 'freelancer', 'both')),
          created_at  TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS contracts (
          id            TEXT    PRIMARY KEY,
          title         TEXT    NOT NULL,
          client_id     TEXT    NOT NULL REFERENCES users(id),
          freelancer_id TEXT    NOT NULL REFERENCES users(id),
          amount        INTEGER NOT NULL CHECK (amount >= 0),
          status        TEXT    NOT NULL DEFAULT 'draft'
                                CHECK (status IN (
                                  'draft', 'active', 'completed', 'disputed', 'cancelled'
                                )),
          created_at    TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_contracts_client_id
          ON contracts(client_id);

        CREATE INDEX IF NOT EXISTS idx_contracts_freelancer_id
          ON contracts(freelancer_id);

        CREATE INDEX IF NOT EXISTS idx_contracts_status
          ON contracts(status);
      `);
    },
  },
  {
    version: 2,
    name: "add_contract_version_column",
    up: (db) => {
      const columns = db.pragma("table_info(contracts)") as Array<{ name: string }>;
      const hasVersion = columns.some((col) => col.name === "version");
      if (!hasVersion) {
        db.exec(
          "ALTER TABLE contracts ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)"
        );
      }
    },
  },
  {
    version: 3,
    name: "create_reputation_entries",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reputation_entries (
          id          TEXT    PRIMARY KEY,
          reviewer_id TEXT    NOT NULL REFERENCES users(id),
          target_id   TEXT    NOT NULL REFERENCES users(id),
          rating      INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
          comment     TEXT    CHECK (length(comment) <= 1000),
          context_id  TEXT    NOT NULL REFERENCES contracts(id),
          created_at  TEXT    NOT NULL,
          UNIQUE(reviewer_id, target_id, context_id)
        );

        CREATE INDEX IF NOT EXISTS idx_reputation_entries_target_id
          ON reputation_entries(target_id);

        CREATE INDEX IF NOT EXISTS idx_reputation_entries_context_id
          ON reputation_entries(context_id);
      `);
    },
  },
  {
    version: 4,
    name: "create_reputation_entries",
    checksumSource: [
      "CREATE TABLE IF NOT EXISTS reputation_entries (",
      "CREATE INDEX IF NOT EXISTS idx_reputation_entries_target_id",
      "CREATE INDEX IF NOT EXISTS idx_reputation_entries_context_id",
    ].join("\n"),
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reputation_entries (
          id          TEXT    PRIMARY KEY,
          reviewer_id TEXT    NOT NULL REFERENCES users(id),
          target_id   TEXT    NOT NULL REFERENCES users(id),
          rating      INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
          comment     TEXT    CHECK (length(comment) <= 1000),
          context_id  TEXT    NOT NULL REFERENCES contracts(id),
          created_at  TEXT    NOT NULL,
          UNIQUE(reviewer_id, target_id, context_id)
        );

        CREATE INDEX IF NOT EXISTS idx_reputation_entries_target_id
          ON reputation_entries(target_id);

        CREATE INDEX IF NOT EXISTS idx_reputation_entries_context_id
          ON reputation_entries(context_id);
      `);
    },
  },
  {
    version: 5,
    name: "create_transactions_table",
    checksumSource: [
      "CREATE TABLE IF NOT EXISTS transactions (",
    ].join("\n"),
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
          hash            TEXT    PRIMARY KEY,
          status          TEXT    NOT NULL,
          receipt         TEXT,
          last_checked_at TEXT,
          retry_count     INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
];

// Version 6: deployment_history table
MIGRATIONS.push({
  version: 6,
  name: "create_deployment_history_table",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_history (
        id TEXT PRIMARY KEY,
        environment_from TEXT NOT NULL,
        environment_to TEXT,
        target_version TEXT NOT NULL,
        promotion_id TEXT,
        rollback_id TEXT,
        initiated_by TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILURE')),
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deployment_history_env_from ON deployment_history(environment_from);
      CREATE INDEX IF NOT EXISTS idx_deployment_history_env_to ON deployment_history(environment_to);
    `);
  },
});

function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      checksum    TEXT,
      applied_at  TEXT    NOT NULL
    );
  `);

  const columns = db.pragma("table_info(schema_version)") as Array<{ name: string }>;
  const hasChecksum = columns.some((column) => column.name === "checksum");

  if (!hasChecksum) {
    db.exec("ALTER TABLE schema_version ADD COLUMN checksum TEXT");
  }
}

function getAppliedMigrations(db: Database.Database): Map<number, AppliedMigration> {
  const rows = db
    .prepare<[], AppliedMigration>(
      "SELECT version, name, checksum FROM schema_version ORDER BY version ASC"
    )
    .all();

  return new Map(rows.map((row) => [row.version, row]));
}

function assertMigrationsAreValid(migrations: Migration[]): void {
  for (let index = 0; index < migrations.length; index += 1) {
    const expectedVersion = index + 1;
    const migration = migrations[index];

    if (migration?.version !== expectedVersion) {
      throw new Error(
        `Invalid migration sequence: expected version ${expectedVersion}, got ${migration?.version}`
      );
    }
  }
}

/**
 * Computes the immutable fingerprint stored for an applied migration.
 *
 * @param migration - Migration definition from the ordered migration list.
 * @returns A SHA-256 checksum over version, name, and implementation body.
 *
 * @remarks
 * Migration checksums intentionally include `up.toString()` so edits to an
 * already-applied migration fail fast on the next database open. Add a new
 * migration instead of changing an existing one.
 */
export function computeMigrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.up.toString()}`)
    .digest("hex");
}

function verifyAppliedMigrations(
  db: Database.Database,
  appliedMigrations: Map<number, AppliedMigration>,
  migrations: Migration[]
): void {
  const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  for (const applied of appliedMigrations.values()) {
    const migration = migrationsByVersion.get(applied.version);

    if (!migration) {
      throw new Error(
        `Applied migration ${applied.version} (${applied.name}) is not present in the migration list`
      );
    }

    const expectedChecksum = computeMigrationChecksum(migration);

    if (applied.name !== migration.name) {
      throw new Error(
        `Applied migration ${applied.version} name mismatch: expected ${migration.name}, got ${applied.name}`
      );
    }

    if (applied.checksum === null) {
      db.prepare<[string, number]>(
        "UPDATE schema_version SET checksum = ? WHERE version = ?"
      ).run(expectedChecksum, applied.version);
      applied.checksum = expectedChecksum;
    }

    if (applied.checksum !== expectedChecksum) {
      throw new Error(
        `Applied migration ${applied.version} checksum mismatch; refusing to start`
      );
    }
  }
}

/**
 * Applies pending database migrations after verifying applied checksums.
 *
 * @param db - Open SQLite database handle.
 * @param migrations - Ordered migration definitions, primarily overridden by tests.
 *
 * @remarks
 * The database open path calls this synchronously before serving requests.
 * Applied migrations are verified before pending migrations run. Each pending
 * migration and its `schema_version` insert happen inside one SQLite
 * transaction, so partial DDL/DML is rolled back if the migration throws.
 */
export function runMigrations(
  db: Database.Database,
  migrations: Migration[] = MIGRATIONS
): void {
  assertMigrationsAreValid(migrations);
  ensureMigrationTable(db);

  const appliedMigrations = getAppliedMigrations(db);
  verifyAppliedMigrations(db, appliedMigrations, migrations);

  const insertApplied = db.prepare<[number, string, string, string]>(
    "INSERT INTO schema_version (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
  );

  for (const migration of migrations) {
    if (appliedMigrations.has(migration.version)) {
      continue;
    }

    const applyMigration = db.transaction(() => {
      migration.up(db);
      insertApplied.run(
        migration.version,
        migration.name,
        computeMigrationChecksum(migration),
        new Date().toISOString()
      );
    });

    applyMigration();
  }
}

export function getLatestSchemaVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}
