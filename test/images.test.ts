import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { ImageStore, takeImages } from '../src/server/images.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { PNG } from './support/fake-slack.ts';

/**
 * The images natsumi hands the server from /work, such as those she names in a request to the dove (ADR 0044): only files under /work, only PNG, JPEG and WebP by
 * their bytes, and within the limits. What passes is copied to the server's side at once, so what the owner approves
 * and what is sent is the copy, whatever becomes of the file in /work.
 */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(24, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 4)]);
const LIMITS = { maxBytes: 1024, maxCount: 3 };

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-dove-images-')));
  const work = join(root, 'work');
  const destination = join(root, 'state', 'images');
  await mkdir(join(work, 'images'), { recursive: true });
  await writeFile(join(work, 'images', 'cat.png'), PNG);
  await writeFile(join(work, 'images', 'dog.jpg'), JPEG);
  await writeFile(join(work, 'images', 'bird.webp'), WEBP);
  await writeFile(join(root, 'secret.png'), PNG);
  t.after(() => rm(root, { recursive: true, force: true }));
  const take = (paths: string[], limits = LIMITS) => takeImages(paths, { workDirectory: work, destination, limits });
  return { root, work, destination, take };
}

test('images under /work are copied, each with its type by its bytes, its size and its digest', async t => {
  const f = await setup(t);
  const taken = await f.take(['/work/images/cat.png', '/work/images/dog.jpg', '/work/images/bird.webp']);
  assert.ok(taken.ok, JSON.stringify(taken));
  assert.deepEqual(taken.images.map(image => [image.source, image.mimeType, image.bytes]), [
    ['/work/images/cat.png', 'image/png', PNG.length],
    ['/work/images/dog.jpg', 'image/jpeg', JPEG.length],
    ['/work/images/bird.webp', 'image/webp', WEBP.length],
  ]);
  const [cat] = taken.images;
  assert.equal(cat!.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.match(cat!.imageId, /^image-[0-9a-f-]{36}$/);
  assert.equal(cat!.file, join(f.destination, `${cat!.imageId}.png`));
  assert.deepEqual(await readFile(cat!.file), PNG);
  assert.equal(new Set(taken.images.map(image => image.imageId)).size, 3);
});

test('the copy stays as it was taken when the file in /work is written over afterwards', async t => {
  const f = await setup(t);
  const taken = await f.take(['/work/images/cat.png']);
  assert.ok(taken.ok);
  await writeFile(join(f.work, 'images', 'cat.png'), JPEG);
  assert.deepEqual(await readFile(taken.images[0]!.file), PNG);
});

test('a path is read the way the workspace sees it, so a dot or a doubled slash inside /work is fine', async t => {
  const f = await setup(t);
  const taken = await f.take(['/work/./images//cat.png']);
  assert.ok(taken.ok);
  assert.equal(taken.images[0]!.source, '/work/images/cat.png');
});

for (const [name, path, pattern] of [
  ['a file outside /work', '/sources/slack/cat.png', /\/work/],
  ['a path that climbs out of /work', '/work/../secret.png', /\/work/],
  ['/work itself', '/work', /\/work/],
  ['a file that is not there', '/work/images/none.png', /見つかりません/],
  ['a directory', '/work/images', /ファイルではありません/],
] as const) {
  test(`${name} is refused, and nothing is copied`, async t => {
    const f = await setup(t);
    const taken = await f.take(['/work/images/cat.png', path]);
    assert.equal(taken.ok, false);
    assert.match((taken as { text: string }).text, pattern);
    assert.deepEqual(await readdir(f.destination).catch(() => []), []);
  });
}

test('a link that leads out of /work is refused as if it were outside, and says nothing of where it leads', async t => {
  const f = await setup(t);
  await symlink(join(f.root, 'secret.png'), join(f.work, 'images', 'link.png'));
  await symlink(f.root, join(f.work, 'up'));
  for (const path of ['/work/images/link.png', '/work/up/secret.png']) {
    const taken = await f.take([path]);
    assert.equal(taken.ok, false, path);
    assert.match((taken as { text: string }).text, /\/work/);
    assert.doesNotMatch((taken as { text: string }).text, new RegExp(f.root));
  }
});

test('a link that stays inside /work is followed', async t => {
  const f = await setup(t);
  await symlink(join(f.work, 'images', 'cat.png'), join(f.work, 'latest.png'));
  const taken = await f.take(['/work/latest.png']);
  assert.ok(taken.ok);
  assert.equal(taken.images[0]!.mimeType, 'image/png');
});

test('only PNG, JPEG and WebP are taken, by their bytes and not their names', async t => {
  const f = await setup(t);
  await writeFile(join(f.work, 'images', 'moving.png'), GIF);
  await writeFile(join(f.work, 'images', 'notes.png'), 'これは画像ではありません');
  for (const path of ['/work/images/moving.png', '/work/images/notes.png']) {
    const taken = await f.take([path]);
    assert.equal(taken.ok, false, path);
    assert.match((taken as { text: string }).text, /PNG・JPEG・WebP/);
  }
});

test('an image larger than the limit is refused with the limit', async t => {
  const f = await setup(t);
  await writeFile(join(f.work, 'images', 'large.png'), Buffer.concat([PNG, Buffer.alloc(2048)]));
  const taken = await f.take(['/work/images/large.png']);
  assert.equal(taken.ok, false);
  assert.match((taken as { text: string }).text, /大きすぎ/);
  assert.match((taken as { text: string }).text, /1 KB/);
});

test('more images than the limit are refused before any is read', async t => {
  const f = await setup(t);
  const taken = await f.take(['/work/images/cat.png', '/work/images/dog.jpg', '/work/images/bird.webp', '/work/images/cat.png']);
  assert.equal(taken.ok, false);
  assert.match((taken as { text: string }).text, /3 枚まで/);
  assert.deepEqual(await readdir(f.destination).catch(() => []), []);
});

test('taken images are recorded by ID, and each is read back by its ID alone, from the copy', async t => {
  const f = await setup(t);
  const db = openStateDatabase(join(f.root, 'state.sqlite'));
  t.after(() => db.close());
  migrate(db, MIGRATIONS);
  const store = new ImageStore(db, f.destination);
  const taken = await store.take(['/work/images/cat.png', '/work/images/dog.jpg'], f.work, LIMITS);
  assert.ok(taken.ok);
  store.record(taken.images, '2026-09-26T00:00:00.000Z');
  const [cat, dog] = taken.images;
  await writeFile(join(f.work, 'images', 'cat.png'), JPEG);
  assert.deepEqual(await store.read(cat!.imageId), { mimeType: 'image/png', data: PNG });
  assert.deepEqual(await store.read(dog!.imageId), { mimeType: 'image/jpeg', data: JPEG });
  assert.equal(await store.read('image-unknown'), undefined);
  const row = db.prepare('SELECT source, file, bytes FROM images WHERE image_id = ?').get(cat!.imageId) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { source: '/work/images/cat.png', file: `${cat!.imageId}.png`, bytes: PNG.length });
  await rm(cat!.file);
  assert.equal(await store.read(cat!.imageId), undefined, 'a copy that is gone is not there');
});
