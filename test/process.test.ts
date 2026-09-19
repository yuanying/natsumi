import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPATIBLE_KEY_ENV } from '../src/pi/auth.ts';
import { exerciseRestart, runChild } from '../src/probe/process.ts';

test('two separate Pi SDK processes create and resume the same persisted session', async () => {
  await exerciseRestart(new URL('./support/worker.ts', import.meta.url), JSON.stringify({ kind: 'fixture' }));
});

test('worker crash cannot be mistaken for a completed conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-crash-fixture-'));
  try {
    const script = join(root, 'worker.mjs');
    await writeFile(script, 'process.exit(1)');
    await assert.rejects(runChild(pathToFileURL(script), [], root), /worker failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a stalled worker is killed at the deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-timeout-fixture-'));
  try {
    const script = join(root, 'worker.mjs');
    await writeFile(script, 'setInterval(() => {}, 1000)');
    await assert.rejects(runChild(pathToFileURL(script), [], root, 100), /timeout/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the worker gets only the compatible key env, not other provider keys or the real HOME', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-env-fixture-'));
  const saved = { key: process.env[COMPATIBLE_KEY_ENV], openai: process.env.OPENAI_API_KEY };
  try {
    const script = join(root, 'worker.mjs');
    await writeFile(script, `process.send({ key: process.env.${COMPATIBLE_KEY_ENV} ?? null,
      openai: process.env.OPENAI_API_KEY ?? null, home: process.env.HOME }); process.disconnect();`);
    process.env[COMPATIBLE_KEY_ENV] = 'fixture-key';
    process.env.OPENAI_API_KEY = 'fixture-openai';
    assert.deepEqual(await runChild(pathToFileURL(script), [], root), { key: 'fixture-key', openai: null, home: root });
    delete process.env[COMPATIBLE_KEY_ENV];
    assert.deepEqual(await runChild(pathToFileURL(script), [], root), { key: null, openai: null, home: root });
  } finally {
    for (const [name, value] of [[COMPATIBLE_KEY_ENV, saved.key], ['OPENAI_API_KEY', saved.openai]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
