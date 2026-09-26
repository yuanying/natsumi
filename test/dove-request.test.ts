import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDoveRequest, parseReference } from '../src/server/dove-request.ts';

/**
 * What natsumi writes to the dove (ADR 0039, ADR 0040): headings, then `---` and the body. A request out of shape is
 * turned back before anything is judged or sent, with a sentence she can act on.
 */

test('a post to a message: the reference, the kind, the feeling and the body', () => {
  const parsed = parseDoveRequest('返信先: work/#dev 2026-09-25 14:32:05 山田\n種類: 投稿\n表情: happy\n---\nおつかれさまです。\n明日やります。');
  assert.deepEqual(parsed, { ok: true, request: {
    target: { workspace: 'work', channel: '#dev', at: { date: '2026-09-25', time: '14:32:05' }, speaker: '山田' },
    kind: 'post', expression: 'happy', body: 'おつかれさまです。\n明日やります。',
  } });
});

test('a post to a channel, without a feeling, and full-width colons are read as colons', () => {
  const parsed = parseDoveRequest('返信先：work/#dev\n種類：投稿\n---\nおはようございます');
  assert.deepEqual(parsed, { ok: true, request: { target: { workspace: 'work', channel: '#dev' }, kind: 'post', body: 'おはようございます' } });
});

test('a reaction names the emoji as its body, with or without colons', () => {
  const parsed = parseDoveRequest('返信先: work/@佐藤 2026-09-25 09:00:00 佐藤\n種類: リアクション\n---\n:+1:');
  assert.deepEqual(parsed, { ok: true, request: {
    target: { workspace: 'work', channel: '@佐藤', at: { date: '2026-09-25', time: '09:00:00' }, speaker: '佐藤' }, kind: 'reaction', body: '+1',
  } });
});

test('a reaction may name a skin tone or a custom emoji of any letters, and the colons around it are dropped', () => {
  const body = (text: string) => {
    const parsed = parseDoveRequest(`返信先: work/#dev 2026-09-25 14:32:05 山田\n種類: リアクション\n---\n${text}`);
    return parsed.ok ? parsed.request.body : parsed.text;
  };
  assert.equal(body(':thumbsup::skin-tone-2:'), 'thumbsup::skin-tone-2');
  assert.equal(body('thumbsup::skin-tone-2'), 'thumbsup::skin-tone-2');
  assert.equal(body(':了解:'), '了解');
  assert.equal(body('looks-good'), 'looks-good');
});

test('a speaker whose name has spaces is kept whole', () => {
  assert.deepEqual(parseReference('work/#dev 2026-09-25 14:32:05 Taro Yamada'),
    { workspace: 'work', channel: '#dev', at: { date: '2026-09-25', time: '14:32:05' }, speaker: 'Taro Yamada' });
});

test('how the message begins may follow the speaker, to tell apart two messages of the same second', () => {
  assert.deepEqual(parseReference('work/#dev 2026-09-25 14:32:05 山田 「もう一つの」'),
    { workspace: 'work', channel: '#dev', at: { date: '2026-09-25', time: '14:32:05' }, speaker: '山田', begins: 'もう一つの' });
});

for (const [name, message, pattern] of [
  ['no separator', '返信先: work/#dev\n種類: 投稿\nこんにちは', /---/],
  ['no reference', '種類: 投稿\n---\nこんにちは', /返信先/],
  ['no kind', '返信先: work/#dev\n---\nこんにちは', /種類/],
  ['an unknown kind', '返信先: work/#dev\n種類: 画像\n---\nこんにちは', /投稿.*リアクション/],
  ['an unknown heading', '返信先: work/#dev\n種類: 投稿\n宛先: 山田\n---\nこんにちは', /宛先/],
  ['a heading twice', '返信先: work/#dev\n返信先: work/#random\n種類: 投稿\n---\nこんにちは', /返信先/],
  ['an unknown feeling', '返信先: work/#dev\n種類: 投稿\n表情: angry\n---\nこんにちは', /表情/],
  ['a reference without a channel', '返信先: work\n種類: 投稿\n---\nこんにちは', /work\/#dev/],
  ['a reference with the time cut to minutes', '返信先: work/#dev 2026-09-25 14:32 山田\n種類: 投稿\n---\nこんにちは', /秒/],
  ['a reference with a time and no speaker', '返信先: work/#dev 2026-09-25 14:32:05\n種類: 投稿\n---\nこんにちは', /発言者/],
  ['an empty body', '返信先: work/#dev\n種類: 投稿\n---\n  \n', /本文/],
  ['a reaction with two emoji', '返信先: work/#dev 2026-09-25 14:32:05 山田\n種類: リアクション\n---\n+1 eyes', /絵文字/],
  ['a reaction with two emoji side by side', '返信先: work/#dev 2026-09-25 14:32:05 山田\n種類: リアクション\n---\n:+1::eyes:', /絵文字/],
  ['a reaction to a channel', '返信先: work/#dev\n種類: リアクション\n---\n+1', /発言/],
] as const) {
  test(`${name} is turned back with what to fix`, () => {
    const parsed = parseDoveRequest(message);
    assert.equal(parsed.ok, false);
    assert.match((parsed as { text: string }).text, pattern);
    assert.match((parsed as { text: string }).text, /^頼んでいません。/);
  });
}

// ADR 0044: `画像:` names an image under /work, one line each; with images the body may be left out.
test('images are named one line each, in the order written, and the body becomes their comment', () => {
  const parsed = parseDoveRequest('返信先: work/#dev\n種類: 投稿\n画像: /work/images/cat.png\n画像：/work/images/dog.webp\n---\n描いたよ');
  assert.deepEqual(parsed, { ok: true, request: {
    target: { workspace: 'work', channel: '#dev' }, kind: 'post', body: '描いたよ', images: ['/work/images/cat.png', '/work/images/dog.webp'],
  } });
});

test('with an image the body may be empty, and the separator may even be the last line', () => {
  for (const message of ['返信先: work/#dev\n種類: 投稿\n画像: /work/cat.png\n---\n', '返信先: work/#dev\n種類: 投稿\n画像: /work/cat.png\n---']) {
    assert.deepEqual(parseDoveRequest(message), { ok: true, request: {
      target: { workspace: 'work', channel: '#dev' }, kind: 'post', body: '', images: ['/work/cat.png'] } });
  }
});

for (const [name, message, pattern] of [
  ['an image with no path', '返信先: work/#dev\n種類: 投稿\n画像:\n---\nこんにちは', /画像/],
  ['an image on a relative path', '返信先: work/#dev\n種類: 投稿\n画像: images/cat.png\n---\nこんにちは', /\/work\//],
  ['an image on a reaction', '返信先: work/#dev 2026-09-25 14:32:05 山田\n種類: リアクション\n画像: /work/cat.png\n---\n+1', /リアクション/],
  ['neither an image nor a body', '返信先: work/#dev\n種類: 投稿\n---\n', /本文/],
] as const) {
  test(`${name} is turned back with what to fix`, () => {
    const parsed = parseDoveRequest(message);
    assert.equal(parsed.ok, false);
    assert.match((parsed as { text: string }).text, pattern);
    assert.match((parsed as { text: string }).text, /^頼んでいません。/);
  });
}
