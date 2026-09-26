import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SLACK_DEFAULTS } from '../src/server/config.ts';
import { ConversationStore } from '../src/server/conversation-store.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SlackArchive } from '../src/server/slack-archive.ts';
import { SlackWorkspace } from '../src/server/slack.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { FakeSlack, PNG, tsAt } from './support/fake-slack.ts';

/**
 * The receiving side of Slack (ADR 0012): what the server writes for natsumi to read, and which messages become
 * events. Slack is a stand-in; nothing goes over the network.
 */

const TIME_ZONE = 'Asia/Tokyo';
/** 2026-09-25 14:32:05 in Tokyo. */
const AT = '2026-09-25T05:32:05Z';

async function setup(t: test.TestContext, options: { backfillDays?: number; maxImageBytes?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-slack-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const store = new ConversationStore(db, Date.now);
  const directory = join(root, 'sources', 'slack');
  let clock = Date.parse(AT) + 60_000;
  const now = () => clock;
  const archive = new SlackArchive({ db, directory, timeZone: TIME_ZONE, now, mentionContext: { messages: 5, chars: 500 } });
  const slack = new FakeSlack();
  slack.addChannel({ id: 'C1', name: 'dev', isIm: false });
  const events: string[] = [];
  const logs: string[] = [];
  const workspace = new SlackWorkspace({
    name: 'work', api: slack, socket: slack, archive, reaction: 'eyes', backfillDays: options.backfillDays ?? SLACK_DEFAULTS.backfillDays,
    maxImageBytes: options.maxImageBytes ?? 1024 * 1024, now, log: line => { logs.push(line); },
    // What the loop does with a new event: the row and the caller's own records, in one transaction.
    raise: record => {
      store.transaction(transaction => {
        const eventId = store.insertEvent('slack-mention');
        record(eventId, transaction);
        events.push(eventId);
      });
    },
  });
  await workspace.start();
  t.after(async () => {
    await workspace.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const read = (path: string) => readFile(join(directory, path), 'utf8');
  return { root, db, directory, archive, slack, workspace, events, logs, read, tick: (ms: number) => { clock += ms; } };
}

/** A message event as Slack sends it over Socket Mode. */
function message(fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '', ts: tsAt(AT), ...fields };
}

test('a message in a channel is written to that day\'s file under a heading of its local time and speaker', async t => {
  const f = await setup(t);
  f.slack.emit(message({ text: 'おはようございます\n今日は <#C9|design> で話します <https://example.test/doc|資料>' }));
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-25.md');
  assert.match(text, /^# work\/#dev 2026-09-25$/m);
  assert.match(text, /^## 14:32:05 山田$/m);
  assert.match(text, /^おはようございます$/m);
  assert.match(text, /今日は #design で話します 資料（https:\/\/example\.test\/doc）/);
  assert.doesNotMatch(text, /\d{10}\.\d{6}/, 'no Slack ts in the file');
  const index = await f.read('INDEX.md');
  assert.match(index, /work\/#dev/);
  assert.match(index, /2026-09-25 14:32:05/);
  assert.match(index, /\/sources\/slack\/work\/dev\/2026-09-25\.md/);
});

test('a reply in a thread stands indented under its parent, in the parent\'s file', async t => {
  const f = await setup(t);
  const parent = tsAt(AT);
  f.slack.emit(message({ text: '親の発言', ts: parent }));
  // The next day in Tokyo: the reply still goes under the parent.
  f.slack.emit(message({ user: 'U2', text: '返信です', ts: tsAt('2026-09-25T15:10:00Z'), thread_ts: parent }));
  f.slack.emit(message({ text: '別の発言', ts: tsAt('2026-09-25T05:40:00Z') }));
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-25.md');
  const parentAt = text.indexOf('## 14:32:05 山田');
  const replyAt = text.indexOf('  ### 2026-09-26 00:10:00 佐藤');
  const nextAt = text.indexOf('## 14:40:00 山田');
  assert.ok(parentAt >= 0 && replyAt > parentAt && nextAt > replyAt, text);
  assert.match(text, /^ {2}返信です$/m);
  await assert.rejects(f.read('work/dev/2026-09-26.md'));
});

test('an edit and a deletion rewrite the day\'s file', async t => {
  const f = await setup(t);
  const ts = tsAt(AT);
  f.slack.emit(message({ text: '最初の文', ts }));
  f.slack.emit(message({ text: '消える文', ts: tsAt('2026-09-25T05:33:00Z') }));
  await f.workspace.idle();
  f.slack.emit({ type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel', ts: tsAt('2026-09-25T05:35:00Z'),
    message: { type: 'message', user: 'U1', text: '直した文', ts, edited: { user: 'U1', ts: tsAt('2026-09-25T05:35:00Z') } } });
  f.slack.emit({ type: 'message', subtype: 'message_deleted', channel: 'C1', channel_type: 'channel',
    ts: tsAt('2026-09-25T05:36:00Z'), deleted_ts: tsAt('2026-09-25T05:33:00Z') });
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-25.md');
  assert.match(text, /直した文/);
  assert.match(text, /（編集済み）/);
  assert.doesNotMatch(text, /最初の文/);
  assert.doesNotMatch(text, /消える文/);
  assert.doesNotMatch(text, /14:33:00/);
});

test('an image is fetched into files/ beside the day\'s file; one too large or not an image is only noted', async t => {
  const f = await setup(t, { maxImageBytes: 1024 });
  f.slack.files.set('https://files.example.test/a.png', PNG);
  f.slack.files.set('https://files.example.test/big.png', Buffer.concat([PNG, Buffer.alloc(4096)]));
  f.slack.emit(message({ text: '画像です', files: [
    { id: 'F1', name: 'a.png', mimetype: 'image/png', size: PNG.length, url_private_download: 'https://files.example.test/a.png' },
    { id: 'F2', name: 'big.png', mimetype: 'image/png', size: 5000, url_private_download: 'https://files.example.test/big.png' },
    { id: 'F3', name: 'memo.pdf', mimetype: 'application/pdf', size: 100, url_private_download: 'https://files.example.test/memo.pdf' },
  ] }));
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-25.md');
  const image = /- 画像: (\/sources\/slack\/work\/dev\/files\/\S+\.png)/.exec(text);
  assert.ok(image, text);
  const saved = await readdir(join(f.directory, 'work', 'dev', 'files'));
  assert.equal(saved.length, 1);
  assert.deepEqual(await readFile(join(f.directory, image[1]!.replace('/sources/slack/', ''))), PNG);
  assert.match(text, /- 添付あり（取り込まず）: big\.png/);
  assert.match(text, /- 添付あり（取り込まず）: memo\.pdf/);
  assert.deepEqual(f.slack.downloads, ['https://files.example.test/a.png'], 'what is too large or not an image is not fetched');
});

test('a mention becomes one event, gets the eyes reaction once, and a retry or the app_mention twin adds nothing', async t => {
  const f = await setup(t);
  const ts = tsAt(AT);
  const mention = message({ text: '<@UBOT> 明日の件どうなってる？', ts });
  f.slack.emit(mention);
  f.slack.emit({ ...mention, type: 'app_mention' });
  f.slack.emit(mention);
  await f.workspace.idle();
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.slack.reactions, [{ channel: 'C1', ts, name: 'eyes' }]);
  assert.match(await f.read('work/dev/2026-09-25.md'), /@natsumi 明日の件どうなってる？/);
});

test('a direct message becomes an event, under the sender\'s name', async t => {
  const f = await setup(t);
  f.slack.addChannel({ id: 'D1', isIm: true, user: 'U2' });
  f.slack.emit(message({ channel: 'D1', channel_type: 'im', user: 'U2', text: 'ちょっと相談です' }));
  await f.workspace.idle();
  assert.equal(f.events.length, 1);
  assert.match(await f.read('work/@佐藤/2026-09-25.md'), /^## 14:32:05 佐藤$/m);
});

test('her name without a mention, her own posts and other bots make no event', async t => {
  const f = await setup(t);
  f.slack.emit(message({ text: 'natsumi さんに聞いてみよう', ts: tsAt(AT) }));
  f.slack.emit(message({ user: 'UBOT', bot_id: 'BBOT', text: '了解です', ts: tsAt('2026-09-25T05:33:00Z') }));
  f.slack.emit(message({ user: undefined, bot_id: 'B2', username: 'ci', subtype: 'bot_message', text: '<@UBOT> build failed',
    ts: tsAt('2026-09-25T05:34:00Z') }));
  await f.workspace.idle();
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.slack.reactions, []);
  const text = await f.read('work/dev/2026-09-25.md');
  assert.match(text, /natsumi さんに聞いてみよう/);
  assert.match(text, /^## 14:33:00 natsumi$/m);
  assert.match(text, /^## 14:34:00 ci$/m);
});

test('on connecting, what was missed is filled in from the last recorded message, threads included, and nothing is removed', async t => {
  const f = await setup(t, { backfillDays: 2 });
  f.slack.emit(message({ text: '記録済み', ts: tsAt(AT) }));
  await f.workspace.idle();
  const parent = tsAt('2026-09-25T05:40:00Z');
  f.slack.post('C1', { ts: parent, user: 'U2', text: '止まっている間の発言', files: [] });
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:41:00Z'), threadTs: parent, user: 'U1', text: '止まっている間の返信', files: [] });
  f.slack.connect();
  await f.workspace.idle();
  assert.deepEqual(f.slack.historyCalls.at(-1), { channel: 'C1', oldest: tsAt(AT) });
  const text = await f.read('work/dev/2026-09-25.md');
  assert.match(text, /記録済み/, 'what Slack no longer returns stays');
  assert.match(text, /止まっている間の発言/);
  assert.match(text, /^ {2}止まっている間の返信$/m);
});

test('a channel never recorded is filled in from the configured number of days back, and its mentions raise nothing', async t => {
  const f = await setup(t, { backfillDays: 2 });
  f.slack.addChannel({ id: 'C2', name: 'random', isIm: false });
  f.slack.post('C2', { ts: tsAt('2026-09-24T05:00:00Z'), user: 'U1', text: '<@UBOT> 昨日の呼びかけ', files: [] });
  f.slack.connect();
  await f.workspace.idle();
  const call = f.slack.historyCalls.find(c => c.channel === 'C2');
  assert.equal(call?.oldest, String((Date.parse(AT) + 60_000) / 1000 - 2 * 86400));
  assert.match(await f.read('work/random/2026-09-24.md'), /昨日の呼びかけ/);
  assert.equal(f.events.length, 0, 'a first fill-in raises no old mentions');
});

test('a mention missed while disconnected is raised when it is filled in', async t => {
  const f = await setup(t);
  f.slack.emit(message({ text: '記録済み', ts: tsAt(AT) }));
  await f.workspace.idle();
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:40:00Z'), user: 'U2', text: '<@UBOT> 止まっている間の呼びかけ', files: [] });
  f.slack.connect();
  await f.workspace.idle();
  assert.equal(f.events.length, 1);
  assert.equal(f.slack.reactions.length, 1);
});

test('updates count what came since they were last shown, per channel, and drop to nothing once shown', async t => {
  const f = await setup(t);
  f.slack.addChannel({ id: 'C2', name: 'random', isIm: false });
  f.slack.emit(message({ text: '一つ目', ts: tsAt(AT) }));
  f.slack.emit(message({ text: 'natsumi の話', ts: tsAt('2026-09-25T05:33:00Z') }));
  f.slack.emit(message({ channel: 'C2', text: '雑談', ts: tsAt('2026-09-25T05:34:00Z') }));
  f.slack.emit(message({ text: '<@UBOT> メンション', ts: tsAt('2026-09-25T05:35:00Z') }));
  f.slack.emit(message({ user: 'UBOT', bot_id: 'BBOT', text: '自分の発言', ts: tsAt('2026-09-25T05:36:00Z') }));
  await f.workspace.idle();
  assert.deepEqual(f.archive.take(), {
    new: { 'work/#dev': 2, 'work/#random': 1 },
    files: ['/sources/slack/work/dev/2026-09-25.md', '/sources/slack/work/random/2026-09-25.md'],
  });
  assert.equal(f.archive.take(), undefined);
  f.slack.emit(message({ text: '次の発言', ts: tsAt('2026-09-25T05:50:00Z') }));
  await f.workspace.idle();
  assert.deepEqual(f.archive.take()?.new, { 'work/#dev': 1 });
});

test('the event line names the speaker and a reference to copy, with the flow before it, and carries no Slack ID', async t => {
  const f = await setup(t);
  f.slack.emit(message({ user: 'U2', text: '前の発言 1', ts: tsAt('2026-09-25T05:30:00Z') }));
  f.slack.emit(message({ text: '前の発言 2', ts: tsAt('2026-09-25T05:31:00Z') }));
  f.slack.files.set('https://files.example.test/a.png', PNG);
  const ts = tsAt(AT);
  f.slack.emit(message({ text: '<@UBOT> これ見て', ts, files: [
    { id: 'F1', name: 'a.png', mimetype: 'image/png', size: PNG.length, url_private_download: 'https://files.example.test/a.png' }] }));
  await f.workspace.idle();
  const line = f.archive.eventLine(f.events[0]!, '2026-09-25T05:32:06.000Z');
  assert.equal(line.type, 'slack_mention');
  assert.equal(line.via, 'mention');
  assert.equal(line.channel, 'work/#dev');
  assert.equal(line.from, '山田');
  assert.equal(line.text, '@natsumi これ見て');
  assert.equal(line.reference, 'work/#dev 2026-09-25 14:32:05 山田');
  assert.equal(line.file, '/sources/slack/work/dev/2026-09-25.md');
  assert.deepEqual(line.context, [
    { at: '14:30:00', from: '佐藤', text: '前の発言 1' },
    { at: '14:31:00', from: '山田', text: '前の発言 2' },
  ]);
  assert.equal((line.images as string[]).length, 1);
  const serialized = JSON.stringify(line);
  assert.doesNotMatch(serialized, /\d{10}\.\d{6}/, 'no ts');
  assert.doesNotMatch(serialized, /event|C1|U1|UBOT|F1/, 'no Slack or event ID');
  const images = await f.archive.images(f.events[0]!);
  assert.deepEqual(images, [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }]);
});

test('in a thread, the flow is the thread\'s own latest messages', async t => {
  const f = await setup(t);
  const parent = tsAt('2026-09-25T05:00:00Z');
  f.slack.emit(message({ text: 'スレッドの親', ts: parent }));
  f.slack.emit(message({ text: 'チャンネルの別の話', ts: tsAt('2026-09-25T05:10:00Z') }));
  f.slack.emit(message({ user: 'U2', text: 'スレッドの返信', ts: tsAt('2026-09-25T05:20:00Z'), thread_ts: parent }));
  f.slack.emit(message({ text: '<@UBOT> どう思う？', ts: tsAt(AT), thread_ts: parent }));
  await f.workspace.idle();
  const line = f.archive.eventLine(f.events[0]!, AT);
  assert.equal(line.in_thread, true);
  assert.deepEqual((line.context as { text: string }[]).map(item => item.text), ['スレッドの親', 'スレッドの返信']);
  assert.equal(line.reference, 'work/#dev 2026-09-25 14:32:05 山田');
});

test('a reply to a thread whose parent was never recorded fetches the parent, which is not counted as new', async t => {
  const f = await setup(t);
  const parent = tsAt('2026-09-20T05:00:00Z');
  f.slack.post('C1', { ts: parent, user: 'U2', text: '古い親', files: [] });
  f.slack.emit(message({ text: '古いスレッドへの返信', ts: tsAt(AT), thread_ts: parent }));
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-20.md');
  assert.match(text, /古い親/);
  assert.match(text, /古いスレッドへの返信/);
  assert.deepEqual(f.archive.take()?.new, { 'work/#dev': 1 });
});

/** No Slack ID of a channel, a person or a message, and no token, in a log line. */
function assertNoIds(logs: string[]) {
  for (const line of logs) {
    assert.doesNotMatch(line, /\b(?:[CDFGUW][A-Z0-9]*\d|UBOT)\b|\d{10}\.\d{6}|xox[a-z]-/, line);
  }
}

test('when one conversation\'s history is refused, the others are still filled in, and the log names the call and Slack\'s error', async t => {
  const f = await setup(t, { backfillDays: 2 });
  f.slack.addChannel({ id: 'D1', isIm: true, user: 'U2' });
  f.slack.addChannel({ id: 'C2', name: 'random', isIm: false });
  f.slack.post('C1', { ts: tsAt(AT), user: 'U1', text: 'dev の発言', files: [] });
  f.slack.post('D1', { ts: tsAt(AT), user: 'U2', text: 'DM の秘密の発言', files: [] });
  f.slack.post('C2', { ts: tsAt(AT), user: 'U1', text: 'random の発言', files: [] });
  f.slack.fail('history', 'D1', 'conversations.history', 'missing_scope', 'im:history');
  f.slack.connect();
  await f.workspace.idle();
  assert.match(await f.read('work/dev/2026-09-25.md'), /dev の発言/);
  assert.match(await f.read('work/random/2026-09-25.md'), /random の発言/);
  assert.ok(f.logs.includes('slack (work): filling in a conversation failed (conversations.history: missing_scope, needed im:history)'), f.logs.join('\n'));
  assert.ok(f.logs.includes('slack (work): filled in 2 message(s) from 2 conversation(s); 1 conversation(s) failed'), f.logs.join('\n'));
  assert.ok(!f.logs.some(line => line.includes('発言')), 'no text in the log');
  assertNoIds(f.logs);
});

test('when a thread cannot be fetched, its parent and the rest are still recorded', async t => {
  const f = await setup(t, { backfillDays: 2 });
  const parent = tsAt('2026-09-25T05:00:00Z');
  f.slack.post('C1', { ts: parent, user: 'U1', text: 'スレッドの親', files: [] });
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:01:00Z'), threadTs: parent, user: 'U2', text: '取れない返信', files: [] });
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:10:00Z'), user: 'U2', text: '次の発言', files: [] });
  f.slack.fail('replies', parent, 'conversations.replies', 'thread_not_found');
  f.slack.connect();
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-25.md');
  assert.match(text, /スレッドの親/);
  assert.match(text, /次の発言/);
  assert.ok(f.logs.includes('slack (work): a thread could not be fetched (conversations.replies: thread_not_found)'), f.logs.join('\n'));
  assert.ok(f.logs.includes('slack (work): filled in 2 message(s) from 1 conversation(s); 0 conversation(s) failed; 1 other failure(s)'), f.logs.join('\n'));
  assertNoIds(f.logs);
});

test('a speaker whose name cannot be looked up is recorded under a stand-in name, and the lookup is logged once per fill-in', async t => {
  const f = await setup(t, { backfillDays: 2 });
  f.slack.users.set('U3', '鈴木');
  f.slack.fail('userName', 'U3', 'users.info', 'user_not_found');
  f.slack.post('C1', { ts: tsAt(AT), user: 'U3', text: '一つ目', files: [] });
  f.slack.post('C1', { ts: tsAt('2026-09-25T05:33:00Z'), user: 'U3', text: '二つ目', files: [] });
  f.slack.connect();
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-25.md');
  assert.match(text, /^## 14:32:05 someone$/m);
  assert.match(text, /^## 14:33:00 someone$/m);
  const lines = f.logs.filter(line => line.includes('users.info'));
  assert.deepEqual(lines, ['slack (work): a name could not be looked up (users.info: user_not_found)']);
  assertNoIds(f.logs);
});

test('an image that cannot be fetched is only noted, and the message is recorded', async t => {
  const f = await setup(t);
  f.slack.fail('download', 'https://files.example.test/a.png', 'files.download', 'http_403');
  f.slack.emit(message({ text: '画像です', files: [
    { id: 'F1', name: 'a.png', mimetype: 'image/png', size: PNG.length, url_private_download: 'https://files.example.test/a.png' }] }));
  await f.workspace.idle();
  const text = await f.read('work/dev/2026-09-25.md');
  assert.match(text, /画像です/);
  assert.match(text, /- 添付あり（取り込まず）: a\.png/);
  assert.ok(f.logs.includes('slack (work): an image could not be fetched (files.download: http_403)'), f.logs.join('\n'));
  assertNoIds(f.logs);
});

test('a live event that fails, or a reaction Slack refuses, is logged with the call and Slack\'s error', async t => {
  const f = await setup(t);
  f.slack.fail('conversation', 'C7', 'conversations.info', 'channel_not_found');
  f.slack.emit(message({ channel: 'C7', text: '知らないチャンネル' }));
  const ts = tsAt('2026-09-25T05:40:00Z');
  f.slack.fail('addReaction', ts, 'reactions.add', 'missing_scope', 'reactions:write');
  f.slack.emit(message({ text: '<@UBOT> 見て', ts }));
  await f.workspace.idle();
  assert.ok(f.logs.includes('slack (work): handling an event failed (conversations.info: channel_not_found)'), f.logs.join('\n'));
  assert.ok(f.logs.includes('slack (work): the reaction could not be added (reactions.add: missing_scope, needed reactions:write)'), f.logs.join('\n'));
  assert.equal(f.events.length, 1, 'the mention is still an event');
  assertNoIds(f.logs);
});
