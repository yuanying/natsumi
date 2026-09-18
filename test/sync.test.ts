import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import WebSocket from 'ws';
import { login, OWNER, startFixture, type Fixture, type FixtureOptions } from './support/server-fixture.ts';

const TOKEN = 'SYNTHETIC-ORCHID-731';

interface Envelope {
  v: number; epoch: string; streamId: string; seq: number; type: string; requestId?: string; payload: Record<string, any>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>, options: FixtureOptions = {}) {
  const f = await startFixture(options);
  try { await fn(f); } finally { await f.cleanup(); }
}

/** A WebSocket client that keeps every message it received, in order. */
class Client {
  /** The numbered stream. The line of thinking is of the moment and is not part of it (ADR 0017). */
  readonly messages: Envelope[] = [];
  readonly thinking: Envelope[] = [];
  readonly raw: string[] = [];
  readonly closed: Promise<number>;
  deviceId: string | undefined;
  private readonly ws: WebSocket;
  private counter = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', data => {
      const text = String(data);
      this.raw.push(text);
      const envelope = JSON.parse(text) as Envelope;
      (envelope.type === 'conversation.thinking' ? this.thinking : this.messages).push(envelope);
    });
    this.closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  }

  static open(f: Fixture, token: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${token}` } });
      const client = new Client(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
      ws.once('unexpected-response', (_request, response) => reject(new Error(`refused with ${response.statusCode}`)));
    });
  }

  send(type: string, payload: Record<string, unknown>, requestId = `request-${++this.counter}-${Math.random().toString(36).slice(2)}`) {
    this.ws.send(JSON.stringify({ v: 1, requestId, deviceId: this.deviceId, type, payload }));
    return requestId;
  }

  /** The first message at or after index `from` that matches. */
  async until(predicate: (message: Envelope) => boolean, from = 0, timeout = 5_000): Promise<Envelope> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = this.messages.slice(from).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out; received ${this.messages.map(m => m.type).join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  reply(requestId: string, from = 0) {
    return this.until(message => message.requestId === requestId, from);
  }

  async sync(resume: { epoch: string; streamId: string; seq: number } | null = null) {
    const from = this.messages.length;
    const reply = await this.reply(this.send('session.sync', { resume }), from);
    if (typeof reply.payload.deviceId === 'string') this.deviceId = reply.payload.deviceId;
    return reply;
  }

  /** Sends a message and waits until its event is done and the avatar has settled. */
  async sendAndComplete(text: string) {
    const from = this.messages.length;
    const requestId = this.send('conversation.send', { text });
    const accepted = await this.reply(requestId, from);
    assert.equal(accepted.type, 'command.accepted', JSON.stringify(accepted.payload));
    const done = await this.until(m => m.type === 'conversation.event.completed' && m.payload.eventId === accepted.payload.eventId, from);
    await this.until(m => m.type === 'avatar.expression' && m.payload.expression !== 'thinking' && m.seq > done.seq, from);
    return done;
  }

  get last(): Envelope { return this.messages.at(-1)!; }

  close() { this.ws.close(); return this.closed; }
}

function conversationRow(f: Fixture) {
  const db = new DatabaseSync(join(f.data, '.natsumi', 'state.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT pi_session_id, pi_session_file FROM conversations').get() as { pi_session_id: string; pi_session_file: string };
  } finally { db.close(); }
}

const seqs = (messages: Envelope[]) => messages.map(m => m.seq);
const from = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i);
/** Events every device receives alike. */
const shared = (client: Client) => client.messages
  .filter(m => !m.type.startsWith('command.') && m.type !== 'session.snapshot').map(({ type, requestId, payload }) => ({ type, requestId, payload }));
const shown = (messages: { role: string; text: string }[]) => messages.map(m => [m.role, m.text]);
const latestEventId = (context: Context) => {
  const user = context.messages.filter(m => m.role === 'user').at(-1)!;
  return JSON.stringify(user.content).match(/event_id\\":\\"([^\\"]+)/)![1]!;
};

/** A model that answers every event with one reply and ends the turn. */
function replyWith(f: Fixture, text: (context: Context) => string) {
  f.model.auto = context => {
    const eventId = latestEventId(context);
    return { thinking: 'hidden-thought-4417', text: '（内心）',
      calls: [{ name: 'reply_to_mac', arguments: { event_id: eventId, text: text(context) } }, { name: 'finish_event', arguments: { event_id: eventId } }] };
  };
}

test('two devices see the owner message, the thinking expression and the one reply, each on its own contiguous stream', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  const b = await Client.open(f, token);
  const snapshotA = await a.sync();
  const snapshotB = await b.sync();
  assert.equal(snapshotA.type, 'session.snapshot');
  assert.equal(snapshotB.type, 'session.snapshot');
  assert.notEqual(a.deviceId, undefined);
  assert.notEqual(a.deviceId, b.deviceId);
  assert.equal(snapshotA.epoch, snapshotB.epoch);
  assert.notEqual(snapshotA.streamId, snapshotB.streamId);
  assert.deepEqual([snapshotA.payload.messages, snapshotA.payload.pendingEvents, snapshotA.payload.avatar], [[], [], { expression: 'neutral' }]);

  const requestId = a.send('conversation.send', { text: '架空のメッセージ' });
  const call = await f.model.next();
  // Before the model has produced anything, both devices show the message and the thinking expression.
  for (const client of [a, b]) {
    await client.until(m => m.type === 'avatar.expression' && m.payload.expression === 'thinking');
    assert.deepEqual(shown(client.messages.filter(m => m.type === 'conversation.message').map(m => m.payload as any)), [['owner', '架空のメッセージ']]);
  }
  const accepted = a.messages.find(m => m.requestId === requestId)!;
  assert.equal(accepted.type, 'command.accepted');
  const typesA = a.messages.map(m => m.type);
  assert.ok(typesA.indexOf('command.accepted') < typesA.indexOf('conversation.message'));

  const eventId = accepted.payload.eventId as string;
  call.think('hidden-thought-4417');
  call.delta('（内心）返事を書く');
  call.call('reply_to_mac', { event_id: eventId, text: 'こんにちは' });
  call.call('finish_event', { event_id: eventId });
  call.finish();
  for (const client of [a, b]) {
    await client.until(m => m.type === 'avatar.expression' && m.payload.expression === 'neutral');
    assert.deepEqual(seqs(client.messages), from(1, client.messages.length));
    assert.equal(new Set(client.messages.map(m => m.streamId)).size, 1);
    const said = client.messages.filter(m => m.type === 'conversation.message');
    assert.deepEqual(shown(said.map(m => m.payload as any)), [['owner', '架空のメッセージ'], ['natsumi', 'こんにちは']]);
    assert.equal((await client.until(m => m.type === 'conversation.event.completed')).payload.status, 'replied');
  }
  // Only the sender gets the command answer, so the other stream's numbers do not move for it.
  assert.equal(b.messages.some(m => m.type === 'command.accepted'), false);
  assert.deepEqual(shared(a), shared(b));

  // The line she was writing reached both devices while she wrote it, taking no number and leaving no trace on the
  // numbered stream (ADR 0017).
  for (const client of [a, b]) {
    assert.deepEqual(client.thinking.map(m => m.payload.line), ['hidden-thought-4417', '']);
    assert.equal(new Set(client.thinking.map(m => m.streamId)).size, 1);
    assert.equal(client.thinking[0]!.streamId, client.messages[0]!.streamId);
    // It carries the number the stream was at, so a client that does not know the type reads no gap into it.
    assert.ok(client.messages.some(m => m.seq === client.thinking[0]!.seq));
  }

  const row = conversationRow(f);
  for (const text of [...a.raw, ...b.raw]) {
    for (const hidden of [row.pi_session_id, row.pi_session_file, f.root, '内心', 'reply_to_mac', '<events>']) {
      assert.equal(text.includes(hidden), false, hidden);
    }
  }
  // Nothing of the thinking is kept: a device that syncs afresh sees only the conversation.
  const late = await Client.open(f, token);
  const snapshot = await late.sync();
  assert.equal(JSON.stringify(snapshot.payload).includes('hidden-thought'), false);
  await late.close();
  await a.close();
  await b.close();
}));

test('a resent requestId is not handled twice and a different body is refused', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  await a.sync();
  replyWith(f, () => 'はい');
  const first = await a.reply(a.send('conversation.send', { text: 'hello' }, 'request-1'));
  assert.equal(first.type, 'command.accepted');
  let mark = a.messages.length;
  const again = await a.reply(a.send('conversation.send', { text: 'hello' }, 'request-1'), mark);
  assert.deepEqual([again.type, again.payload.messageId, again.payload.eventId], ['command.accepted', first.payload.messageId, first.payload.eventId]);
  mark = a.messages.length;
  const conflict = await a.reply(a.send('conversation.send', { text: 'other' }, 'request-1'), mark);
  assert.deepEqual([conflict.type, conflict.payload.code], ['command.rejected', 'request-conflict']);
  await a.until(m => m.type === 'conversation.event.completed');
  // A second message while the first is being handled is accepted, not refused as busy.
  await a.sendAndComplete('second');
  assert.equal(f.model.calls, 2);
  assert.equal(a.messages.filter(m => m.type === 'conversation.message' && m.payload.role === 'owner').length, 2);
  await a.close();
}));

test('a reconnecting device gets the events it missed, or a snapshot once they left its buffer', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  await a.sync();
  const b = await Client.open(f, token);
  await b.sync();
  const left = a.last;
  await a.close();

  replyWith(f, () => '応答');
  await b.sendAndComplete('first');
  const back = await Client.open(f, token);
  back.deviceId = a.deviceId;
  const resumed = await back.sync({ epoch: left.epoch, streamId: left.streamId, seq: left.seq });
  assert.equal(resumed.type, 'command.accepted');
  assert.equal(resumed.payload.mode, 'resume');
  assert.deepEqual(back.messages.slice(0, -1).map(m => m.type), ['conversation.message', 'avatar.expression',
    'conversation.message', 'conversation.event.completed', 'avatar.expression']);
  assert.deepEqual(seqs(back.messages), from(left.seq + 1, back.messages.length));
  assert.equal(resumed.streamId, left.streamId);
  const mark = back.last;
  await back.close();

  // The fixture keeps 8 events per stream; three more turns (5 events each) push the missed ones out.
  for (const text of ['second', 'third', 'fourth']) await b.sendAndComplete(text);
  const late = await Client.open(f, token);
  late.deviceId = a.deviceId;
  const snapshot = await late.sync({ epoch: mark.epoch, streamId: mark.streamId, seq: mark.seq });
  assert.equal(snapshot.type, 'session.snapshot');
  assert.equal(snapshot.payload.deviceId, a.deviceId);
  assert.equal(snapshot.streamId, mark.streamId);
  assert.ok(snapshot.seq > mark.seq);
  assert.deepEqual(snapshot.payload.messages.filter((m: { role: string }) => m.role === 'owner').map((m: { text: string }) => m.text),
    ['first', 'second', 'third', 'fourth']);

  // A gap the client reports (a seq ahead of the server's) also gets a snapshot rather than a guess.
  const ahead = await late.sync({ epoch: snapshot.epoch, streamId: snapshot.streamId, seq: snapshot.seq + 100 });
  assert.equal(ahead.type, 'session.snapshot');
  await late.close();
  await b.close();
}, { streamBufferSize: 8 }));

test('a second connection of the same device replaces the first', () => withFixture(async f => {
  const { token } = await login(f);
  const first = await Client.open(f, token);
  const synced = await first.sync();
  const second = await Client.open(f, token);
  second.deviceId = first.deviceId;
  const reply = await second.sync();
  assert.equal(await first.closed, 4001);
  assert.equal(reply.type, 'session.snapshot');
  assert.equal(reply.payload.deviceId, first.deviceId);
  assert.equal(reply.streamId, synced.streamId);
  assert.ok(reply.seq > synced.seq);
  await second.close();
}));

test('commands need a synced device and a live session; a device ID is never a credential', () => withFixture(async f => {
  const { token, expiresAt } = await login(f);
  const client = await Client.open(f, token);
  client.deviceId = 'device-not-registered';
  const early = await client.reply(client.send('conversation.send', { text: 'hello' }));
  assert.deepEqual([early.type, early.payload.code], ['command.rejected', 'sync-required']);
  // An unknown device ID is not adopted; the server issues its own.
  await client.sync();
  assert.notEqual(client.deviceId, 'device-not-registered');

  const own = client.deviceId;
  client.deviceId = 'device-other';
  let mark = client.messages.length;
  const mismatch = await client.reply(client.send('conversation.send', { text: 'hello' }), mark);
  assert.deepEqual([mismatch.type, mismatch.payload.code], ['command.rejected', 'device-mismatch']);
  client.deviceId = own;
  mark = client.messages.length;
  // The thought in progress is never interrupted (ADR 0008).
  const interrupt = await client.reply(client.send('conversation.interrupt', { turnId: 'turn-example' }), mark);
  assert.deepEqual([interrupt.type, interrupt.payload.code], ['command.rejected', 'not-implemented']);
  mark = client.messages.length;
  const empty = await client.reply(client.send('conversation.send', { text: '  ' }), mark);
  assert.deepEqual([empty.type, empty.payload.code], ['command.rejected', 'invalid-request']);

  f.clock.advance(Date.parse(expiresAt) - f.clock.now);
  mark = client.messages.length;
  client.send('conversation.send', { text: 'hello' });
  assert.equal(await client.closed, 1008);
  assert.equal(client.messages.length, mark);
  assert.equal(f.model.calls, 0);
}));

test('after a server restart the same device sees the same conversation from SQLite and the Pi session continues', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  await a.sync();
  replyWith(f, context => JSON.stringify(context.messages.slice(0, -1)).includes(TOKEN) ? TOKEN : 'OK');
  await a.sendAndComplete(`Remember ${TOKEN}`);
  const left = a.last;
  const deviceId = a.deviceId;
  await f.restart(OWNER.id);
  await a.closed;

  const again = await Client.open(f, token);
  again.deviceId = deviceId;
  const snapshot = await again.sync({ epoch: left.epoch, streamId: left.streamId, seq: left.seq });
  assert.equal(snapshot.type, 'session.snapshot');
  assert.notEqual(snapshot.epoch, left.epoch);
  assert.equal(snapshot.payload.deviceId, deviceId);
  assert.deepEqual(shown(snapshot.payload.messages), [['owner', `Remember ${TOKEN}`], ['natsumi', 'OK']]);
  for (const hidden of ['hidden-thought', '内心', 'reply_to_mac', 'finish_event', '<events>']) {
    assert.equal(again.raw.at(-1)!.includes(hidden), false, hidden);
  }
  await again.sendAndComplete('What was it?');
  const answer = again.messages.filter(m => m.type === 'conversation.message' && m.payload.role === 'natsumi').at(-1);
  assert.equal(answer?.payload.text, TOKEN);
  await again.close();
}));

test('a lost session file is reported as unavailable and no new session is started', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  await a.sync();
  replyWith(f, () => 'OK');
  await a.sendAndComplete('hello');
  const sessions = join(f.root, 'pi', 'sessions');
  await rm(join(sessions, conversationRow(f).pi_session_file));
  await f.restart(OWNER.id);
  await a.closed;

  const again = await Client.open(f, token);
  const reply = await again.sync();
  assert.deepEqual([reply.type, reply.payload.code], ['service.unavailable', 'conversation-restore-failed']);
  const mark = again.messages.length;
  const refused = await again.reply(again.send('conversation.send', { text: 'hello again' }), mark);
  assert.deepEqual([refused.type, refused.payload.code], ['service.unavailable', 'conversation-restore-failed']);
  assert.equal(f.model.calls, 1);
  assert.deepEqual((await readdir(sessions)).filter(name => name.endsWith('.jsonl')), []);
  await again.close();
}));

test('reading and acknowledging reach every device, are replayed after a reconnect and agree with a new snapshot', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  const b = await Client.open(f, token);
  await a.sync();
  await b.sync();
  f.model.auto = context => {
    const eventId = latestEventId(context);
    return { calls: [{ name: 'notify_owner', arguments: { text: 'お知らせ' } },
      { name: 'reply_to_mac', arguments: { event_id: eventId, text: 'はい' } }, { name: 'finish_event', arguments: { event_id: eventId } }] };
  };
  await a.sendAndComplete('hello');
  const said = a.messages.filter(m => m.type === 'conversation.message').map(m => m.payload);
  const noticeId = said.find(m => m.kind === 'notice')!.messageId as string;
  const replyId = said.find(m => m.kind === 'reply')!.messageId as string;
  const ownerId = said.find(m => m.kind === 'message')!.messageId as string;

  let mark = b.messages.length;
  const read = await b.reply(b.send('conversation.read', { throughMessageId: replyId }), mark);
  assert.deepEqual([read.type, read.payload], ['command.accepted', { readThroughMessageId: replyId, unreadReplyCount: 0 }]);
  for (const client of [a, b]) {
    const event = await client.until(m => m.type === 'conversation.read');
    assert.deepEqual(event.payload, { readThroughMessageId: replyId, unreadReplyCount: 0 });
  }
  // The sender gets its answer first, as with conversation.send.
  assert.ok(b.messages.find(m => m.type === 'conversation.read')!.seq > read.seq);

  // Device A is away while B acknowledges the notice.
  const left = a.last;
  await a.close();
  mark = b.messages.length;
  const acked = await b.reply(b.send('notification.ack', { notificationId: noticeId }), mark);
  assert.equal(acked.type, 'command.accepted');
  assert.equal(acked.payload.notificationId, noticeId);
  const { acknowledgedAt } = acked.payload;
  assert.deepEqual((await b.until(m => m.type === 'notification.acked')).payload, { notificationId: noticeId, acknowledgedAt });

  // A second ack returns the recorded state and broadcasts nothing more.
  mark = b.messages.length;
  const again = await b.reply(b.send('notification.ack', { notificationId: noticeId }), mark);
  assert.deepEqual([again.type, again.payload], ['command.accepted', { notificationId: noticeId, acknowledgedAt }]);
  assert.equal(b.messages.filter(m => m.type === 'notification.acked').length, 1);

  const back = await Client.open(f, token);
  back.deviceId = a.deviceId;
  const resumed = await back.sync({ epoch: left.epoch, streamId: left.streamId, seq: left.seq });
  assert.equal(resumed.payload.mode, 'resume');
  assert.deepEqual(back.messages.slice(0, -1).map(m => [m.type, m.payload]), [['notification.acked', { notificationId: noticeId, acknowledgedAt }]]);

  const fresh = await Client.open(f, token);
  const snapshot = await fresh.sync();
  assert.equal(snapshot.type, 'session.snapshot');
  assert.deepEqual([snapshot.payload.readThroughMessageId, snapshot.payload.unreadReplyCount, snapshot.payload.unacknowledgedNotificationIds],
    [replyId, 0, []]);

  // Invalid targets are refused on the sender's stream only.
  for (const [type, payload] of [
    ['conversation.read', {}], ['conversation.read', { throughMessageId: 'message-missing' }],
    ['notification.ack', { notificationId: replyId }], ['notification.ack', { notificationId: ownerId }], ['notification.ack', { notificationId: 42 }],
  ] as const) {
    mark = fresh.messages.length;
    const refused = await fresh.reply(fresh.send(type, payload), mark);
    assert.deepEqual([refused.type, refused.payload.code], ['command.rejected', 'invalid-request'], `${type} ${JSON.stringify(payload)}`);
  }
  for (const client of [back, b, fresh]) await client.close();
}));

test('reading and acknowledging need a synced device, like sending', () => withFixture(async f => {
  const { token } = await login(f);
  const client = await Client.open(f, token);
  for (const [type, payload] of [['conversation.read', { throughMessageId: 'message-x' }], ['notification.ack', { notificationId: 'message-x' }]] as const) {
    const mark = client.messages.length;
    const early = await client.reply(client.send(type, payload), mark);
    assert.deepEqual([early.type, early.payload.code], ['command.rejected', 'sync-required'], type);
  }
  await client.sync();
  const own = client.deviceId;
  client.deviceId = 'device-other';
  for (const [type, payload] of [['conversation.read', { throughMessageId: 'message-x' }], ['notification.ack', { notificationId: 'message-x' }]] as const) {
    const mark = client.messages.length;
    const mismatch = await client.reply(client.send(type, payload), mark);
    assert.deepEqual([mismatch.type, mismatch.payload.code], ['command.rejected', 'device-mismatch'], type);
  }
  client.deviceId = own;
  await client.close();
}));
