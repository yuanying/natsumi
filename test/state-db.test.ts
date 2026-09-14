import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, MigrationError, openStateDatabase, type Migration } from '../src/server/state-db.ts';

async function withDb(fn: (db: DatabaseSync, path: string) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-state-'));
  const path = join(root, 'state.sqlite');
  const db = openStateDatabase(path);
  try { await fn(db, path); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

const tables = (db: DatabaseSync) => (db.prepare(
  "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
  .map(row => row.name);

const one: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE a (id TEXT PRIMARY KEY);' };
const two: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE b (id TEXT PRIMARY KEY);' };

test('migrations apply in order and running them again changes nothing', () => withDb(db => {
  assert.deepEqual(migrate(db, [one, two]), { applied: [1, 2], version: 2 });
  db.prepare('INSERT INTO a (id) VALUES (?)').run('kept');
  assert.deepEqual(migrate(db, [one, two]), { applied: [], version: 2 });
  assert.deepEqual(tables(db), ['a', 'b', 'schema_migrations']);
  assert.equal((db.prepare('SELECT count(*) AS n FROM a').get() as { n: number }).n, 1);
}));

test('later code adds a migration on top of an existing database', () => withDb(db => {
  migrate(db, [one]);
  assert.deepEqual(migrate(db, [one, two]), { applied: [2], version: 2 });
}));

test('a failing migration leaves no partial schema and is not recorded', () => withDb(db => {
  const broken: Migration = { version: 2, name: 'broken',
    sql: 'CREATE TABLE half (id TEXT); INSERT INTO a (id) VALUES (\'x\'); CREATE TABLE a (dup TEXT);' };
  migrate(db, [one]);
  assert.throws(() => migrate(db, [one, broken]),
    (error: unknown) => error instanceof MigrationError && error.version === 2);
  assert.deepEqual(tables(db), ['a', 'schema_migrations']);
  assert.equal((db.prepare('SELECT count(*) AS n FROM a').get() as { n: number }).n, 0);
  assert.deepEqual(migrate(db, [one, two]), { applied: [2], version: 2 });
}));

test('the database stays usable after a failed run is reopened', () => withDb(async (db, path) => {
  assert.throws(() => migrate(db, [{ version: 1, name: 'bad', sql: 'CREATE TABLE x (; ' }]));
  const again = openStateDatabase(path);
  try { assert.deepEqual(migrate(again, [one]), { applied: [1], version: 1 }); } finally { again.close(); }
}));

test('malformed migration lists are rejected before touching the database', () => withDb(db => {
  assert.throws(() => migrate(db, [two, one]), /order/);
  assert.throws(() => migrate(db, [one, { ...two, version: 1 }]), /order/);
  assert.throws(() => migrate(db, [{ ...one, version: 0 }]), /version/);
  assert.deepEqual(tables(db), []);
}));

test('a database from newer or different code is refused', () => withDb(db => {
  migrate(db, [one, two]);
  assert.throws(() => migrate(db, [one]), /newer/);
  assert.throws(() => migrate(db, [one, { ...two, name: 'renamed' }]), /does not match/);
}));

test('the initial schema applies cleanly and twice', () => withDb(db => {
  const first = migrate(db, MIGRATIONS);
  assert.ok(first.applied.length > 0);
  assert.deepEqual(migrate(db, MIGRATIONS).applied, []);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
}));

test('the initial schema keeps references to Pi sessions but never conversation text', () => withDb(db => {
  migrate(db, MIGRATIONS);
  for (const table of tables(db)) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
    for (const column of columns) {
      assert.doesNotMatch(column, /^(text|body|content|message|prompt|reply|response)$/i, `${table}.${column}`);
    }
  }
  const conversation = { id: 'conversation-example', session: 'session-example' };
  db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
    .run(conversation.id, conversation.session, 'fixture.jsonl', '2026-01-01T00:00:00Z');
  // Session references are relative to the Pi session directory; absolute or escaping paths are refused.
  for (const file of ['/abs/fixture.jsonl', '../escape.jsonl', 'a/../../escape.jsonl']) {
    assert.throws(() => db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
      .run(`c-${file}`, `s-${file}`, file, '2026-01-01T00:00:00Z'), /constraint/i);
  }
  const insertOp = db.prepare(`INSERT INTO conversation_operations
    (request_id, device_id, conversation_id, body_hash, state, turn_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?)`);
  insertOp.run('request-1', 'device-1', conversation.id, 'hash', 'turn-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  assert.throws(() => insertOp.run('request-1', 'device-1', conversation.id, 'other', 'turn-2', 'x', 'x'), /constraint/i);
  assert.throws(() => insertOp.run('request-2', 'device-1', 'unknown-conversation', 'h', 'turn-3', 'x', 'x'), /constraint/i);
}));
