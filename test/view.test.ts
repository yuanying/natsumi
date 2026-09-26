import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseView, VIEW_MAX_BYTES, viewImage } from '../src/server/view.ts';
import { PNG } from './support/fake-slack.ts';

/**
 * `view <path>` in the shell (Q7 of the Slack grill): the server answers it itself, with the image as the tool result.
 * Only what is under /sources and /work is shown (/work since ADR 0044, for the images she draws), only images, and
 * only up to a size.
 */

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-view-')));
  const sources = join(root, 'sources');
  const work = join(root, 'work');
  await mkdir(join(sources, 'slack', 'work', 'dev', 'files'), { recursive: true });
  await mkdir(join(work, 'images'), { recursive: true });
  await writeFile(join(work, 'images', 'cat.png'), PNG);
  await writeFile(join(sources, 'slack', 'work', 'dev', 'files', 'a.png'), PNG);
  await writeFile(join(root, 'secret.png'), PNG);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sources, work, places: { sources, work } };
}

test('only a lone view with one path is the server\'s to answer', () => {
  assert.equal(parseView('view /sources/slack/a.png'), '/sources/slack/a.png');
  assert.equal(parseView('  view   /sources/slack/a.png  '), '/sources/slack/a.png');
  assert.equal(parseView('view "/sources/slack/work/dev/files/画像 1.png"'), '/sources/slack/work/dev/files/画像 1.png');
  assert.equal(parseView('view /sources/a.png && ls'), undefined);
  assert.equal(parseView('ls; view /sources/a.png'), undefined);
  assert.equal(parseView('viewer /sources/a.png'), undefined);
  assert.equal(parseView('cat view'), undefined);
});

test('an image under /sources comes back as the image itself', async t => {
  const f = await setup(t);
  const outcome = await viewImage('/sources/slack/work/dev/files/a.png', f.places);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.images, [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }]);
  assert.match(outcome.text, /\/sources\/slack\/work\/dev\/files\/a\.png/);
});

test('an image she drew under /work comes back as the image itself', async t => {
  const f = await setup(t);
  const outcome = await viewImage('/work/images/cat.png', f.places);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.images, [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }]);
  assert.match(outcome.text, /\/work\/images\/cat\.png/);
});

test('a path outside /sources and /work, one that climbs out, or one that is linked out of its own place is refused', async t => {
  const f = await setup(t);
  await symlink(join(f.root, 'secret.png'), join(f.sources, 'slack', 'link.png'));
  await symlink(join(f.root, 'secret.png'), join(f.work, 'link.png'));
  await symlink(f.sources, join(f.work, 'sources'));
  for (const path of ['/memory/a.png', '/home/natsumi/a.png', 'sources/slack/work/dev/files/a.png', '/sources/../secret.png',
    '/sources/slack/../../secret.png', '/sources/slack/link.png', '/work/../secret.png', '/work/link.png', '/work/sources/slack/work/dev/files/a.png']) {
    const outcome = await viewImage(path, f.places);
    assert.equal(outcome.ok, false, path);
    assert.equal(outcome.images, undefined, path);
    assert.doesNotMatch(outcome.text, new RegExp(f.root), 'the server\'s own paths are never told');
  }
});

test('what is missing, not an image, or too large is refused with the reason', async t => {
  const f = await setup(t);
  await writeFile(join(f.sources, 'slack', 'note.png'), 'not really an image');
  await writeFile(join(f.sources, 'slack', 'big.png'), Buffer.concat([PNG, Buffer.alloc(VIEW_MAX_BYTES)]));
  assert.match((await viewImage('/sources/slack/none.png', f.places)).text, /見つかりません/);
  assert.match((await viewImage('/sources/slack/note.png', f.places)).text, /画像ではありません/);
  assert.match((await viewImage('/sources/slack/big.png', f.places)).text, /大きすぎます/);
  assert.match((await viewImage('/sources/slack', f.places)).text, /ファイルではありません/);
});
