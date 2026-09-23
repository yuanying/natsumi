import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SESSION_RENEW_INTERVAL_MS, SESSION_TTL_MS, SessionStore } from '../src/server/sessions.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';

const OWNER_ID = 4242001;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function withStore(fn: (store: SessionStore, clock: { now: number }, db: DatabaseSync, path: string) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-sessions-'));
  const path = join(root, 'state.sqlite');
  const db = openStateDatabase(path);
  const clock = { now: Date.parse('2026-01-01T00:00:00Z') };
  try {
    migrate(db, MIGRATIONS);
    await fn(new SessionStore(db, () => clock.now), clock, db, path);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test('a session lasts thirty days from its last use, and is renewed at most once an hour', () => {
  assert.equal(SESSION_TTL_MS, 30 * DAY);
  assert.equal(SESSION_RENEW_INTERVAL_MS, HOUR);
});

test('a session token verifies for its account until it expires', () => withStore((store, clock) => {
  const session = store.create(OWNER_ID);
  assert.ok(session.token.length >= 43);
  assert.equal(session.expiresAt, new Date(clock.now + SESSION_TTL_MS).toISOString());
  assert.deepEqual(store.verify(session.token, OWNER_ID), { sessionId: session.sessionId, githubUserId: OWNER_ID, expiresAt: session.expiresAt });
  assert.equal(store.verify('fixture-unknown-token', OWNER_ID), undefined);
  assert.equal(store.verify('', OWNER_ID), undefined);
  clock.now += SESSION_TTL_MS - 1;
  assert.ok(store.verify(session.token, OWNER_ID));
  clock.now += 1;
  assert.equal(store.verify(session.token, OWNER_ID), undefined);
}));

test('each session has its own token', () => withStore(store => {
  const a = store.create(OWNER_ID);
  const b = store.create(OWNER_ID);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.sessionId, b.sessionId);
}));

test('a revoked session is refused and revoking twice reports nothing to revoke', () => withStore(store => {
  const session = store.create(OWNER_ID);
  const other = store.create(OWNER_ID);
  assert.equal(store.revoke(session.token), true);
  assert.equal(store.verify(session.token, OWNER_ID), undefined);
  assert.equal(store.revoke(session.token), false);
  assert.ok(store.verify(other.token, OWNER_ID), 'other sessions stay valid');
}));

test('a session of an account that is no longer allowed is refused', () => withStore(store => {
  const session = store.create(OWNER_ID);
  assert.equal(store.verify(session.token, OWNER_ID + 1), undefined);
}));

test('the state database never holds a session token in plaintext', () => withStore(async (store, _clock, db, path) => {
  const tokens = [store.create(OWNER_ID), store.create(OWNER_ID)].map(s => s.token);
  store.revoke(tokens[0]!);
  const rows = JSON.stringify(db.prepare('SELECT * FROM client_sessions').all());
  const files = await Promise.all([path, `${path}-wal`].map(file => readFile(file).then(b => b.toString('latin1'), () => '')));
  for (const token of tokens) {
    assert.ok(!rows.includes(token), 'token found in rows');
    for (const bytes of files) assert.ok(!bytes.includes(token), 'token found in database file');
  }
}));

const storedEnd = (db: DatabaseSync, sessionId: string) =>
  (db.prepare('SELECT expires_at FROM client_sessions WHERE session_id = ?').get(sessionId) as { expires_at: string }).expires_at;

test('renewing a session moves its end thirty days past the use', () => withStore((store, clock) => {
  const session = store.create(OWNER_ID);
  clock.now += 2 * HOUR;
  const renewed = new Date(clock.now + SESSION_TTL_MS).toISOString();
  assert.equal(store.renew(session.sessionId), renewed);
  assert.equal(store.verify(session.token, OWNER_ID)?.expiresAt, renewed);
}));

test('a session used within every thirty days never expires', () => withStore((store, clock) => {
  const session = store.create(OWNER_ID);
  for (let i = 0; i < 6; i += 1) {
    clock.now += 29 * DAY;
    assert.ok(store.renew(session.sessionId), `renewal ${i}`);
  }
  assert.ok(store.verify(session.token, OWNER_ID));
}));

test('a session unused for thirty days is refused and can no longer be renewed', () => withStore((store, clock) => {
  const session = store.create(OWNER_ID);
  clock.now += 2 * HOUR;
  store.renew(session.sessionId);
  clock.now += SESSION_TTL_MS;
  assert.equal(store.verify(session.token, OWNER_ID), undefined);
  assert.equal(store.renew(session.sessionId), undefined);
}));

test('a revoked session is not renewed', () => withStore((store, clock) => {
  const session = store.create(OWNER_ID);
  store.revoke(session.token);
  clock.now += 2 * HOUR;
  assert.equal(store.renew(session.sessionId), undefined);
  assert.equal(store.verify(session.token, OWNER_ID), undefined);
  assert.equal(store.renew('session-unknown'), undefined);
}));

test('within an hour of the last renewal a use writes nothing and reports the end it already has', () => withStore((store, clock, db) => {
  const session = store.create(OWNER_ID);
  const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const before = changes();
  for (let minute = 1; minute < 60; minute += 1) {
    clock.now = Date.parse(session.expiresAt) - SESSION_TTL_MS + minute * 60_000;
    assert.equal(store.renew(session.sessionId), session.expiresAt);
  }
  assert.equal(changes(), before, 'no row was written');
  assert.equal(storedEnd(db, session.sessionId), session.expiresAt);

  clock.now = Date.parse(session.expiresAt) - SESSION_TTL_MS + HOUR;
  const renewed = store.renew(session.sessionId);
  assert.equal(renewed, new Date(clock.now + SESSION_TTL_MS).toISOString());
  assert.equal(storedEnd(db, session.sessionId), renewed);
  assert.equal(changes(), before + 1);
}));
