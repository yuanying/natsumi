import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeFileAtomically } from '../src/server/paths.ts';

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-paths-')));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

test('a file is written with the mode asked for and nothing is left beside it', () => withRoot(async root => {
  const path = join(root, 'status.json');
  await writeFileAtomically(path, 'first\n', 0o600);
  assert.equal(await readFile(path, 'utf8'), 'first\n');
  assert.equal(await mode(path), 0o600);
  assert.deepEqual(await readdir(root), ['status.json']);
}));

test('replacing a file gives the replacement the mode asked for, not the old one', () => withRoot(async root => {
  const path = join(root, 'status.json');
  await writeFile(path, 'old\n');
  await chmod(path, 0o644);
  await writeFileAtomically(path, 'new\n', 0o600);
  assert.equal(await readFile(path, 'utf8'), 'new\n');
  assert.equal(await mode(path), 0o600);
}));

test('a temporary file left by an earlier crash never lends its permissions to the new one', () => withRoot(async root => {
  const path = join(root, 'certificate.pem');
  const leftover = `${path}.${process.pid}.tmp`;
  await writeFile(leftover, 'half a certificate');
  await chmod(leftover, 0o666);
  await writeFileAtomically(path, 'a whole one\n', 0o600);
  assert.equal(await readFile(path, 'utf8'), 'a whole one\n');
  assert.equal(await mode(path), 0o600);
  assert.deepEqual(await readdir(root), ['certificate.pem']);
}));
