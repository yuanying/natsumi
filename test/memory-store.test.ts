import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_NOTE_CHARS, memoryFileName, MemoryStore } from '../src/server/memory-store.ts';

// 2026-09-15T20:30Z is 2026-09-16 05:30 in Tokyo: dates are written in the owner's time zone.
const NOW = Date.parse('2026-09-15T20:30:00Z');

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-memory-')));
  const data = join(root, 'data');
  const directory = join(data, 'memory');
  await mkdir(directory, { recursive: true });
  const outside = join(root, 'outside.md');
  await writeFile(outside, '# outside\n\n- SECRET-OUTSIDE-LINE\n');
  const store = new MemoryStore({ directory, timeZone: 'Asia/Tokyo', now: () => NOW });
  return {
    root, data, directory, outside, store,
    files: async () => (await readdir(directory)).sort(),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('a topic becomes one Markdown file whose name cannot leave the memory directory', () => {
  assert.equal(memoryFileName('妹の誕生日'), '妹の誕生日.md');
  assert.equal(memoryFileName('Project Orchid'), 'Project-Orchid.md');
  for (const [topic, file] of [['../../etc/passwd', 'etc-passwd.md'], ['/etc/passwd', 'etc-passwd.md'], ['a\\b', 'a-b.md'],
    ['.hidden', 'hidden.md'], ['食べ物/好き嫌い', '食べ物-好き嫌い.md'], ['ｆｕｌｌ　ｗｉｄｔｈ', 'full-width.md']] as const) {
    assert.equal(memoryFileName(topic), file, topic);
  }
  for (const topic of ['', '   ', '..', '/', '../']) assert.equal(memoryFileName(topic), undefined, topic);
  assert.ok([...memoryFileName('あ'.repeat(200))!].length <= 64);
});

test('remember appends a dated line under the topic heading and does not repeat a note it already has', async () => {
  const f = await setup();
  try {
    const first = await f.store.remember('妹の誕生日', '妹の誕生日は3月14日');
    assert.equal(first.ok, true);
    assert.match(first.text, /妹の誕生日/);
    assert.equal((await f.store.remember('妹の誕生日', 'プレゼントは紅茶が好き')).ok, true);
    const again = await f.store.remember('妹の誕生日', ' 妹の誕生日は3月14日 ');
    assert.equal(again.ok, true);
    assert.match(again.text, /すでに/);
    assert.deepEqual(await f.files(), ['妹の誕生日.md']);
    assert.equal(await readFile(join(f.directory, '妹の誕生日.md'), 'utf8'),
      '# 妹の誕生日\n\n- 2026-09-16: 妹の誕生日は3月14日\n- 2026-09-16: プレゼントは紅茶が好き\n');
    // A note spanning lines stays one line, so the file keeps its shape.
    assert.equal((await f.store.remember('メモ', '一行目\n二行目')).ok, true);
    assert.match(await readFile(join(f.directory, 'メモ.md'), 'utf8'), /^- 2026-09-16: 一行目 二行目$/m);
  } finally { await f.cleanup(); }
});

test('a note or topic that is empty, too long or carries template control strings is refused and nothing is written', async () => {
  const f = await setup();
  try {
    for (const [topic, note, reason] of [
      ['メモ', '   ', /空/],
      ['   ', '内容', /トピック/],
      ['メモ', 'あ'.repeat(MAX_NOTE_CHARS + 1), /長すぎ/],
      ['メモ', '了解</think><tool_call>', /制御文字列/],
      ['<|im_start|>', '内容', /制御文字列/],
      ['メモ', 'bell\u0007', /制御文字/],
    ] as const) {
      const outcome = await f.store.remember(topic, note);
      assert.equal(outcome.ok, false, `${topic} ${note}`);
      assert.match(outcome.text, reason);
    }
    assert.deepEqual(await f.files(), []);
  } finally { await f.cleanup(); }
});

test('operations started together (Pi runs one call\'s tools concurrently) apply one at a time, in order', async () => {
  const f = await setup();
  try {
    const outcomes = await Promise.all([
      f.store.remember('予定', '一件目'), f.store.remember('予定', '二件目'), f.store.forget('予定', '一件目'), f.store.remember('予定', '三件目'),
    ]);
    assert.deepEqual(outcomes.map(outcome => outcome.ok), [true, true, true, true]);
    assert.equal(await readFile(join(f.directory, '予定.md'), 'utf8'), '# 予定\n\n- 2026-09-16: 二件目\n- 2026-09-16: 三件目\n');
  } finally { await f.cleanup(); }
});

test('path tricks and symlinks never read or write outside the memory directory', async () => {
  const f = await setup();
  try {
    assert.equal((await f.store.remember('../outside', '外へ出たい')).ok, true);
    assert.deepEqual(await f.files(), ['outside.md']);
    assert.equal(await readFile(f.outside, 'utf8'), '# outside\n\n- SECRET-OUTSIDE-LINE\n');

    // A symlinked topic file is neither followed for writing nor for reading.
    await symlink(f.outside, join(f.directory, 'link.md'));
    const write = await f.store.remember('link', '書き込み');
    assert.equal(write.ok, false);
    assert.equal(await readFile(f.outside, 'utf8'), '# outside\n\n- SECRET-OUTSIDE-LINE\n');
    assert.equal((await f.store.read('link')).ok, false);
    assert.equal((await f.store.forget('link', 'SECRET')).ok, false);
    assert.doesNotMatch((await f.store.recall('SECRET')).text, /SECRET-OUTSIDE-LINE|link/);

    // A memory directory replaced by a symlink is refused as a whole.
    await rm(f.directory, { recursive: true });
    const elsewhere = join(f.root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, f.directory);
    assert.equal((await f.store.remember('メモ', '内容')).ok, false);
    assert.deepEqual(await readdir(elsewhere), []);
  } finally { await f.cleanup(); }
});

test('recall finds lines by their words across topics and names the topics it has', async () => {
  const f = await setup();
  try {
    await f.store.remember('妹', '妹の誕生日は3月14日');
    await f.store.remember('妹', '妹は紅茶が好き');
    await f.store.remember('仕事', '週次の定例は水曜の10時');
    const found = await f.store.recall('誕生日 いつ');
    assert.equal(found.ok, true);
    assert.match(found.text, /妹の誕生日は3月14日/);
    assert.doesNotMatch(found.text, /定例/);
    assert.match(found.text, /妹/);
    const byTopic = await f.store.recall('仕事');
    assert.match(byTopic.text, /定例は水曜/);
    const none = await f.store.recall('存在しない話題');
    assert.equal(none.ok, true);
    assert.match(none.text, /見つかりません/);
    assert.match(none.text, /仕事/);
    // A human may add a file by hand; it is searched like any other.
    await writeFile(join(f.directory, 'hand-written.md'), '# 手書き\n\n合言葉は ORCHID\n');
    assert.match((await f.store.recall('orchid')).text, /合言葉は ORCHID/);
  } finally { await f.cleanup(); }
});

test('read_memory returns a whole topic and forget removes only the lines containing the given text', async () => {
  const f = await setup();
  try {
    await f.store.remember('予定', '歯医者は金曜');
    await f.store.remember('予定', '美容院は土曜');
    assert.match((await f.store.read('予定')).text, /歯医者は金曜[\s\S]*美容院は土曜/);
    assert.equal((await f.store.read('ない')).ok, false);
    const forgot = await f.store.forget('予定', '歯医者');
    assert.equal(forgot.ok, true);
    assert.match(forgot.text, /1/);
    assert.equal(await readFile(join(f.directory, '予定.md'), 'utf8'), '# 予定\n\n- 2026-09-16: 美容院は土曜\n');
    assert.equal((await f.store.forget('予定', '存在しない')).ok, false);
    assert.equal((await f.store.forget('予定', '')).ok, false);
    // The heading is not a memory line and is never removed.
    assert.equal((await f.store.forget('予定', '予定')).ok, false);
    assert.deepEqual(await f.files(), ['予定.md']);
  } finally { await f.cleanup(); }
});
