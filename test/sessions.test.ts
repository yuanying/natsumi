import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SESSION_TTL_MS, SessionStore } from '../src/server/sessions.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';

const OWNER_ID = 4242001;

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

test('sessions are short-lived', () => {
  assert.ok(SESSION_TTL_MS > 0 && SESSION_TTL_MS <= 24 * 3_600_000);
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
