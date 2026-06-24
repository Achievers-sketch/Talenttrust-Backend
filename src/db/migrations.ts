import { createHash } from "crypto";
import Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  /**
   * Stable semantic body hashed for checksum verification. When set, this is
   * used instead of `up.toString()` so formatting-only edits do not invalidate
   * previously applied migrations.
   */
  checksumSource?: string;
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
    checksumSource: [
      "CREATE TABLE IF NOT EXISTS users (",
      "CREATE TABLE IF NOT EXISTS contracts (",
      "CREATE INDEX IF NOT EXISTS idx_contracts_client_id",
      "CREATE INDEX IF NOT EXISTS idx_contracts_freelancer_id",
      "CREATE INDEX IF NOT EXISTS idx_contracts_status",
    ].join("\n"),
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
    checksumSource:
      "ALTER TABLE contracts ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)",
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
    name: "create_notifications_table",
    checksumSource: [
      "CREATE TABLE IF NOT EXISTS notifications (",
      "CREATE INDEX IF NOT EXISTS idx_notifications_user_id",
    ].join("\n"),
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
          id        TEXT PRIMARY KEY,
          user_id   TEXT NOT NULL,
          title     TEXT NOT NULL,
          message   TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_notifications_user_id
          ON notifications(user_id);
      `);
    },
  },
  {
    version: 4,
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
 * @returns A SHA-256 checksum over version, name, and migration body.
 *
 * @remarks
 * When `checksumSource` is provided it is hashed instead of `up.toString()` so
 * checksums remain stable across formatting-only source edits. Custom test
 * migrations without `checksumSource` continue to hash `up.toString()`.
 */
export function computeMigrationChecksum(migration: Migration): string {
  const body = migration.checksumSource ?? migration.up.toString();
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${body}`)
    .digest("hex");
}

/**
 * Legacy checksum using `up.toString()` only. Used to backfill rows recorded
 * before `checksumSource` was introduced.
 */
function computeLegacyMigrationChecksum(migration: Migration): string {
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
      const legacyChecksum = computeLegacyMigrationChecksum(migration);

      if (
        migration.checksumSource &&
        applied.checksum === legacyChecksum &&
        legacyChecksum !== expectedChecksum
      ) {
        db.prepare<[string, number]>(
          "UPDATE schema_version SET checksum = ? WHERE version = ?"
        ).run(expectedChecksum, applied.version);
        applied.checksum = expectedChecksum;
        continue;
      }

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
