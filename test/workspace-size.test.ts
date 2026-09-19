import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_SIZE_WARN_BYTES, MIN_MEASURE_INTERVAL_MS, WorkspaceSize } from '../src/server/workspace-size.ts';

async function places() {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-size-'));
  for (const name of ['memory', 'work', 'home']) await mkdir(join(root, name));
  return root;
}

const size = (root: string, options: { warnBytes?: number; now?: () => number } = {}) => new WorkspaceSize({
  places: [{ label: '/memory', path: join(root, 'memory') }, { label: '/work', path: join(root, 'work') },
    { label: '/home/natsumi', path: join(root, 'home') }],
  warnBytes: options.warnBytes ?? DEFAULT_SIZE_WARN_BYTES,
  ...(options.now ? { now: options.now } : {}),
});

test('the default warning is a gibibyte, and nothing is said while the places are small', async () => {
  const root = await places();
  try {
    assert.equal(DEFAULT_SIZE_WARN_BYTES, 1024 * 1024 * 1024);
    await writeFile(join(root, 'work', 'notes.txt'), 'x'.repeat(1000));
    assert.equal(await size(root).check(), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('past the warning, one line says the total and where it went', async () => {
  const root = await places();
  try {
    await writeFile(join(root, 'work', 'big.csv'), 'x'.repeat(40_960));
    await mkdir(join(root, 'work', 'runs'));
    await writeFile(join(root, 'work', 'runs', 'more.csv'), 'x'.repeat(10_240));
    await writeFile(join(root, 'memory', '予定.md'), 'あ'.repeat(100));
    const notice = await size(root, { warnBytes: 20_000 }).check();
    assert.match(notice, /永続する書き場所/);
    // The breakdown names all three, largest first, so she knows where to tidy.
    assert.match(notice, /\/work.*\/memory.*\/home\/natsumi/s);
    assert.match(notice, /\/work 50\.0 KiB/, 'subdirectories count towards the place they are in');
    assert.match(notice, /\/memory 300 B/);
    assert.match(notice, /\/home\/natsumi 0 B/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the places are walked at most once every ten minutes, however many turns end', async () => {
  const root = await places();
  try {
    await writeFile(join(root, 'work', 'big.csv'), 'x'.repeat(40_960));
    let clock = 1_000_000;
    const workspace = size(root, { warnBytes: 20_000, now: () => clock });
    assert.equal(MIN_MEASURE_INTERVAL_MS, 10 * 60_000);
    assert.notEqual(await workspace.check(), '');
    assert.equal(workspace.measurements, 1);

    // Between turns nothing is walked again, and nothing is repeated either.
    clock += MIN_MEASURE_INTERVAL_MS - 1;
    assert.equal(await workspace.check(), '');
    assert.equal(workspace.measurements, 1);

    clock += 1;
    assert.notEqual(await workspace.check(), '');
    assert.equal(workspace.measurements, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing place counts as nothing and a symlink is never followed out of the workspace', async () => {
  const root = await places();
  try {
    await rm(join(root, 'home'), { recursive: true });
    const outside = join(root, 'outside.bin');
    await writeFile(outside, 'x'.repeat(500_000));
    await symlink(outside, join(root, 'work', 'link'));
    await writeFile(join(root, 'work', 'own.txt'), 'x'.repeat(30_720));
    const notice = await size(root, { warnBytes: 20_000 }).check();
    assert.match(notice, /\/work 30\.0 KiB/);
    assert.match(notice, /\/home\/natsumi 0 B/, 'a place that is not there yet counts as nothing');
    assert.doesNotMatch(notice, /488|MiB/, 'the file the symlink points at is outside the workspace');
  } finally { await rm(root, { recursive: true, force: true }); }
});
