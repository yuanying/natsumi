import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { parseCli, UsageError } from '../src/server/cli.ts';
import { checkHealth, readStatus } from '../src/server/status.ts';
import { startServer } from '../src/server/server.ts';
import { CLIENT_SECRET, serverConfig } from './support/server-fixture.ts';

const main = new URL('../src/server/main.ts', import.meta.url).pathname;
const env = { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET };

async function setup(listen?: unknown) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-server-')));
  const data = join(root, 'data');
  await mkdir(data);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify(serverConfig(root, { listen })));
  return { root, data, config, env, home: join(root, 'home'), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function run(args: string[], cwd: string, home: string) {
  const child = spawn(process.execPath, [main, ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, ...env } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  return { child, exited, stderr: () => stderr };
}

async function waitFor(check: () => Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('the command line selects serve or health and refuses anything else', () => {
  assert.deepEqual(parseCli(['serve', '--config', 'c.json', '--data-dir', '/d']), { command: 'serve', config: 'c.json', dataDir: '/d' });
  assert.deepEqual(parseCli(['serve']), { command: 'serve', config: 'config.local.json', dataDir: undefined });
  assert.deepEqual(parseCli(['health', '--data-dir', '/d']), { command: 'health', dataDir: '/d' });
  for (const argv of [[], ['listen'], ['serve', '--port', '8080'], ['serve', 'extra']]) {
    assert.throws(() => parseCli(argv), UsageError);
  }
});

test('startup initializes, locks, migrates, prepares Pi state and listens; stop releases everything', async () => {
  const f = await setup();
  try {
    const server = await startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home, env: f.env });
    assert.equal(server.dataDirectory, f.data);
    assert.ok(server.schemaVersion >= 2);
    assert.equal((await readStatus(f.data))?.state, 'running');
    const url = `http://127.0.0.1:${server.address.port}/nothing-here`;
    assert.equal((await fetch(url)).status, 404);
    await assert.rejects(startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home, env: f.env }), /already running/);
    await server.stop();
    await server.stop();
    assert.equal((await readStatus(f.data))?.state, 'stopped');
    await assert.rejects(fetch(url), 'the listener is closed');
    const again = await startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home, env: f.env });
    await again.stop();
  } finally { await f.cleanup(); }
});

test('a listener that cannot start releases the lock', async () => {
  const f = await setup();
  try {
    const first = await startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home, env: f.env });
    const other = join(f.root, 'other');
    await mkdir(other);
    await writeFile(f.config, JSON.stringify(serverConfig(f.root, { listen: { host: '127.0.0.1', port: first.address.port, tls: false } })));
    await assert.rejects(startServer({ config: f.config, dataDir: other, cwd: '/', home: f.home, env: f.env }), /listen/);
    await first.stop();
    const again = await startServer({ config: f.config, dataDir: other, cwd: '/', home: f.home, env: f.env });
    await again.stop();
  } finally { await f.cleanup(); }
});

test('an invalid config stops startup before the data directory is touched', async () => {
  const f = await setup();
  try {
    await writeFile(f.config, JSON.stringify({ pi: { apiKey: 'fixture-secret-value' } }));
    await assert.rejects(startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home, env: f.env }), /pi\.apiKey/);
    await assert.rejects(readFile(join(f.data, 'personality.md')));
  } finally { await f.cleanup(); }
});

test('health reports running only while the heartbeat is fresh', () => {
  const now = Date.parse('2026-01-01T00:01:00Z');
  const status = (state: 'running' | 'stopped', at: string) => ({ state, pid: 1, startedAt: at, updatedAt: at, schemaVersion: 1 });
  assert.equal(checkHealth(status('running', '2026-01-01T00:00:50Z'), now).healthy, true);
  assert.equal(checkHealth(status('running', '2026-01-01T00:00:00Z'), now).healthy, false);
  assert.equal(checkHealth(status('stopped', '2026-01-01T00:00:59Z'), now).healthy, false);
  assert.equal(checkHealth(undefined, now).healthy, false);
});

test('the process serves until SIGTERM, refuses a duplicate, and exits cleanly', async () => {
  const f = await setup();
  try {
    const server = run(['serve', '--config', f.config], f.data, f.home);
    await waitFor(async () => (await readStatus(f.data))?.state === 'running');

    const health = run(['health'], f.data, f.home);
    assert.equal(await health.exited, 0);

    const duplicate = run(['serve', '--config', f.config, '--data-dir', f.data], '/', f.home);
    assert.equal(await duplicate.exited, 1);
    assert.match(duplicate.stderr(), /already running/);

    server.child.kill('SIGTERM');
    assert.equal(await server.exited, 0, server.stderr());
    assert.equal((await readStatus(f.data))?.state, 'stopped');
    assert.equal(await run(['health', '--data-dir', f.data], '/', f.home).exited, 1);
  } finally { await f.cleanup(); }
});

test('startup errors are reported on stderr with a non-zero exit', async () => {
  const f = await setup();
  try {
    const missing = run(['serve', '--config', join(f.root, 'missing.json'), '--data-dir', f.data], '/', f.home);
    assert.equal(await missing.exited, 1);
    assert.match(missing.stderr(), /config.*cannot read/);
    const usage = run(['serve', '--port', '1'], '/', f.home);
    assert.equal(await usage.exited, 2);
  } finally { await f.cleanup(); }
});

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('with TLS configured, HTTPS and WSS are served on IPv6', { skip: !hasOpenssl && 'openssl is not available' }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-tls-')));
  const certFile = join(root, 'cert.pem');
  const keyFile = join(root, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=natsumi.example.test', '-addext', 'subjectAltName=IP:::1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const f = await setup({ host: '::1', port: 0, tls: { certFile, keyFile } });
  try {
    const server = await startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home, env: f.env });
    const ca = await readFile(certFile);
    try {
      const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        get(`https://[::1]:${server.address.port}/nothing-here`, { ca }, resolve).on('error', reject);
      });
      res.resume();
      assert.equal(res.statusCode, 404);
      assert.match(String(res.headers['strict-transport-security']), /max-age=/);

      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`wss://[::1]:${server.address.port}/v1/ws`, { ca });
        ws.once('unexpected-response', (_req, r) => { resolve(r.statusCode ?? 0); r.resume(); ws.terminate(); });
        ws.once('open', () => { ws.close(); reject(new Error('connected without a session')); });
        ws.once('error', reject);
      });
      assert.equal(status, 401);
    } finally { await server.stop(); }
  } finally { await f.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test('a missing TLS certificate stops startup without echoing its path', async () => {
  const f = await setup({ host: '::1', port: 0, tls: { certFile: '/nonexistent/natsumi-cert.pem', keyFile: '/nonexistent/natsumi-key.pem' } });
  try {
    await assert.rejects(startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home, env: f.env }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /listen\.tls\.certFile/);
      assert.doesNotMatch(error.message, /nonexistent/);
      return true;
    });
    // The lock was released: a corrected config starts.
    await writeFile(f.config, JSON.stringify(serverConfig(f.root)));
    await (await startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home, env: f.env })).stop();
  } finally { await f.cleanup(); }
});
