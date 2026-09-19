import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../src/server/conversation-store.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';

const CLOCK = Date.parse('2026-03-02T09:00:00.000Z');

/** A migrated database and a store on it, cleaned up afterwards. */
async function withStore(fn: (store: ConversationStore, db: DatabaseSync) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-store-'));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  try {
    await fn(new ConversationStore(db, () => CLOCK), db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** A row of loop_events in whatever state a stopped process would have left it. */
function event(db: DatabaseSync, eventId: string, kind: string, state: string, createdAt: string, messageId?: string) {
  db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(eventId, kind, messageId ?? null, state, createdAt, createdAt);
}

function message(db: DatabaseSync, messageId: string, position: number,
  row: { role: string; kind: string; text: string; eventId?: string; requestId?: string; deviceId?: string }) {
  db.prepare(`INSERT INTO conversation_messages
    (message_id, position, role, kind, text, event_id, about_event_ids, request_id, device_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(messageId, position, row.role, row.kind, row.text,
    row.eventId ?? null, row.requestId ?? null, row.deviceId ?? null, '2026-03-02T08:00:00.000Z');
}

/** node:sqlite hands back null-prototype rows; the tests compare plain objects. */
const plain = <T>(rows: unknown[]) => rows.map(row => ({ ...row as object })) as T[];

const states = (db: DatabaseSync) => plain<{ event_id: string; state: string; reason: string | null }>(
  db.prepare('SELECT event_id, state, reason FROM loop_events ORDER BY event_id').all());

test('recover closes what a stopped process was handling: replied when its reply was recorded, failed otherwise', () =>
  withStore((store, db) => {
    message(db, 'message-1', 1, { role: 'owner', kind: 'message', text: 'おはよう', eventId: 'event-answered',
      requestId: 'request-1', deviceId: 'device-1' });
    message(db, 'message-2', 2, { role: 'natsumi', kind: 'reply', text: 'おはようございます', eventId: 'event-answered' });
    message(db, 'message-3', 3, { role: 'owner', kind: 'message', text: 'これは？', eventId: 'event-open',
      requestId: 'request-2', deviceId: 'device-1' });
    event(db, 'event-answered', 'mac-message', 'processing', '2026-03-02T08:00:00.000Z', 'message-1');
    event(db, 'event-open', 'mac-message', 'processing', '2026-03-02T08:01:00.000Z', 'message-3');
    event(db, 'event-waiting', 'ping', 'queued', '2026-03-02T08:02:00.000Z');
    event(db, 'event-older', 'self-check', 'queued', '2026-03-02T07:00:00.000Z');
    event(db, 'event-done', 'ping', 'no-reply', '2026-03-02T07:30:00.000Z');

    const recovered = store.recover();

    assert.equal(recovered.closed, 2);
    // Queued events come back oldest first, and nothing else is touched.
    assert.deepEqual(recovered.queued, ['event-older', 'event-waiting']);
    assert.deepEqual(states(db), [
      { event_id: 'event-answered', state: 'replied', reason: null },
      { event_id: 'event-done', state: 'no-reply', reason: null },
      { event_id: 'event-older', state: 'queued', reason: null },
      { event_id: 'event-open', state: 'failed', reason: 'interrupted' },
      { event_id: 'event-waiting', state: 'queued', reason: null },
    ]);
    // A second start finds nothing left to close.
    assert.equal(store.recover().closed, 0);
  }));

test('closeInterruptedReviews fails a switch without a handoff, and keeps the one that still starts from this session', () =>
  withStore((store, db) => {
    db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
      .run('conversation-1', 'session-current', 'current.jsonl', '2026-03-01T00:00:00.000Z');
    for (const [eventId, rotationId] of [['event-a', 'rotation-no-handoff'], ['event-b', 'rotation-kept'], ['event-c', 'rotation-stale']]) {
      event(db, eventId!, 'nightly-review', 'processing', '2026-03-02T00:00:00.000Z');
      db.prepare(`INSERT INTO session_rotations
        (rotation_id, event_id, conversation_id, from_session_id, from_session_file, state, handoff, created_at, updated_at)
        VALUES (?, ?, 'conversation-1', ?, ?, ?, ?, ?, ?)`).run(rotationId!, eventId!,
        rotationId === 'rotation-stale' ? 'session-previous' : 'session-current',
        `${rotationId}.jsonl`,
        rotationId === 'rotation-no-handoff' ? 'reviewing' : 'switching',
        rotationId === 'rotation-no-handoff' ? null : 'あしたの自分へ',
        '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z');
    }

    const closed = store.closeInterruptedReviews('session-current');

    assert.equal(closed, 2);
    assert.deepEqual(plain(db.prepare('SELECT rotation_id, state, reason, updated_at FROM session_rotations ORDER BY rotation_id').all()), [
      { rotation_id: 'rotation-kept', state: 'switching', reason: null, updated_at: '2026-03-02T00:00:00.000Z' },
      { rotation_id: 'rotation-no-handoff', state: 'failed', reason: 'interrupted', updated_at: new Date(CLOCK).toISOString() },
      { rotation_id: 'rotation-stale', state: 'failed', reason: 'interrupted', updated_at: new Date(CLOCK).toISOString() },
    ]);
    // The kept one is the switch the next start finishes.
    assert.equal(store.unfinishedRotation('conversation-1', 'session-current')?.rotation_id, 'rotation-kept');
  }));

test('with no conversation yet, every unfinished switch is closed', () => withStore((store, db) => {
  db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
    .run('conversation-1', 'session-current', 'current.jsonl', '2026-03-01T00:00:00.000Z');
  event(db, 'event-a', 'nightly-review', 'processing', '2026-03-02T00:00:00.000Z');
  db.prepare(`INSERT INTO session_rotations
    (rotation_id, event_id, conversation_id, from_session_id, from_session_file, state, handoff, created_at, updated_at)
    VALUES ('rotation-1', 'event-a', 'conversation-1', 'session-current', 'a.jsonl', 'switching', 'メモ', ?, ?)`)
    .run('2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z');

  assert.equal(store.closeInterruptedReviews(null), 1);
  assert.equal(store.unfinishedRotation('conversation-1', 'session-current'), undefined);
}));
