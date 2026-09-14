import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { RpcClient } from '../src/rpc.ts';

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  output.on('data', chunk => sent.push(JSON.parse(String(chunk))));
  const client = new RpcClient(input, output, 100);
  return { input, output, sent, client, send: (message: unknown) => input.write(JSON.stringify(message) + '\n') };
}

test('matches out-of-order replies and fragmented lines; retains early notification', async () => {
  const f = fixture();
  const first = f.client.request('thread/start', {});
  const second = f.client.request('thread/read', {});
  f.send({ id: f.sent[1]!.id, result: { second: true } });
  f.input.write('{"method":"turn/completed","params":');
  f.input.write('{"turn":{"id":"t1"}}}\n');
  f.send({ id: f.sent[0]!.id, result: { first: true } });
  assert.deepEqual(await first, { first: true });
  assert.deepEqual(await second, { second: true });
  assert.equal((await f.client.waitFor(n => n.method === 'turn/completed')).method, 'turn/completed');
  f.client.close();
});

test('RPC errors expose codes without leaking provider messages', async () => {
  const f = fixture();
  const promise = f.client.request('thread/read', {});
  f.send({ id: f.sent[0]!.id, error: { code: -32602, message: 'private provider detail' } });
  await assert.rejects(promise, { message: 'RPC error -32602' });
  f.client.close();
});

test('disconnect rejects pending requests and notification waits', async () => {
  const f = fixture();
  const results = Promise.allSettled([f.client.request('thread/start', {}), f.client.waitFor(() => true)]);
  f.input.end();
  for (const result of await results) assert.equal(result.status, 'rejected');
  await assert.rejects(f.client.request('thread/read', {}), /closed/);
});

test('request and event timeouts do not accept late replies', async () => {
  const f = fixture();
  await assert.rejects(f.client.request('thread/read', {}, 10), /timeout/);
  f.send({ id: f.sent[0]!.id, result: 'late' });
  await assert.rejects(f.client.waitFor(() => true, 10), /timeout/);
  f.client.close();
});

test('malformed protocol closes pending work without exposing raw data', async () => {
  for (const line of ['secret garbage', 'null', '{"id":1}']) {
    const f = fixture();
    const pending = f.client.request('thread/start', {});
    f.input.write(line + '\n');
    await assert.rejects(pending, { message: 'Invalid protocol frame' });
  }
});

test('server requests receive an explicit rejection; never execute tools', async () => {
  const f = fixture();
  f.send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {} });
  assert.deepEqual(f.sent[0], { id: 'approval-1', error: { code: -32601, message: 'Probe does not execute server requests' } });
  f.client.close();
});

test('bounds queued notifications and closes on overflow', async () => {
  const f = fixture();
  const pending = f.client.request('thread/start', {});
  for (let i = 0; i < 1025; i++) f.send({ method: 'event', params: {} });
  await assert.rejects(pending, /overflow/);
});
