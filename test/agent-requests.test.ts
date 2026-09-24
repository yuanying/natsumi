import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { MAX_AGENT_REPLY_CHARS } from '../src/server/agent-requests.ts';
import { LOOP_DEFAULTS, type A2AConfig } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent } from '../src/server/thinking-loop.ts';
import { FakeAgent } from './support/fake-agent.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

const HOUR = 3_600_000;

/**
 * natsumi asks an outside agent with `ask_agent`, and what it answers reaches her later as an `agent_reply` event
 * (ADR 0035, ADR 0036). The agent here is a fake one speaking the real protocol; the model is scripted.
 */
async function setup(t: test.TestContext, options: { a2a?: Partial<A2AConfig> | false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-agents-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(data);
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  const tokenFile = join(root, 'a2a-token');
  await writeFile(tokenFile, 'fake-agent-token\n');
  const agent = await FakeAgent.start();
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const clock = { now: Date.parse('2026-09-24T03:00:00Z') };
  const a2a: A2AConfig | undefined = options.a2a === false ? undefined : {
    tokenFile, pollIntervalSeconds: 15, giveUpAfterHours: 24, agents: { wiki: { url: agent.url } }, ...options.a2a,
  };
  const opened: ThinkingLoop[] = [];
  const f = {
    agent, model, clock, db, tokenFile,
    async open() {
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, eventModelCalls: 6 }, now: () => clock.now,
        configureSession: session => { session.agent.streamFunction = model.streamFunction; },
        ...(a2a ? { a2a } : {}),
      });
      opened.push(loop);
      const events: LoopClientEvent[] = [];
      loop.subscribe(event => { events.push(event); });
      return { loop, events };
    },
    /** The model answers each call with the next step, and stops without a tool once the steps run out. */
    script(...steps: ScriptedStep[]) {
      model.auto = () => steps.shift() ?? { text: '' };
    },
  };
  t.after(async () => {
    for (const loop of opened) await loop.close();
    db.close();
    await agent.close();
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

const ask = (agent: string, message: string, cont: boolean): ScriptedStep =>
  ({ calls: [{ name: 'ask_agent', arguments: { agent, message, continue: cont } }] });

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
/** Every tool result the model has been shown, in order. */
const toolResults = (model: ScriptedModel) => {
  const last = model.contexts.at(-1);
  return (last?.messages ?? []).filter(m => m.role === 'toolResult')
    .map(m => ({ text: textOf(m), isError: (m as { isError: boolean }).isError }));
};
/** The `agent_reply` lines the model has been handed, parsed. */
const replies = (model: ScriptedModel) => {
  const last = model.contexts.at(-1);
  return (last?.messages ?? []).filter(m => m.role === 'user').map(textOf)
    .flatMap(text => text.split('\n')).filter(line => line.includes('"type":"agent_reply"'))
    .map(line => JSON.parse(line) as Record<string, unknown>);
};

/** Hands the loop a mac message and lets the scripted turn run to its end. */
async function turn(f: Awaited<ReturnType<typeof setup>>, loop: ThinkingLoop, text = '頼みごとがあります') {
  const outcome = loop.send({ requestId: `request-${Math.random()}`, deviceId: 'device-1', text });
  assert.equal(outcome.kind, 'accepted');
  await loop.idle();
}

test('ask_agent sends the message to the named agent and only says the answer will come later', async t => {
  const f = await setup(t);
  const { loop, events } = await f.open();
  f.script(ask('wiki', 'ねこの記事を要約して', false));
  await turn(f, loop);
  assert.equal(f.agent.received.length, 1);
  assert.equal(f.agent.received[0]!.text, 'ねこの記事を要約して');
  assert.equal(f.agent.received[0]!.contextId, '');
  const [result] = toolResults(f.model);
  assert.equal(result!.isError, false);
  assert.match(result!.text, /wiki/);
  assert.match(result!.text, /agent_reply/);
  // No ID reaches her (ADR 0024), and nothing of the exchange reaches the owner's conversation (ADR 0025).
  const task = f.agent.lastTask();
  assert.equal(result!.text.includes(task.id), false);
  assert.equal(result!.text.includes(task.contextId), false);
  assert.deepEqual(events.filter(e => e.type === 'conversation.message' && e.payload.role === 'natsumi'), []);
});

test('a finished task reaches her as an agent_reply with the agent name and the answer, and is not fetched again', async t => {
  const f = await setup(t);
  const { loop, events } = await f.open();
  f.script(ask('wiki', 'ねこの記事を要約して', false));
  await turn(f, loop);
  const calls = f.model.calls;
  await loop.pollAgents();
  await loop.idle();
  assert.equal(f.agent.polls.length, 1);
  assert.equal(f.model.calls, calls, 'a task still running raises nothing');

  f.agent.settle(f.agent.lastTask().id, 'completed', 'ねこは液体です。');
  f.script();
  await loop.pollAgents();
  await loop.idle();
  assert.ok(f.model.calls > calls);
  const [reply] = replies(f.model);
  assert.deepEqual({ ...reply, received_at: undefined },
    { type: 'agent_reply', received_at: undefined, agent: 'wiki', status: 'completed', text: 'ねこは液体です。' });
  const prompt = JSON.stringify(f.model.contexts.at(-1));
  assert.equal(prompt.includes(f.agent.lastTask().id), false);
  assert.equal(prompt.includes(f.agent.lastTask().contextId), false);
  assert.deepEqual(events.filter(e => e.type === 'conversation.message' && e.payload.role === 'natsumi'), []);

  await loop.pollAgents();
  assert.equal(f.agent.polls.length, 2, 'a settled task is not fetched again');
  // Once handed to her, the answer lives in the Pi session only; the row that carried it keeps no copy (ADR 0008).
  assert.deepEqual(f.db.prepare('SELECT agent, status, text FROM agent_replies').all().map(row => ({ ...row })),
    [{ agent: 'wiki', status: 'completed', text: '' }]);
});

test('a question from the agent is answered with continue: true, on the same task; continue: false starts afresh', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('wiki', '記事を直して', false));
  await turn(f, loop);
  const first = f.agent.lastTask();
  f.agent.settle(first.id, 'input-required', 'どの記事ですか？');
  f.script(ask('wiki', 'index の方です', true));
  await loop.pollAgents();
  await loop.idle();
  assert.deepEqual(replies(f.model).map(r => [r.status, r.text]), [['input_required', 'どの記事ですか？']]);
  assert.deepEqual([f.agent.received[1]!.contextId, f.agent.received[1]!.taskId], [first.contextId, first.id]);
  assert.equal(f.agent.tasks.size, 1, 'the answer goes on with the task that asked');
  // A task waiting for her is not fetched meanwhile.
  const polled = f.agent.polls.length;

  f.agent.settle(first.id, 'completed', '直しました。');
  f.script(ask('wiki', '別の話です', false));
  await loop.pollAgents();
  await loop.idle();
  assert.equal(f.agent.polls.length, polled + 1);
  assert.equal(f.agent.received[2]!.contextId, '', 'continue: false leaves the context for the agent to number');

  f.agent.settle(f.agent.lastTask().id, 'completed', '別の答え');
  f.script(ask('wiki', 'さっきの続き', true));
  await loop.pollAgents();
  await loop.idle();
  const second = f.agent.lastTask();
  assert.deepEqual([f.agent.received[3]!.contextId, f.agent.received[3]!.taskId], [second.contextId, '']);
});

