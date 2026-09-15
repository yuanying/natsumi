import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { login, MINUTE, OWNER, PUBLIC_ORIGIN, startFixture, type Fixture } from './support/server-fixture.ts';

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const f = await startFixture();
  try { await fn(f); } finally { await f.cleanup(); }
}

type Attempt = { open: true; ws: WebSocket } | { open: false; status: number };

function connect(url: string, headers: Record<string, string> = {}): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve({ open: true, ws }));
    ws.once('unexpected-response', (_req, res) => { resolve({ open: false, status: res.statusCode ?? 0 }); res.resume(); ws.terminate(); });
    ws.once('error', error => reject(error));
  });
}

async function connected(url: string, headers: Record<string, string>) {
  const attempt = await connect(url, headers);
  assert.ok(attempt.open, `refused with ${attempt.open ? '' : attempt.status}`);
  return attempt.ws;
}

const nextMessage = (ws: WebSocket) => new Promise<Record<string, any>>(resolve => {
  ws.once('message', data => resolve(JSON.parse(String(data))));
});
const closed = (ws: WebSocket) => new Promise<number>(resolve => ws.once('close', code => resolve(code)));

test('an authenticated client connects', () => withFixture(async f => {
  const { token } = await login(f);
  const ws = await connected(f.wsUrl, { authorization: `Bearer ${token}` });
  ws.close();
}));

test('an upgrade without a valid session is refused before the connection is established', () => withFixture(async f => {
  const refused = async (headers: Record<string, string>, url = f.wsUrl) => {
    const attempt = await connect(url, headers);
    assert.equal(attempt.open, false);
    return attempt.open ? 0 : attempt.status;
  };
  assert.equal(await refused({}), 401);
  assert.equal(await refused({ authorization: 'Bearer fixture-bogus-token' }), 401);
  assert.equal(await refused({ authorization: 'Basic Zm9vOmJhcg==' }), 401);
  // A device ID is not a credential.
  assert.equal(await refused({ 'x-natsumi-device-id': 'device-example' }, `${f.wsUrl}?deviceId=device-example`), 401);

  const revoked = await login(f);
  await f.fetch('/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${revoked.token}` } });
  assert.equal(await refused({ authorization: `Bearer ${revoked.token}` }), 401);

  const expired = await login(f);
  f.clock.advance(Date.parse(expired.expiresAt) - f.clock.now);
  assert.equal(await refused({ authorization: `Bearer ${expired.token}` }), 401);
}));

test('a session of an account that is no longer allowed cannot connect', () => withFixture(async f => {
  const { token } = await login(f);
  await f.restart(OWNER.id + 1);
  const attempt = await connect(f.wsUrl, { authorization: `Bearer ${token}` });
  assert.deepEqual(attempt, { open: false, status: 401 });
}));

test('a foreign Origin is refused; the public origin and native clients without Origin are accepted', () => withFixture(async f => {
  const { token } = await login(f);
  const auth = { authorization: `Bearer ${token}` };
  assert.deepEqual(await connect(f.wsUrl, { ...auth, origin: 'https://attacker.example.test' }), { open: false, status: 403 });
  assert.deepEqual(await connect(f.wsUrl, { ...auth, origin: 'null' }), { open: false, status: 403 });
  (await connected(f.wsUrl, { ...auth, origin: PUBLIC_ORIGIN })).close();
  (await connected(f.wsUrl, auth)).close();
}));

test('only the WebSocket path upgrades', () => withFixture(async f => {
  const { token } = await login(f);
  const attempt = await connect(f.wsUrl.replace('/v1/ws', '/other'), { authorization: `Bearer ${token}` });
  assert.deepEqual(attempt, { open: false, status: 404 });
}));

test('an envelope whose version is not 1 is rejected and the connection is closed', () => withFixture(async f => {
  const { token } = await login(f);
  for (const envelope of [{ v: 2, requestId: 'r1', type: 'conversation.send', payload: {} }, { requestId: 'r1', type: 'conversation.send' }]) {
    const ws = await connected(f.wsUrl, { authorization: `Bearer ${token}` });
    const reply = nextMessage(ws);
    const code = closed(ws);
    ws.send(JSON.stringify(envelope));
    const message = await reply;
    assert.equal(message.type, 'command.rejected');
    assert.equal(message.payload.code, 'unsupported-version');
    assert.equal(await code, 1002);
  }
  const ws = await connected(f.wsUrl, { authorization: `Bearer ${token}` });
  const reply = nextMessage(ws);
  const code = closed(ws);
  ws.send('not json');
  assert.equal((await reply).payload.code, 'invalid-envelope');
  assert.equal(await code, 1007);
}));

test('unknown event types are ignored and unimplemented commands get a safe rejection', () => withFixture(async f => {
  const { token } = await login(f);
  const ws = await connected(f.wsUrl, { authorization: `Bearer ${token}` });
  const first = nextMessage(ws);
  ws.send(JSON.stringify({ v: 1, requestId: 'r0', deviceId: 'device-example', type: 'future.event', payload: {} }));
  ws.send(JSON.stringify({ v: 1, requestId: 'r1', deviceId: 'device-example', type: 'approval.decide', payload: { approvalId: 'approval-example' } }));
  const message = await first;
  assert.equal(message.v, 1);
  assert.equal(message.type, 'command.rejected');
  assert.equal(message.requestId, 'r1');
  assert.equal(message.payload.code, 'not-implemented');
  assert.equal(typeof message.epoch, 'string');
  assert.equal(typeof message.streamId, 'string');
  assert.equal(message.seq, 1);
  assert.deepEqual(Object.keys(message.payload), ['code']);

  const second = nextMessage(ws);
  ws.send(JSON.stringify({ v: 1, requestId: 'r2', type: 'notification.ack', payload: {} }));
  assert.equal((await second).seq, 2);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
}));

test('logout and session expiry close open connections', () => withFixture(async f => {
  const a = await login(f);
  const ws = await connected(f.wsUrl, { authorization: `Bearer ${a.token}` });
  const code = closed(ws);
  await f.fetch('/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(await code, 1008);

  const b = await login(f);
  const other = await connected(f.wsUrl, { authorization: `Bearer ${b.token}` });
  const otherCode = closed(other);
  f.clock.advance(Date.parse(b.expiresAt) - f.clock.now + MINUTE);
  f.server.expireSessions();
  assert.equal(await otherCode, 1008);
}));
