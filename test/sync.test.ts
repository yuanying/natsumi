import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import WebSocket from 'ws';
import { login, OWNER, startFixture, type Fixture, type FixtureOptions } from './support/server-fixture.ts';

interface Envelope {
  v: number; epoch: string; streamId: string; seq: number; type: string; requestId?: string; payload: Record<string, any>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>, options: FixtureOptions = {}) {
  const f = await startFixture(options);
  try { await fn(f); } finally { await f.cleanup(); }
}

/** A WebSocket client that keeps every message it received, in order. */
class Client {
  readonly messages: Envelope[] = [];
  readonly raw: string[] = [];
  readonly closed: Promise<number>;
  deviceId: string | undefined;
  private readonly ws: WebSocket;
  private counter = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', data => { const text = String(data); this.raw.push(text); this.messages.push(JSON.parse(text) as Envelope); });
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

  async reply(requestId: string, from = 0) {
    return this.until(message => message.requestId === requestId, from);
  }

  async sync(resume: { epoch: string; streamId: string; seq: number } | null = null) {
    const from = this.messages.length;
    const reply = await this.reply(this.send('session.sync', { resume }), from);
    if (typeof reply.payload.deviceId === 'string') this.deviceId = reply.payload.deviceId;
    return reply;
  }

  async sendAndComplete(text: string) {
    const from = this.messages.length;
    const requestId = this.send('conversation.send', { text });
    const accepted = await this.reply(requestId, from);
    assert.equal(accepted.type, 'command.accepted', JSON.stringify(accepted.payload));
    return this.until(m => m.type === 'conversation.turn.completed' && m.payload.turnId === accepted.payload.turnId, from);
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
const conversationEvents = (client: Client) => client.messages
  .filter(m => m.type.startsWith('conversation.')).map(({ type, requestId, payload }) => ({ type, requestId, payload }));

test('two devices receive the same turn, each on its own contiguous stream', () => withFixture(async f => {
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
  assert.deepEqual(snapshotA.payload.history, []);
  assert.equal(snapshotA.payload.activeTurn, null);

  const requestId = a.send('conversation.send', { text: '架空のメッセージ' });
  const reply = await f.model.next();
  reply.delta('こんに');
  reply.delta('ちは');
  reply.finish();
  for (const client of [a, b]) {
    const done = await client.until(m => m.type === 'conversation.turn.completed');
    assert.equal(done.payload.status, 'completed');
    assert.deepEqual(seqs(client.messages), from(1, client.messages.length));
    assert.equal(new Set(client.messages.map(m => m.streamId)).size, 1);
    assert.equal(client.messages.filter(m => m.type === 'conversation.delta').map(m => m.payload.text).join(''), 'こんにちは');
  }
  const accepted = a.messages.find(m => m.type === 'command.accepted');
  assert.equal(accepted?.requestId, requestId);
  const typesA = a.messages.map(m => m.type);
  assert.ok(typesA.indexOf('command.accepted') < typesA.indexOf('conversation.turn.started'));
  // Only the sender gets the command answer, so the other stream's numbers do not move for it.
  assert.equal(b.messages.some(m => m.type === 'command.accepted'), false);
  assert.equal(b.messages.length, a.messages.length - 1);
  assert.deepEqual(conversationEvents(a), conversationEvents(b));
  assert.equal(conversationEvents(a).find(e => e.type === 'conversation.turn.started')?.payload.turnId, accepted?.payload.turnId);

  const row = conversationRow(f);
  for (const text of [...a.raw, ...b.raw]) {
    assert.equal(text.includes(row.pi_session_id), false);
    assert.equal(text.includes(row.pi_session_file), false);
    assert.equal(text.includes(f.root), false);
  }
  await a.close();
  await b.close();
}));

test('a resent requestId never starts a second prompt; a different body and a send while busy are refused', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  await a.sync();
  const first = await a.reply(a.send('conversation.send', { text: 'hello' }, 'request-1'));
  assert.equal(first.type, 'command.accepted');
  const reply = await f.model.next();

  let mark = a.messages.length;
  const again = await a.reply(a.send('conversation.send', { text: 'hello' }, 'request-1'), mark);
  assert.equal(again.type, 'command.accepted');
  assert.equal(again.payload.turnId, first.payload.turnId);
  mark = a.messages.length;
  const conflict = await a.reply(a.send('conversation.send', { text: 'other' }, 'request-1'), mark);
  assert.deepEqual([conflict.type, conflict.payload.code], ['command.rejected', 'request-conflict']);
  mark = a.messages.length;
  const busy = await a.reply(a.send('conversation.send', { text: 'second' }, 'request-2'), mark);
  assert.deepEqual([busy.type, busy.payload.code], ['command.rejected', 'busy']);

  reply.finish();
  await a.until(m => m.type === 'conversation.turn.completed');
  mark = a.messages.length;
  const done = await a.reply(a.send('conversation.send', { text: 'hello' }, 'request-1'), mark);
  assert.deepEqual([done.type, done.payload.turnId, done.payload.state], ['command.accepted', first.payload.turnId, 'completed']);
  assert.equal(f.model.calls, 1);
  await a.close();
}));

