import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireProcessLock, LockError } from '../src/server/lock.ts';

async function withDataDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'natsumi-lock-'));
  await mkdir(join(dir, '.natsumi'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function holdInChild(dir: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./support/lock-holder.ts', import.meta.url), [dir], { silent: true });
    child.once('message', () => resolve(child));
    child.once('exit', code => reject(new Error(`lock holder exited ${code}`)));
  });
}

function kill(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  return new Promise(resolve => { child.once('exit', () => resolve()); child.kill(signal); });
}

test('a second holder of the same data directory is refused', () => withDataDir(async dir => {
  const first = acquireProcessLock(dir);
  try {
    assert.throws(() => acquireProcessLock(dir), (error: unknown) => error instanceof LockError && /already running/.test(error.message));
  } finally { first.release(); }
  acquireProcessLock(dir).release();
}));

test('another process cannot start while the lock is held', () => withDataDir(async dir => {
  const child = await holdInChild(dir);
  try {
    assert.throws(() => acquireProcessLock(dir), /already running/);
  } finally { await kill(child, 'SIGTERM'); }
}));

test('the lock left by a crashed process is recovered without manual cleanup', () => withDataDir(async dir => {
  const child = await holdInChild(dir);
  await kill(child, 'SIGKILL');
  const lock = acquireProcessLock(dir);
  lock.release();
}));

test('release is idempotent', () => withDataDir(async dir => {
  const lock = acquireProcessLock(dir);
  lock.release();
  lock.release();
}));

test('a foreign file at the lock path is not treated as a free lock', () => withDataDir(async dir => {
  await writeFile(join(dir, '.natsumi', 'server.lock'), 'not a lock');
  assert.throws(() => acquireProcessLock(dir), (error: unknown) => error instanceof LockError && /server\.lock/.test(error.message));
}));