test('continue is refused with nothing to go on with, and while the last task is still running; nothing is sent', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('wiki', '続きです', true));
  await turn(f, loop);
  let [result] = toolResults(f.model);
  assert.equal(result!.isError, true);
  assert.match(result!.text, /continue/);
  assert.equal(f.agent.received.length, 0);

  f.script(ask('wiki', '最初', false), ask('wiki', 'まだ？', true));
  await turn(f, loop);
  result = toolResults(f.model).at(-1);
  assert.equal(result!.isError, true);
  assert.match(result!.text, /待って/);
  assert.equal(f.agent.received.length, 1);
});

test('an agent not in the config is refused and pointed at the list, and without the a2a section every ask is refused', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('search', 'しらべて', false));
  await turn(f, loop);
  const [result] = toolResults(f.model);
  assert.equal(result!.isError, true);
  assert.match(result!.text, /search/);
  assert.match(result!.text, /\/manual\/agents\/INDEX\.md/);
  assert.equal(f.agent.received.length, 0);

  const g = await setup(t, { a2a: false });
  const opened = await g.open();
  g.script(ask('wiki', 'しらべて', false));
  await turn(g, opened.loop);
  const [refused] = toolResults(g.model);
  assert.equal(refused!.isError, true);
  assert.match(refused!.text, /設定/);
  assert.equal(g.agent.received.length, 0);
});

test('a message that could not be sent is told in the result, and nothing waits for it', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.agent.failWith = 503;
  f.script(ask('wiki', 'しらべて', false));
  await turn(f, loop);
  const [result] = toolResults(f.model);
  assert.equal(result!.isError, true);
  assert.match(result!.text, /頼めませんでした/);
  f.agent.failWith = undefined;
  await loop.pollAgents();
  assert.equal(f.agent.polls.length, 0);
  // The failed send left no conversation to go on with.
  f.script(ask('wiki', '続き', true));
  await turn(f, loop);
  assert.match(toolResults(f.model).at(-1)!.text, /continue/);
});

