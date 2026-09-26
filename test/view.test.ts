import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseView, VIEW_MAX_BYTES, viewImage } from '../src/server/view.ts';
import { PNG } from './support/fake-slack.ts';

/**
 * `view <path>` in the shell (Q7 of the Slack grill): the server answers it itself, with the image as the tool result.
 * Only what is under /sources is shown, only images, and only up to a size.
 */

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-view-')));
  const sources = join(root, 'sources');
  await mkdir(join(sources, 'slack', 'work', 'dev', 'files'), { recursive: true });
  await writeFile(join(sources, 'slack', 'work', 'dev', 'files', 'a.png'), PNG);
  await writeFile(join(root, 'secret.png'), PNG);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sources };
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
  const outcome = await viewImage('/sources/slack/work/dev/files/a.png', f.sources);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.images, [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }]);
  assert.match(outcome.text, /\/sources\/slack\/work\/dev\/files\/a\.png/);
});

test('a path outside /sources, one that climbs out, or one that is linked out is refused', async t => {
  const f = await setup(t);
  await symlink(join(f.root, 'secret.png'), join(f.sources, 'slack', 'link.png'));
  for (const path of ['/memory/a.png', '/work/a.png', 'sources/slack/work/dev/files/a.png', '/sources/../secret.png',
    '/sources/slack/../../secret.png', '/sources/slack/link.png']) {
    const outcome = await viewImage(path, f.sources);
    assert.equal(outcome.ok, false, path);
    assert.equal(outcome.images, undefined, path);
    assert.doesNotMatch(outcome.text, new RegExp(f.root), 'the server\'s own paths are never told');
  }
});

test('what is missing, not an image, or too large is refused with the reason', async t => {
  const f = await setup(t);
  await writeFile(join(f.sources, 'slack', 'note.png'), 'not really an image');
  await writeFile(join(f.sources, 'slack', 'big.png'), Buffer.concat([PNG, Buffer.alloc(VIEW_MAX_BYTES)]));
  assert.match((await viewImage('/sources/slack/none.png', f.sources)).text, /見つかりません/);
  assert.match((await viewImage('/sources/slack/note.png', f.sources)).text, /画像ではありません/);
  assert.match((await viewImage('/sources/slack/big.png', f.sources)).text, /大きすぎます/);
  assert.match((await viewImage('/sources/slack', f.sources)).text, /ファイルではありません/);
});
