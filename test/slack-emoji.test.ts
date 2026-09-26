import assert from 'node:assert/strict';
import test from 'node:test';
import { EMOJI_REFETCH_MS, EMOJI_REFRESH_MS, SlackEmoji } from '../src/server/slack-emoji.ts';
import { FakeSlack } from './support/fake-slack.ts';

/**
 * Which emoji the dove may put on (ADR 0042): any standard emoji, with a skin tone where it takes one, and any custom
 * emoji of the workspace, aliases included. The custom ones are read with `emoji.list`, kept, and read again only now
 * and then; when they cannot be read, the standard ones are all there is, and the log says why.
 */

function setup() {
  const clock = { now: Date.parse('2026-09-26T00:00:00Z') };
  const work = new FakeSlack();
  const home = new FakeSlack();
  work.emoji.set('lgtm', 'https://emoji.example.test/lgtm.png');
  work.emoji.set('了解', 'https://emoji.example.test/ryokai.png');
  work.emoji.set('looks-good', 'alias:lgtm');
  work.emoji.set('thanks', 'alias:pray');
  home.emoji.set('neko', 'https://emoji.example.test/neko.png');
  const logs: string[] = [];
  const emoji = new SlackEmoji({ workspaces: { work, home }, now: () => clock.now, log: line => { logs.push(line); } });
  return { clock, work, home, emoji, logs };
}

test('a standard emoji is there in every workspace, by any of its names, without asking Slack', async () => {
  const f = setup();
  for (const name of ['+1', 'thumbsup', 'white_check_mark', 'eyes', 'pray', 'fire', 'tada', 'bow']) {
    assert.equal(await f.emoji.exists('work', name), true, name);
  }
  assert.equal(f.work.emojiCalls, 0);
});

test('a skin tone is there on a standard emoji that takes one, and only from 2 to 6', async () => {
  const f = setup();
  for (const name of ['+1::skin-tone-2', 'thumbsup::skin-tone-6', 'wave::skin-tone-4', 'bow::skin-tone-3']) {
    assert.equal(await f.emoji.exists('work', name), true, name);
  }
  for (const name of ['+1::skin-tone-1', '+1::skin-tone-7', 'fire::skin-tone-2', 'lgtm::skin-tone-2', 'nothing::skin-tone-2']) {
    assert.equal(await f.emoji.exists('work', name), false, name);
  }
});

test('a custom emoji and an alias are there in their own workspace only', async () => {
  const f = setup();
  for (const name of ['lgtm', '了解', 'looks-good', 'thanks']) assert.equal(await f.emoji.exists('work', name), true, name);
  assert.equal(await f.emoji.exists('home', 'lgtm'), false);
  assert.equal(await f.emoji.exists('home', 'neko'), true);
  assert.equal(await f.emoji.exists('work', 'neko'), false);
});

test('a name that is nowhere is not there', async () => {
  const f = setup();
  for (const name of ['no_such_emoji', 'thumbs_up', 'Eyes']) assert.equal(await f.emoji.exists('work', name), false, name);
  assert.equal(await f.emoji.exists('elsewhere', 'lgtm'), false, 'a workspace not configured has no custom emoji');
  assert.equal(await f.emoji.exists('elsewhere', '+1'), true);
});

test('the custom emoji are read once and kept: known names and unknown ones alike ask Slack no more than that', async () => {
  const f = setup();
  for (let i = 0; i < 20; i += 1) {
    assert.equal(await f.emoji.exists('work', 'lgtm'), true);
    assert.equal(await f.emoji.exists('work', `unknown_${i}`), false);
  }
  assert.equal(f.work.emojiCalls, 1);
});

test('asking at the same moment reads the list once', async () => {
  const f = setup();
  const answers = await Promise.all([f.emoji.exists('work', 'lgtm'), f.emoji.exists('work', 'nope'), f.emoji.exists('work', 'thanks')]);
  assert.deepEqual(answers, [true, false, true]);
  assert.equal(f.work.emojiCalls, 1);
});

test('an unknown name reads the list again once a while has passed, and a new emoji is then found', async () => {
  const f = setup();
  assert.equal(await f.emoji.exists('work', 'shipit'), false);
  f.work.emoji.set('shipit', 'https://emoji.example.test/shipit.png');
  assert.equal(await f.emoji.exists('work', 'shipit'), false, 'not read again at once');
  assert.equal(f.work.emojiCalls, 1);
  f.clock.now += EMOJI_REFETCH_MS;
  assert.equal(await f.emoji.exists('work', 'shipit'), true);
  assert.equal(f.work.emojiCalls, 2);
  assert.equal(await f.emoji.exists('work', 'still_nothing'), false);
  assert.equal(f.work.emojiCalls, 2, 'the next unknown name waits for the next while');
});

test('a known name is taken from what was kept until the list is old, and then the list is read again', async () => {
  const f = setup();
  assert.equal(await f.emoji.exists('work', 'lgtm'), true);
  f.clock.now += EMOJI_REFRESH_MS - 1;
  assert.equal(await f.emoji.exists('work', 'lgtm'), true);
  assert.equal(f.work.emojiCalls, 1);
  f.work.emoji.delete('lgtm');
  f.clock.now += 1;
  assert.equal(await f.emoji.exists('work', 'lgtm'), false, 'an emoji removed from the workspace is gone once the list is read again');
  assert.equal(f.work.emojiCalls, 2);
});

test('warming up reads every workspace once, and the first requests ask Slack nothing more', async () => {
  const f = setup();
  await f.emoji.warm();
  assert.equal(f.work.emojiCalls, 1);
  assert.equal(f.home.emojiCalls, 1);
  assert.equal(await f.emoji.exists('work', 'lgtm'), true);
  assert.equal(await f.emoji.exists('home', 'neko'), true);
  assert.equal(f.work.emojiCalls + f.home.emojiCalls, 2);
});

test('when the list cannot be read, the standard emoji are all there is, one line is logged, and Slack is not asked again at once', async () => {
  const f = setup();
  f.work.fail('customEmoji', '', 'emoji.list', 'missing_scope', 'emoji:read');
  assert.equal(await f.emoji.exists('work', 'lgtm'), false);
  assert.equal(await f.emoji.exists('work', '+1'), true);
  assert.equal(await f.emoji.exists('work', 'thanks'), false);
  assert.deepEqual(f.logs, ['slack (work): the custom emoji could not be read (emoji.list: missing_scope, needed emoji:read)']);
  assert.equal(f.work.emojiCalls, 1);
  assert.equal(await f.emoji.exists('home', 'neko'), true, 'another workspace is not held back');

  f.work.failures.clear();
  f.clock.now += EMOJI_REFETCH_MS;
  assert.equal(await f.emoji.exists('work', 'lgtm'), true, 'the scope added, the custom emoji are there the next time');
  assert.equal(f.work.emojiCalls, 2);
});

test('a list read before a failure is still used after it', async () => {
  const f = setup();
  assert.equal(await f.emoji.exists('work', 'lgtm'), true);
  f.work.fail('customEmoji', '', 'emoji.list', 'ratelimited');
  f.clock.now += EMOJI_REFRESH_MS;
  assert.equal(await f.emoji.exists('work', 'lgtm'), true);
  assert.deepEqual(f.logs, ['slack (work): the custom emoji could not be read (emoji.list: ratelimited)']);
});