test('interrupt stops only the current turn', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  await a.sync();
  const accepted = await a.reply(a.send('conversation.send', { text: 'hello' }));
  const reply = await f.model.next();
  reply.delta('partial');
  await a.until(m => m.type === 'conversation.delta');
  let mark = a.messages.length;
  const other = await a.reply(a.send('conversation.interrupt', { turnId: 'turn-other' }), mark);
  assert.deepEqual([other.type, other.payload.code], ['command.rejected', 'turn-not-active']);
  mark = a.messages.length;
  const stopped = await a.reply(a.send('conversation.interrupt', { turnId: accepted.payload.turnId }), mark);
  assert.equal(stopped.type, 'command.accepted');
  const done = await a.until(m => m.type === 'conversation.turn.completed');
  assert.equal(done.payload.status, 'interrupted');
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

  f.model.auto = () => '応答';
  await b.sendAndComplete('first');
  const back = await Client.open(f, token);
  back.deviceId = a.deviceId;
  const resumed = await back.sync({ epoch: left.epoch, streamId: left.streamId, seq: left.seq });
  assert.equal(resumed.type, 'command.accepted');
  assert.equal(resumed.payload.mode, 'resume');
  const replayed = back.messages.slice(0, -1);
  assert.deepEqual(replayed.map(m => m.type), ['conversation.turn.started', 'conversation.item.completed',
    'conversation.delta', 'conversation.item.completed', 'conversation.turn.completed']);
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
  assert.deepEqual(snapshot.payload.history.filter((item: { role: string }) => item.role === 'user').map((item: { text: string }) => item.text),
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

  f.clock.advance(Date.parse(expiresAt) - f.clock.now);
  mark = client.messages.length;
  client.send('conversation.send', { text: 'hello' });
  assert.equal(await client.closed, 1008);
  assert.equal(client.messages.length, mark);
  assert.equal(f.model.calls, 0);
}));

test('after a server restart the same device resumes the same conversation from a snapshot', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  await a.sync();
  f.model.auto = context => JSON.stringify(context.messages.slice(0, -1)).includes('SYNTHETIC-ORCHID-731') ? 'SYNTHETIC-ORCHID-731' : 'OK';
  await a.sendAndComplete('Remember SYNTHETIC-ORCHID-731');
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
  assert.deepEqual(snapshot.payload.history.map((item: { role: string; text: string }) => [item.role, item.text]),
    [['user', 'Remember SYNTHETIC-ORCHID-731'], ['assistant', 'OK']]);
  const done = await again.sendAndComplete('What was it?');
  assert.equal(done.payload.status, 'completed');
  const answer = await again.until(m => m.type === 'conversation.item.completed' && m.payload.role === 'assistant');
  assert.equal(answer.payload.text, 'SYNTHETIC-ORCHID-731');
  await again.close();
}));

test('a lost session file is reported as unavailable and no new session is started', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  await a.sync();
  f.model.auto = () => 'OK';
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
