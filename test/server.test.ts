import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCli, UsageError } from '../src/server/cli.ts';
import { checkHealth, readStatus } from '../src/server/status.ts';
import { startServer } from '../src/server/server.ts';

const main = new URL('../src/server/main.ts', import.meta.url).pathname;

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-server-')));
  const data = join(root, 'data');
  await mkdir(data);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ pi: {
    agentDirectory: join(root, 'pi', 'agent'), sessionDirectory: join(root, 'pi', 'sessions'),
    authPath: join(root, 'pi', 'agent', 'auth.json'), model: { provider: 'openai-codex', id: 'gpt-5.5' }, voiceEnabled: false,
  } }));
  return { root, data, config, home: join(root, 'home'), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function run(args: string[], cwd: string, home: string) {
  const child = spawn(process.execPath, [main, ...args], { cwd, env: { PATH: process.env.PATH, HOME: home } });
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

test('startup initializes, locks, migrates and prepares Pi state; stop releases everything', async () => {
  const f = await setup();
  try {
    const server = await startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home });
    assert.equal(server.dataDirectory, f.data);
    assert.ok(server.schemaVersion >= 1);
    assert.equal((await readStatus(f.data))?.state, 'running');
    await assert.rejects(startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home }), /already running/);
    await server.stop();
    await server.stop();
    assert.equal((await readStatus(f.data))?.state, 'stopped');
    const again = await startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home });
    await again.stop();
  } finally { await f.cleanup(); }
});

test('an invalid config stops startup before the data directory is touched', async () => {
  const f = await setup();
  try {
    await writeFile(f.config, JSON.stringify({ pi: { apiKey: 'fixture-secret-value' } }));
    await assert.rejects(startServer({ config: f.config, dataDir: f.data, cwd: '/', home: f.home }), /pi\.apiKey/);
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
