import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startFixture, type Fixture, type FixtureOptions } from './support/server-fixture.ts';

/**
 * The way in for Alertmanager (ADR 0086): `POST /v1/alertmanager/<sender>` with the sender's own bearer token, a body of
 * at most 1 MiB that is JSON in Alertmanager's shape, answered with a 2xx only once what came is written under
 * `/sources/alertmanager/<sender>/`. Without the config there is no such way in at all.
 */

// Fictional values only.
const FRACTION_TOKEN = 'fixture-alertmanager-fraction-7c1d';
const TEST_TOKEN = 'fixture-alertmanager-test-2b9e';

const senders: FixtureOptions = {
  alertmanager: async root => {
    await writeFile(join(root, 'fraction-token'), `${FRACTION_TOKEN}\n`);
    await writeFile(join(root, 'test-token'), TEST_TOKEN);
    return { senders: [{ name: 'fraction', tokenFile: join(root, 'fraction-token') }, { name: 'test', tokenFile: join(root, 'test-token') }] };
  },
};

async function withFixture(fn: (f: Fixture) => Promise<void>, options: FixtureOptions = senders) {
  const f = await startFixture(options);
  try { await fn(f); } finally { await f.cleanup(); }
}

const firing = (fingerprint: string, severity = 'warning') => ({
  version: '4', groupKey: '{}:{alertname="KubePodCrashLooping"}', status: 'firing', receiver: 'natsumi',
  alerts: [{
    status: 'firing', labels: { alertname: 'KubePodCrashLooping', severity }, annotations: { summary: 'Pod is crash looping.' },
    startsAt: '2025-12-31T23:50:00Z', endsAt: '0001-01-01T00:00:00Z', generatorURL: 'https://prometheus.example.test/graph', fingerprint,
  }],
});

function post(f: Fixture, sender: string, body: string, headers: Record<string, string> = {}) {
  return f.fetch(`/v1/alertmanager/${sender}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('a notification is taken with its sender’s token, and written before the answer', () => withFixture(async f => {
  const res = await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json(), { recorded: 1 });
  const day = await readFile(join(f.data, 'sources', 'alertmanager', 'fraction', '2026-01-01.jsonl'), 'utf8');
  assert.deepEqual(day.trim().split('\n').map(line => JSON.parse(line).fingerprint), ['a1']);
  assert.equal((await post(f, 'test', JSON.stringify(firing('a1')), bearer(TEST_TOKEN))).status, 200);
  assert.equal((await f.fetch('/v1/alertmanager/fraction', { headers: bearer(FRACTION_TOKEN) })).status, 404, 'a POST only');
}));

test('an unknown sender, a wrong token and no token are the same 401', () => withFixture(async f => {
  const body = JSON.stringify(firing('a1'));
  const refusals = [
    await post(f, 'fraction', body, bearer(TEST_TOKEN)),
    await post(f, 'fraction', body, bearer(`${FRACTION_TOKEN}x`)),
    await post(f, 'fraction', body),
    await post(f, 'fraction', body, { authorization: FRACTION_TOKEN }),
    await post(f, 'elsewhere', body, bearer(FRACTION_TOKEN)),
    await post(f, 'a%2Fb', body, bearer(FRACTION_TOKEN)),
  ];
  for (const res of refusals) assert.deepEqual([res.status, res.text], [401, '{"error":"unauthorized"}']);
  assert.equal(f.seen.some(text => text.includes(FRACTION_TOKEN) || text.includes('fraction-token')), false);
  await assert.rejects(readFile(join(f.data, 'sources', 'alertmanager', 'fraction', '2026-01-01.jsonl')), 'nothing was written');
}));

test('the browser’s login does not let a notification in', () => withFixture(async f => {
  const res = await post(f, 'fraction', JSON.stringify(firing('a1')), { cookie: 'natsumi_session=fixture-anything' });
  assert.equal(res.status, 401);
}));

test('a body past 1 MiB is refused, and one that is not a notification is a 400', () => withFixture(async f => {
  const auth = bearer(FRACTION_TOKEN);
  const large = JSON.stringify({ ...firing('a1'), padding: 'x'.repeat(1024 * 1024) });
  assert.deepEqual([(await post(f, 'fraction', large, auth)).status], [413]);
  for (const body of ['{"alerts": [', 'null', '{"alerts": "none"}', JSON.stringify({ alerts: [{ status: 'firing' }] })]) {
    const res = await post(f, 'fraction', body, auth);
    assert.deepEqual([res.status, res.json().error], [400, 'invalid-request'], body);
  }
  assert.equal((await post(f, 'fraction', JSON.stringify(firing('a1')), auth)).status, 200, 'the sender is not shut out after it');
}));

test('what cannot be written is a 5xx, for Alertmanager to send again', () => withFixture(async f => {
  await mkdir(join(f.data, 'sources', 'alertmanager'), { recursive: true });
  await writeFile(join(f.data, 'sources', 'alertmanager', 'fraction'), 'not a directory');
  const failed = await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN));
  assert.equal(failed.status >= 500 && failed.status < 600, true, String(failed.status));
  await rm(join(f.data, 'sources', 'alertmanager', 'fraction'));
  assert.equal((await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN))).status, 200);
  const day = await readFile(join(f.data, 'sources', 'alertmanager', 'fraction', '2026-01-01.jsonl'), 'utf8');
  assert.equal(day.trim().split('\n').length, 1);
}));

test('without the config there is no way in', () => withFixture(async f => {
  assert.equal((await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN))).status, 404);
}, {}));

test('a notification sent again after a restart writes nothing', () => withFixture(async f => {
  await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN));
  await f.restart(4242001);
  const again = await post(f, 'fraction', JSON.stringify(firing('a1')), bearer(FRACTION_TOKEN));
  assert.deepEqual([again.status, again.json()], [200, { recorded: 0 }]);
}));

test('a token file that cannot be read stops the start, naming the setting only', async () => {
  await assert.rejects(startFixture({ alertmanager: async root => ({ senders: [{ name: 'fraction', tokenFile: join(root, 'missing') }] }) }),
    (error: Error) => error.message.includes('alertmanager.senders[0].tokenFile') && !error.message.includes('missing'));
});
