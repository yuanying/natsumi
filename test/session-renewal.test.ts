import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { SESSION_TTL_MS } from '../src/server/sessions.ts';
import { login, MINUTE, startFixture, type Fixture } from './support/server-fixture.ts';

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Envelope { seq: number; streamId: string; epoch: string; type: string; requestId?: string; payload: Record<string, any> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const f = await startFixture();
  try { await fn(f); } finally { await f.cleanup(); }
}

/** A client that keeps every message it received, in order. */
class Client {
  readonly messages: Envelope[] = [];
  readonly closed: Promise<number>;
  deviceId: string | undefined;
  private readonly ws: WebSocket;
  private counter = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', data => this.messages.push(JSON.parse(String(data)) as Envelope));
    this.closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  }

  static open(f: Fixture, token: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${token}` } });
      const client = new Client(ws);
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (_request, response) => reject(new Error(`refused with ${response.statusCode}`)));
      ws.once('error', reject);
    });
  }

  async until(predicate: (message: Envelope) => boolean, from = 0): Promise<Envelope> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = this.messages.slice(from).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out; received ${this.messages.map(m => m.type).join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  async sync(resume: { epoch: string; streamId: string; seq: number } | null = null) {
    const from = this.messages.length;
    const requestId = `request-${++this.counter}`;
    this.ws.send(JSON.stringify({ v: 1, requestId, deviceId: this.deviceId, type: 'session.sync', payload: { resume } }));
    const reply = await this.until(m => m.requestId === requestId, from);
    if (typeof reply.payload.deviceId === 'string') this.deviceId = reply.payload.deviceId;
    return reply;
  }

  get open() { return this.ws.readyState === WebSocket.OPEN; }

  close() { this.ws.close(); return this.closed; }
}

const endAt = (now: number) => new Date(now + SESSION_TTL_MS).toISOString();
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

test('connecting renews the session, and the answer to the sync tells the client its new end', () => withFixture(async f => {
  const { token, expiresAt } = await login(f);
  assert.equal(expiresAt, endAt(f.clock.now));
  f.clock.advance(2 * HOUR);

  const client = await Client.open(f, token);
  const snapshot = await client.sync();
  assert.equal(snapshot.type, 'session.snapshot');
  assert.equal(snapshot.payload.sessionExpiresAt, endAt(f.clock.now));

  // A resumed stream is answered with command.accepted, which carries the end too.
  const position = { epoch: snapshot.epoch, streamId: snapshot.streamId, seq: snapshot.seq };
  await client.close();
  f.clock.advance(2 * HOUR);
  const again = await Client.open(f, token);
  again.deviceId = client.deviceId;
  const resumed = await again.sync(position);
  assert.deepEqual([resumed.type, resumed.payload.mode], ['command.accepted', 'resume']);
  assert.equal(resumed.payload.sessionExpiresAt, endAt(f.clock.now));
  await again.close();
}));

test('a connection that stays open keeps its session alive and hears each renewal without a number', () => withFixture(async f => {
  const { token } = await login(f);
  const client = await Client.open(f, token);
  const snapshot = await client.sync();

  // Within the hour nothing is written, so nothing is said.
  f.clock.advance(30 * MINUTE);
  f.server.expireSessions();
  await settle();
  assert.equal(client.messages.length, 1);

  for (let day = 1; day <= 45; day += 1) {
    f.clock.advance(DAY);
    f.server.expireSessions();
  }
  const renewed = await client.until(m => m.type === 'session.renewed');
  await settle();
  const renewals = client.messages.filter(m => m.type === 'session.renewed');
  assert.equal(renewals.length, 45);
  assert.equal(renewals.at(-1)!.payload.expiresAt, endAt(f.clock.now));
  assert.deepEqual(Object.keys(renewed.payload), ['expiresAt']);
  // Of the moment: it carries the number the stream is at and never takes one, like the line of thinking.
  for (const renewal of renewals) assert.deepEqual([renewal.streamId, renewal.seq], [snapshot.streamId, snapshot.seq]);
  assert.ok(client.open, 'the connection outlived the thirty days since login');

  // The session it kept alive still lets the client in.
  const later = await Client.open(f, token);
  await later.close();
  await client.close();
}));

test('a renewal on another connection of the same session reaches this one too', () => withFixture(async f => {
  const { token } = await login(f);
  const a = await Client.open(f, token);
  await a.sync();
  f.clock.advance(2 * HOUR);
  const b = await Client.open(f, token);
  const answer = await b.sync();
  f.server.expireSessions();
  const renewed = await a.until(m => m.type === 'session.renewed');
  assert.equal(renewed.payload.expiresAt, answer.payload.sessionExpiresAt);
  await a.close();
  await b.close();
}));

test('a sweep that finds the session past its end closes the connection instead of renewing it', () => withFixture(async f => {
  const { token } = await login(f);
  const client = await Client.open(f, token);
  await client.sync();
  f.clock.advance(SESSION_TTL_MS + MINUTE);
  f.server.expireSessions();
  assert.equal(await client.closed, 1008);
  assert.equal(client.messages.some(m => m.type === 'session.renewed'), false);
  await assert.rejects(Client.open(f, token), /refused with 401/);
}));

test('logging out still ends the session at once, and it is never renewed again', () => withFixture(async f => {
  const { token } = await login(f);
  const client = await Client.open(f, token);
  await client.sync();
  const response = await f.fetch('/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 204);
  assert.equal(await client.closed, 1008);
  f.clock.advance(2 * HOUR);
  f.server.expireSessions();
  await assert.rejects(Client.open(f, token), /refused with 401/);
}));
