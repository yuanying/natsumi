import { DatabaseSync } from 'node:sqlite';
import { isoAt } from './nightly.ts';

export interface Migration {
  /** Positive, strictly increasing. Never renumber or edit a released migration; add a new one. */
  version: number;
  name: string;
  sql: string;
}

export class MigrationError extends Error {
  readonly version: number | undefined;
  constructor(message: string, version?: number) {
    super(message);
    this.name = 'MigrationError';
    this.version = version;
  }
}

export function openStateDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

/**
 * Applies pending migrations in order. Each migration and its bookkeeping row commit in one transaction,
 * so a failure rolls that migration back completely and leaves earlier ones applied.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): { applied: number[]; version: number } {
  migrations.forEach((m, i) => {
    if (!Number.isInteger(m.version) || m.version < 1) throw new MigrationError(`invalid migration version ${m.version}`);
    if (i > 0 && m.version <= migrations[i - 1]!.version) throw new MigrationError('migrations must be in strictly increasing order');
  });
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT`);
  const done = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as { version: number; name: string }[];
  const known = new Map(migrations.map(m => [m.version, m]));
  for (const row of done) {
    const migration = known.get(row.version);
    if (!migration) throw new MigrationError(`database schema version ${row.version} is newer than this code`, row.version);
    if (migration.name !== row.name) throw new MigrationError(`applied migration ${row.version} does not match this code`, row.version);
  }
  const applied: number[] = [];
  const doneVersions = new Set(done.map(row => row.version));
  for (const migration of migrations) {
    if (doneVersions.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, isoAt(Date.now()));
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new MigrationError(`migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : error}`,
        migration.version);
    }
    applied.push(migration.version);
  }
  return { applied, version: migrations.at(-1)?.version ?? 0 };
}
