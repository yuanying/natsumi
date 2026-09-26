import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { LOOP_DEFAULTS } from '../src/server/config.ts';
import { LOOP_TOOL_NAMES, RUN_SHELL_TOOL_NAME } from '../src/server/loop-tools.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop } from '../src/server/thinking-loop.ts';
import type { UpdateSource } from '../src/server/updates.ts';
import { PNG } from './support/fake-slack.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';

/**
 * What the loop makes of Slack (ADR 0039): a mention is an event of its own with its images beside it, and the
 * `updates` of a ping carry what every source counted since it was last shown — and nothing when nothing came.
 */

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** A source that counts what the test tells it to, and forgets it once shown. */
class CountingSource implements UpdateSource {
  readonly name = 'slack';
  pending: Record<string, number> = {};
  take() {
    if (Object.keys(this.pending).length === 0) return undefined;
    const shown = { new: this.pending, files: ['/sources/slack/work/dev/2026-09-25.md'] };
    this.pending = {};
    return shown;
  }
}

/** A dove that takes every request and answers with the line the test put in for each event. */
class FakeDove {
  readonly asked: string[] = [];
  readonly lines = new Map<string, Record<string, unknown>>();
  ask(message: string) {
    this.asked.push(message);
    return { ok: true, text: 'ポッポさんが投稿の依頼を受け付けました。' };
  }
  takeEventLine(eventId: string, receivedAt: string) {
    return { ...this.lines.get(eventId) ?? { type: 'agent_reply', agent: 'poppo' }, received_at: receivedAt };
  }
}

async function setup(t: test.TestContext, options: { shell?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-slack-loop-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(data);
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  model.auto = () => ({ text: '' });
  const source = new CountingSource();
  const lines = new Map<string, Record<string, unknown>>();
  const dove = new FakeDove();
  const loop = await ThinkingLoop.open({
    db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
    runtime: fixtureRuntime,
    loop: { ...LOOP_DEFAULTS, eventModelCalls: 4, ...(options.shell ? { workspaceSocket: join(root, 'no-runner.sock') } : {}) },
    configureSession: session => { session.agent.streamFunction = model.streamFunction; },
    updates: [source],
    slack: {
      eventLine: eventId => lines.get(eventId) ?? { type: 'slack_mention' },
      images: async () => [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }],
    },
    dove,
  });
  t.after(async () => {
    await loop.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, data, db, loop, model, source, lines, dove };
}

const userMessages = (context: Context) => context.messages.filter(message => message.role === 'user');
const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};

test('a Slack mention is handed to natsumi as its own event, with its images beside it', async t => {
  const f = await setup(t);
  f.loop.raise('slack-mention', eventId => {
    f.lines.set(eventId, { type: 'slack_mention', text: '@natsumi これ見て', reference: 'work/#dev 2026-09-25 14:32:05 山田' });
  });
  const context = await until(() => f.model.contexts[0]);
  const prompt = userMessages(context).at(-1)!;
  assert.match(textOf(prompt), /"type":"slack_mention"/);
  assert.match(textOf(prompt), /work\/#dev 2026-09-25 14:32:05 山田/);
  const parts = (prompt as { content: { type: string; data?: string }[] }).content;
  assert.deepEqual(parts.filter(part => part.type === 'image').map(part => part.data), [PNG.toString('base64')]);
  await f.loop.idle();
  const row = f.db.prepare(`SELECT kind, state FROM loop_events`).get() as { kind: string; state: string };
  assert.deepEqual({ ...row }, { kind: 'slack-mention', state: 'no-reply' });
});

test('a ping carries the updates once, and none when nothing came since', async t => {
  const f = await setup(t);
  f.source.pending = { 'work/#dev': 3 };
  assert.equal(f.loop.ping(), true);
  await f.loop.idle();
  const first = textOf(userMessages(f.model.contexts.at(-1)!).at(-1)!);
  assert.match(first, /"updates":\{"slack":\{"new":\{"work\/#dev":3\},"files":\["\/sources\/slack\/work\/dev\/2026-09-25\.md"\]\}\}/);
  assert.equal(f.loop.ping(), true);
  await f.loop.idle();
  const second = textOf(userMessages(f.model.contexts.at(-1)!).at(-1)!);
  assert.match(second, /"type":"ping"/);
  assert.doesNotMatch(second, /updates/);
});

test('an owner message carries no updates: they wait for the next ping', async t => {
  const f = await setup(t);
  f.source.pending = { 'work/#dev': 1 };
  f.loop.send({ requestId: 'r1', deviceId: 'd1', text: 'こんにちは' });
  await f.loop.idle();
  assert.doesNotMatch(textOf(userMessages(f.model.contexts.at(-1)!).at(-1)!), /updates/);
  assert.deepEqual(f.source.pending, { 'work/#dev': 1 });
});

test('view in the shell answers with the image, from the server, without the runner', async t => {
  const f = await setup(t, { shell: true });
  await mkdir(join(f.data, 'sources', 'slack'), { recursive: true });
  await writeFile(join(f.data, 'sources', 'slack', 'a.png'), PNG);
  f.model.takeOver();
  f.loop.ping();
  const first = await f.model.next();
  first.call('run_shell', { command: 'view /sources/slack/a.png' });
  first.finish();
  const second = await f.model.next();
  const result = second.context.messages.find(message => message.role === 'toolResult') as
    { content: { type: string; data?: string; text?: string }[]; isError?: boolean };
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.filter(part => part.type === 'image').map(part => part.data), [PNG.toString('base64')]);
  second.finish();
  await f.loop.idle();
});

test('natsumi has no tool that posts to Slack: a post is a request to the dove through ask_agent', async t => {
  const f = await setup(t);
  f.model.takeOver();
  f.loop.ping();
  const first = await f.model.next();
  for (const name of [...LOOP_TOOL_NAMES, RUN_SHELL_TOOL_NAME]) assert.doesNotMatch(name, /slack|post|chat|reaction|dove|poppo/i, name);
  first.call('ask_agent', { agent: 'poppo', message: '返信先: work/#dev\n種類: 投稿\n---\nおはよう', continue: false });
  first.finish();
  const second = await f.model.next();
  const result = second.context.messages.find(message => message.role === 'toolResult') as { content: { text?: string }[]; isError?: boolean };
  assert.equal(result.isError, false);
  assert.match(result.content[0]!.text!, /ポッポさん/);
  assert.deepEqual(f.dove.asked, ['返信先: work/#dev\n種類: 投稿\n---\nおはよう']);
  second.finish();
  await f.loop.idle();
});

test('the dove\'s answer is an event of its own, read from the dove', async t => {
  const f = await setup(t);
  f.loop.raise('dove-reply', eventId => { f.dove.lines.set(eventId, { type: 'agent_reply', agent: 'poppo', result: 'sent', text: 'ポッポ！' }); });
  const context = await until(() => f.model.contexts[0]);
  const prompt = textOf(userMessages(context).at(-1)!);
  assert.match(prompt, /"type":"agent_reply","agent":"poppo","result":"sent","text":"ポッポ！"/);
  await f.loop.idle();
});
