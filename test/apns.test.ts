import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import test from 'node:test';
import { APNS_ORIGINS, ApnsClient, ApnsToken, JWT_LIFETIME_MS, parseApnsKey, signApnsJwt } from '../src/server/apns.ts';
import { apnsTestKey, FakeApns } from './support/fake-apns.ts';

const TEAM_ID = 'TEAM000001';
const KEY_ID = 'KEY0000001';
const TOPIC = 'net.example.natsumi';
const DEVICE_TOKEN = 'a1'.repeat(32);

const part = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split('.')[i]!, 'base64url').toString());

test('the provider token is an ES256 JWT with the key ID, the team as issuer and the issue time in seconds', () => {
  const { pem, publicKey } = apnsTestKey();
  const jwt = signApnsJwt({ teamId: TEAM_ID, keyId: KEY_ID, key: parseApnsKey(pem)!, issuedAt: Date.parse('2026-01-01T00:00:10.900Z') });
  const [header, claims, signature] = jwt.split('.');
  assert.deepEqual(part(jwt, 0), { alg: 'ES256', kid: KEY_ID });
  assert.deepEqual(part(jwt, 1), { iss: TEAM_ID, iat: Date.parse('2026-01-01T00:00:10Z') / 1000 });
  const raw = Buffer.from(signature!, 'base64url');
  assert.equal(raw.length, 64, 'JOSE signatures are r ‖ s, not DER');
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw));
});

test('the provider token is reused for 50 minutes and made again after', () => {
  const { pem } = apnsTestKey();
  let now = Date.parse('2026-01-01T00:00:00Z');
  const tokens = new ApnsToken({ teamId: TEAM_ID, keyId: KEY_ID, key: parseApnsKey(pem)!, now: () => now });
  assert.equal(JWT_LIFETIME_MS, 50 * 60_000);
  const first = tokens.current();
  now += JWT_LIFETIME_MS - 1;
  assert.equal(tokens.current(), first);
  now += 1;
  const second = tokens.current();
  assert.notEqual(second, first);
  assert.equal(part(second, 1).iat, Date.parse('2026-01-01T00:50:00Z') / 1000);
});

test('only an EC P-256 private key in PEM is taken as the signing key', () => {
  assert.ok(parseApnsKey(apnsTestKey().pem));
  assert.equal(parseApnsKey('not a key'), undefined);
  assert.equal(parseApnsKey(''), undefined);
});

test('the APNs hosts are the sandbox and production ones', () => {
  assert.deepEqual(APNS_ORIGINS, { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' });
});

async function withApns(fn: (apns: { sandbox: FakeApns; production: FakeApns; client: ApnsClient; publicKey: import('node:crypto').KeyObject }) => Promise<void>) {
  const sandbox = await new FakeApns().start();
  const production = await new FakeApns().start();
  const { pem, publicKey } = apnsTestKey();
  const client = new ApnsClient({ teamId: TEAM_ID, keyId: KEY_ID, topic: TOPIC, key: parseApnsKey(pem)!, now: Date.now,
    origins: { sandbox: sandbox.origin, production: production.origin } });
  try { await fn({ sandbox, production, client, publicKey }); } finally {
    client.close();
    await sandbox.close();
    await production.close();
  }
}

test('an alert goes to /3/device/<token> with the push type, priority 10, topic, ID and bearer token', () => withApns(async ({ sandbox, client, publicKey }) => {
  const payload = { aps: { alert: { title: 't', body: 'b' } } };
  const result = await client.send({ environment: 'sandbox', token: DEVICE_TOKEN, pushType: 'alert', payload, id: '6d1a2c1e-0000-4000-8000-000000000001' });
  assert.deepEqual(result, { status: 200 });
  const { headers, body } = sandbox.received[0]!;
  assert.equal(headers[':method'], 'POST');
  assert.equal(headers[':path'], `/3/device/${DEVICE_TOKEN}`);
  assert.equal(headers['apns-push-type'], 'alert');
  assert.equal(headers['apns-priority'], '10');
  assert.equal(headers['apns-topic'], TOPIC);
  assert.equal(headers['apns-id'], '6d1a2c1e-0000-4000-8000-000000000001');
  assert.equal(headers['content-type'], 'application/json');
  const jwt = String(headers.authorization).replace(/^bearer /, '');
  const [h, c, s] = jwt.split('.');
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url')));
  assert.deepEqual(body, payload);
}));

test('a background push has priority 5 and push type background', () => withApns(async ({ production, client }) => {
  await client.send({ environment: 'production', token: DEVICE_TOKEN, pushType: 'background', payload: { aps: { 'content-available': 1 } } });
  const { headers } = production.received[0]!;
  assert.equal(headers['apns-push-type'], 'background');
  assert.equal(headers['apns-priority'], '5');
  assert.equal(headers['apns-topic'], TOPIC);
}));

test('the environment picks the host, and one connection per host is reused', () => withApns(async ({ sandbox, production, client }) => {
  const push = { token: DEVICE_TOKEN, pushType: 'background' as const, payload: {} };
  await client.send({ ...push, environment: 'sandbox' });
  await client.send({ ...push, environment: 'production' });
  await client.send({ ...push, environment: 'sandbox' });
  assert.equal(sandbox.received.length, 2);
  assert.equal(production.received.length, 1);
  assert.equal(sandbox.connections, 1);
  assert.equal(production.connections, 1);
}));

test('an error answer gives its status and APNs reason', () => withApns(async ({ sandbox, client }) => {
  sandbox.answers.push({ status: 410, reason: 'Unregistered' }, { status: 400, reason: 'BadDeviceToken' }, { status: 503 });
  const push = { environment: 'sandbox' as const, token: DEVICE_TOKEN, pushType: 'alert' as const, payload: {} };
  assert.deepEqual(await client.send(push), { status: 410, reason: 'Unregistered' });
  assert.deepEqual(await client.send(push), { status: 400, reason: 'BadDeviceToken' });
  assert.deepEqual(await client.send(push), { status: 503 });
}));

test('a host that cannot be reached rejects', () => withApns(async ({ sandbox, client }) => {
  await sandbox.close();
  await assert.rejects(client.send({ environment: 'sandbox', token: DEVICE_TOKEN, pushType: 'alert', payload: {} }));
}));

test('a connection the host dropped is replaced on the next send', () => withApns(async ({ sandbox, client }) => {
  const push = { environment: 'sandbox' as const, token: DEVICE_TOKEN, pushType: 'alert' as const, payload: {} };
  assert.deepEqual(await client.send(push), { status: 200 });
  for (const session of sandbox.sessions) session.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await client.send(push), { status: 200 });
  assert.equal(sandbox.connections, 2);
}));