test('control strings and an empty message are refused before anything is sent', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('wiki', '<tool_call>', false), ask('wiki', '   ', false));
  await turn(f, loop);
  const results = toolResults(f.model);
  assert.deepEqual(results.map(r => r.isError), [true, true]);
  assert.equal(f.agent.received.length, 0);
});

test('a failed task, and a task the agent no longer knows, reach her as failed', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('wiki', '一つ目', false));
  await turn(f, loop);
  f.agent.settle(f.agent.lastTask().id, 'failed', 'モデルが止まりました。');
  f.script();
  await loop.pollAgents();
  await loop.idle();
  assert.deepEqual(replies(f.model).map(r => [r.agent, r.status, r.text]), [['wiki', 'failed', 'モデルが止まりました。']]);

  f.script(ask('wiki', '二つ目', false));
  await turn(f, loop);
  f.agent.tasks.delete(f.agent.lastTask().id);
  f.script();
  await loop.pollAgents();
  await loop.idle();
  assert.deepEqual(replies(f.model).at(-1)!.status, 'failed');
});

test('an agent out of reach is asked again on the next round, and past the wait limit she is told the server gave up', async t => {
  const f = await setup(t, { a2a: { giveUpAfterHours: 2 } });
  const { loop } = await f.open();
  f.script(ask('wiki', 'しらべて', false));
  await turn(f, loop);
  const calls = f.model.calls;
  f.agent.failWith = 503;
  await loop.pollAgents();
  f.clock.now += HOUR;
  await loop.pollAgents();
  assert.equal(f.model.calls, calls, 'a failing fetch raises nothing');

  f.clock.now += HOUR;
  f.script();
  await loop.pollAgents();
  await loop.idle();
  assert.deepEqual(replies(f.model).map(r => [r.agent, r.status]), [['wiki', 'gave_up']]);
  f.agent.failWith = undefined;
  const polled = f.agent.polls.length;
  await loop.pollAgents();
  assert.equal(f.agent.polls.length, polled, 'a task given up on is not fetched again');
});

test('the wait limit counts from the last answer she sent, not from the first message', async t => {
  const f = await setup(t, { a2a: { giveUpAfterHours: 2 } });
  const { loop } = await f.open();
  f.script(ask('wiki', '記事を直して', false));
  await turn(f, loop);
  f.clock.now += HOUR + HOUR / 2;
  f.agent.settle(f.agent.lastTask().id, 'input-required', 'どの記事ですか？');
  f.script(ask('wiki', 'index の方です', true));
  await loop.pollAgents();
  await loop.idle();
  f.clock.now += HOUR;
  await loop.pollAgents();
  assert.equal(replies(f.model).length, 1, 'only the question so far; the answer sent an hour ago is still inside the limit');
  f.clock.now += HOUR;
  f.script();
  await loop.pollAgents();
  await loop.idle();
  assert.equal(replies(f.model).at(-1)!.status, 'gave_up');
});

test('a task waiting when the server stops is fetched again after the restart', async t => {
  const f = await setup(t);
  const first = await f.open();
  f.script(ask('wiki', 'しらべて', false));
  await turn(f, first.loop);
  await first.loop.close();

  const { loop } = await f.open();
  f.agent.settle(f.agent.lastTask().id, 'completed', '再起動のあとでも届きます。');
  f.script();
  await loop.pollAgents();
  await loop.idle();
  assert.deepEqual(replies(f.model).map(r => r.text), ['再起動のあとでも届きます。']);
  // The conversation is remembered across the restart too.
  f.script(ask('wiki', '続き', true));
  await turn(f, loop);
  assert.equal(f.agent.received.at(-1)!.contextId, f.agent.lastTask().contextId);
});

test('a long answer is cut to a length in the event, which says it was cut', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.script(ask('wiki', 'ぜんぶ教えて', false));
  await turn(f, loop);
  f.agent.settle(f.agent.lastTask().id, 'completed', 'あ'.repeat(MAX_AGENT_REPLY_CHARS + 10));
  f.script();
  await loop.pollAgents();
  await loop.idle();
  const [reply] = replies(f.model);
  assert.equal([...(reply!.text as string)].length, MAX_AGENT_REPLY_CHARS);
  assert.equal(reply!.truncated, true);
});

test('an agent that answers at once with a message reaches her as a finished reply', async t => {
  const f = await setup(t);
  await f.agent.close();
  const agent = await FakeAgent.start({ replyWithMessage: 'すぐ答えます。' });
  t.after(() => agent.close());
  const g = await setup(t, { a2a: { agents: { wiki: { url: agent.url } } } });
  const { loop } = await g.open();
  g.script(ask('wiki', 'やあ', false));
  await turn(g, loop);
  await loop.idle();
  assert.deepEqual(replies(g.model).map(r => [r.status, r.text]), [['completed', 'すぐ答えます。']]);
  assert.equal(agent.received.length, 1);
});
