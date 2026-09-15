import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/pi-session.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions, type SendOutcome } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

// Fictional memories only.
const PASSPHRASE = 'SYNTHETIC-HERON-208';
const HANDOFF = 'HANDOFF-MARKER-5530';
const EARLIER = 'EARLIER-DAY-TOKEN-77';

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-memory-loop-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(join(data, 'memory'), { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(data, 'personality.md'), '# 性格・話し方\n落ち着いた話し方\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const sessions: AgentSession[] = [];
  const opened: ThinkingLoop[] = [];
  let counter = 0;
  const f = {
    root, data, sessionDirectory, db, model, sessions,
    async open(options: Partial<LoopOptions> = {}) {
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, maxModelCalls: 4, timeZone: 'Asia/Tokyo',
        configureSession: session => { session.agent.streamFunction = model.streamFunction; sessions.push(session); },
        ...options,
      });
      opened.push(loop);
      const events: LoopClientEvent[] = [];
      loop.subscribe(event => { events.push(event); });
      return { loop, events };
    },
    send(loop: ThinkingLoop, text: string) {
      const outcome = loop.send({ requestId: `request-${++counter}`, deviceId: 'device-1', text });
      assert.equal(outcome.kind, 'accepted', JSON.stringify(outcome));
      return outcome as Extract<SendOutcome, { kind: 'accepted' }>;
    },
    rows: () => f.db.prepare('SELECT * FROM conversations').all() as Record<string, unknown>[],
    sessionFiles: async () => (await readdir(sessionDirectory)).filter(name => name.endsWith('.jsonl')).sort(),
    async cleanup() {
      for (const loop of opened) await loop.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
const lastUserText = (context: Context) => textOf(context.messages.filter(m => m.role === 'user').at(-1)!);
const eventLines = (text: string) => [...text.matchAll(/^\{.*\}$/gm)].map(match => JSON.parse(match[0]) as Record<string, string>);
const toolResults = (context: Context) => {
  const lastAssistant = context.messages.map(m => m.role).lastIndexOf('assistant');
  return context.messages.slice(lastAssistant + 1).filter(m => m.role === 'toolResult')
    .map(m => ({ text: textOf(m), isError: (m as { isError: boolean }).isError }));
};
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
const isSummary = (context: Context) => (context.systemPrompt ?? '').includes('summarization');
const completed = (events: LoopClientEvent[], eventId: string) =>
  until(() => events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === eventId));
const replies = (events: LoopClientEvent[]) => events.filter(e => e.type === 'conversation.message' && e.payload.role === 'natsumi').map(e => e.payload.text);

/** A model that answers owner messages and nightly reviews the way the test describes, and summarizes for compaction. */
function behave(f: Awaited<ReturnType<typeof setup>>, handlers: {
  owner?: (event: Record<string, string>, context: Context) => ScriptedStep;
  review?: (event: Record<string, string>, context: Context) => ScriptedStep;
}) {
  f.model.auto = context => {
    if (isSummary(context)) return `要約: ${JSON.stringify(context.messages).includes(PASSPHRASE) ? PASSPHRASE : 'なし'}`;
    const [event] = eventLines(lastUserText(context));
    if (!event || context.messages.at(-1)?.role !== 'user') return { calls: [] };
    if (event.type === 'nightly_review') {
      return handlers.review?.(event, context) ?? { calls: [call('finish_event', { event_id: event.event_id })] };
    }
    return handlers.owner?.(event, context)
      ?? { calls: [call('reply_to_mac', { event_id: event.event_id, text: 'はい' }), call('finish_event', { event_id: event.event_id })] };
  };
}

test('remember writes under memory/, recall reads it back, and memories never ride in the system prompt', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const first = f.send(loop, `合言葉は ${PASSPHRASE}。覚えておいて`);
    const call1 = await f.model.next();
    call1.call('remember', { topic: '合言葉', note: `合言葉は ${PASSPHRASE}` });
    call1.finish();
    const call2 = await f.model.next();
    const [remembered] = toolResults(call2.context);
    assert.equal(remembered!.isError, false);
    assert.match(remembered!.text, /合言葉/);
    call2.call('reply_to_mac', { event_id: first.eventId, text: '覚えました' });
    call2.call('finish_event', { event_id: first.eventId });
    call2.finish();
    await completed(events, first.eventId);
    assert.match(await readFile(join(f.data, 'memory', '合言葉.md'), 'utf8'), new RegExp(`^- \\d{4}-\\d{2}-\\d{2}: 合言葉は ${PASSPHRASE}$`, 'm'));

    // A later question is answered from what recall returns.
    await loop.close();
    const again = await f.open();
    const asked = f.send(again.loop, '合言葉は何だっけ');
    const call3 = await f.model.next();
    assert.equal(call3.context.systemPrompt?.includes(PASSPHRASE), false);
    call3.call('recall', { query: '合言葉' });
    call3.call('read_memory', { topic: '合言葉' });
    call3.finish();
    const call4 = await f.model.next();
    const results = toolResults(call4.context);
    assert.deepEqual(results.map(r => r.isError), [false, false]);
    for (const result of results) assert.match(result.text, new RegExp(PASSPHRASE));
    call4.call('reply_to_mac', { event_id: asked.eventId, text: PASSPHRASE });
    call4.call('finish_event', { event_id: asked.eventId });
    call4.finish();
    await completed(again.events, asked.eventId);
    for (const context of f.model.contexts) assert.equal((context.systemPrompt ?? '').includes(PASSPHRASE), false);
    // What the owner sees is only the conversation; the memory tools stay inside.
    assert.equal(JSON.stringify(again.loop.snapshot()).includes('remember'), false);
  } finally { await f.cleanup(); }
});

test('the memory tools refuse path tricks and forget removes a memory', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, '整理して');
    const call1 = await f.model.next();
    call1.call('remember', { topic: '../../escape', note: '外に出ない' });
    call1.call('remember', { topic: '予定', note: '歯医者は金曜' });
    call1.call('forget', { topic: '予定', text: '歯医者' });
    call1.call('remember', { topic: '予定', note: '<tool_call>' });
    call1.finish();
    const call2 = await f.model.next();
    assert.deepEqual(toolResults(call2.context).map(r => r.isError), [false, false, false, true]);
    call2.call('finish_event', { event_id: sent.eventId });
    call2.finish();
    await completed(events, sent.eventId);
    // The topic lost its only memory, so its file is gone.
    assert.deepEqual((await readdir(join(f.data, 'memory'))).sort(), ['escape.md']);
    assert.deepEqual((await readdir(f.root)).filter(name => !name.startsWith('state.sqlite')).sort(), ['data', 'pi']);
  } finally { await f.cleanup(); }
});

test('the nightly switch reviews the day, starts a new session with the handoff, keeps the old file and the shown conversation', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    let reviewedWith: Context | undefined;
    behave(f, {
      review: (event, context) => {
        reviewedWith = context;
        return { calls: [
          call('remember', { topic: '一日の記録', note: `${EARLIER} を覚えた` }),
          call('write_handoff_note', { event_id: event.event_id, text: `${HANDOFF} 明日は資料の続きを確認する` }),
          call('finish_event', { event_id: event.event_id }),
        ] };
      },
    });
    const day = f.send(loop, `今日の話: ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();
    const shown = loop.snapshot().messages;
    const [oldFile] = await f.sessionFiles();
    const oldRow = f.rows()[0]!;

    const outcome = await loop.rotate();
    assert.equal(outcome.result, 'switched');
    // The review ran in the old session, which still had the day in its context.
    const [reviewEvent] = eventLines(lastUserText(reviewedWith!));
    assert.equal(reviewEvent!.type, 'nightly_review');
    assert.ok(JSON.stringify(reviewedWith!.messages).includes(EARLIER));

    const files = await f.sessionFiles();
    assert.equal(files.length, 2);
    assert.ok(files.includes(oldFile!));
    assert.ok((await readFile(join(f.sessionDirectory, oldFile!), 'utf8')).includes(EARLIER));
    const row = f.rows()[0]!;
    assert.equal(row.conversation_id, oldRow.conversation_id);
    assert.notEqual(row.pi_session_id, oldRow.pi_session_id);
    assert.notEqual(row.pi_session_file, oldFile);
    assert.match(await readFile(join(f.data, 'memory', '一日の記録.md'), 'utf8'), new RegExp(EARLIER));
    assert.deepEqual(loop.snapshot().messages, shown);
    // The owner saw natsumi sleeping, and nothing of the review.
    assert.ok(events.some(e => e.type === 'avatar.expression' && e.payload.expression === 'sleepy'));
    assert.equal(loop.snapshot().avatar.expression, 'neutral');
    assert.equal(JSON.stringify(events).includes(HANDOFF), false);

    // The next day starts in the new session: the handoff is in the instructions, the old context is not.
    let next: Context | undefined;
    behave(f, { owner: (event, context) => { next = context; return { calls: [call('finish_event', { event_id: event.event_id })] }; } });
    const morning = f.send(loop, 'おはよう');
    await completed(events, morning.eventId);
    assert.match(next!.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.equal(JSON.stringify(next!.messages).includes(EARLIER), false);

    // A restart opens the new session with the same handoff.
    await loop.close();
    const restarted = await f.open();
    assert.equal(restarted.loop.unavailable, undefined);
    const later = f.send(restarted.loop, 'また来た');
    await completed(restarted.events, later.eventId);
    assert.match(next!.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.deepEqual(await f.sessionFiles(), files);
  } finally { await f.cleanup(); }
});

test('an owner message that arrives during the nightly switch waits and is handled in the new session', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {});
    const day = f.send(loop, `昼の話 ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();
    f.model.takeOver();

    const rotating = loop.rotate();
    const review = await f.model.next();
    const [reviewEvent] = eventLines(lastUserText(review.context));
    const late = f.send(loop, '夜中にごめん、これ見て');
    assert.equal(late.state, 'queued');
    assert.deepEqual(loop.snapshot().pendingEvents.map(e => e.eventId), [late.eventId]);
    review.call('write_handoff_note', { event_id: reviewEvent!.event_id, text: `${HANDOFF} 引き継ぎ` });
    review.call('finish_event', { event_id: reviewEvent!.event_id });
    review.finish();

    const answer = await f.model.next();
    assert.match(lastUserText(answer.context), /夜中にごめん/);
    assert.match(answer.context.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.equal(JSON.stringify(answer.context.messages).includes(EARLIER), false);
    answer.call('reply_to_mac', { event_id: late.eventId, text: '見ました' });
    answer.call('finish_event', { event_id: late.eventId });
    answer.finish();
    assert.equal((await rotating).result, 'switched');
    assert.equal((await completed(events, late.eventId)).payload.status, 'replied');
    assert.deepEqual(replies(events), ['はい', '見ました']);
  } finally { await f.cleanup(); }
});

test('a review without a handoff note keeps the current session, and the tools refuse what does not belong to the event', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {});
    const day = f.send(loop, `昼の話 ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();
    const before = await f.sessionFiles();
    const row = f.rows()[0];

    f.model.takeOver();
    const rotating = loop.rotate();
    const review = await f.model.next();
    const [reviewEvent] = eventLines(lastUserText(review.context));
    review.call('notify_owner', { text: '夜の報告' });
    review.call('reply_to_mac', { event_id: reviewEvent!.event_id, text: '返事' });
    review.finish();
    const review2 = await f.model.next();
    assert.deepEqual(toolResults(review2.context).map(r => r.isError), [true, true]);
    review2.call('finish_event', { event_id: reviewEvent!.event_id });
    review2.finish();
    const outcome = await rotating;
    assert.deepEqual(outcome, { result: 'failed', reason: 'no-handoff' });
    assert.deepEqual(await f.sessionFiles(), before);
    assert.deepEqual(f.rows()[0], row);

    // The handoff tool is refused outside the review, and the day goes on in the same session.
    behave(f, {});
    let seen: Context | undefined;
    f.model.auto = context => {
      if (context.messages.at(-1)?.role !== 'user') return { calls: [] };
      seen = context;
      const [event] = eventLines(lastUserText(context));
      return { calls: [call('write_handoff_note', { event_id: event!.event_id, text: '勝手な引き継ぎ' }),
        call('reply_to_mac', { event_id: event!.event_id, text: '続けます' }), call('finish_event', { event_id: event!.event_id })] };
    };
    const next = f.send(loop, 'まだ起きてる？');
    await completed(events, next.eventId);
    assert.ok(JSON.stringify(seen!.messages).includes(EARLIER));
    assert.equal(replies(events).at(-1), '続けます');
    assert.equal(outcome.result, 'failed');
    assert.equal(f.model.contexts.some(c => (c.systemPrompt ?? '').includes('勝手な引き継ぎ')), false);
  } finally { await f.cleanup(); }
});

test('a handoff note in non-Japanese script is refused and never reaches the next session\'s instructions', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {});
    const day = f.send(loop, `昼の話 ${EARLIER}`);
    await completed(events, day.eventId);
    await loop.idle();

    f.model.takeOver();
    const rotating = loop.rotate();
    const review = await f.model.next();
    const [reviewEvent] = eventLines(lastUserText(review.context));
    review.call('write_handoff_note', { event_id: reviewEvent!.event_id, text: `${HANDOFF} 简洁にまとめる` });
    review.finish();
    const review2 = await f.model.next();
    const [refused] = toolResults(review2.context);
    assert.equal(refused!.isError, true);
    assert.match(refused!.text, /日本語以外/);
    review2.call('write_handoff_note', { event_id: reviewEvent!.event_id, text: `${HANDOFF} 簡潔にまとめる` });
    review2.call('finish_event', { event_id: reviewEvent!.event_id });
    review2.finish();
    assert.equal((await rotating).result, 'switched');

    let next: Context | undefined;
    behave(f, { owner: (event, context) => { next = context; return { calls: [call('finish_event', { event_id: event.event_id })] }; } });
    const morning = f.send(loop, 'おはよう');
    await completed(events, morning.eventId);
    assert.match(next!.systemPrompt ?? '', /簡潔にまとめる/);
    assert.equal((next!.systemPrompt ?? '').includes('简洁'), false);
  } finally { await f.cleanup(); }
});

test('a session with nothing in it is not switched', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    assert.deepEqual(await loop.rotate(), { result: 'skipped', reason: 'empty-session' });
    assert.equal(f.model.calls, 0);
    assert.equal((await f.sessionFiles()).length, 1);
  } finally { await f.cleanup(); }
});

test('a stop during the switch never silently starts a new conversation: it resumes from the handoff or stays on the old session', async () => {
  const f = await setup();
  try {
    // Stopped before the handoff was written: the old session stays and the next night can try again.
    const first = await f.open();
    behave(f, {});
    const day = f.send(first.loop, `昼の話 ${EARLIER}`);
    await completed(first.events, day.eventId);
    await first.loop.idle();
    const [oldFile] = await f.sessionFiles();
    f.model.takeOver();
    const interrupted = first.loop.rotate();
    await f.model.next();
    await first.loop.close();
    assert.deepEqual(await interrupted, { result: 'failed', reason: 'stopped' });
    assert.deepEqual(await f.sessionFiles(), [oldFile]);

    const second = await f.open();
    assert.equal(second.loop.unavailable, undefined);
    assert.equal(f.rows()[0]!.pi_session_file, oldFile);
    let context: Context | undefined;
    behave(f, { owner: (event, seen) => { context = seen; return { calls: [call('finish_event', { event_id: event.event_id })] }; } });
    const check = f.send(second.loop, '続き');
    await completed(second.events, check.eventId);
    assert.ok(JSON.stringify(context!.messages).includes(EARLIER));

    // Stopped after the handoff was written: the next start finishes the switch with that handoff.
    f.model.takeOver();
    const again = second.loop.rotate();
    const review = await f.model.next();
    const [reviewEvent] = eventLines(lastUserText(review.context));
    review.call('write_handoff_note', { event_id: reviewEvent!.event_id, text: `${HANDOFF} 途中で止まった夜` });
    review.finish();
    await f.model.next();
    await second.loop.close();
    assert.deepEqual(await again, { result: 'failed', reason: 'stopped' });

    const third = await f.open();
    assert.equal(third.loop.unavailable, undefined);
    const files = await f.sessionFiles();
    assert.equal(files.length, 2);
    assert.ok(files.includes(oldFile!));
    assert.notEqual(f.rows()[0]!.pi_session_file, oldFile);
    behave(f, { owner: (event, seen) => { context = seen; return { calls: [call('finish_event', { event_id: event.event_id })] }; } });
    const morning = f.send(third.loop, 'おはよう');
    await completed(third.events, morning.eventId);
    assert.match(context!.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.equal(JSON.stringify(context!.messages).includes(EARLIER), false);
    assert.deepEqual(third.loop.snapshot().messages.map(m => m.text), [`昼の話 ${EARLIER}`, 'はい', '続き', 'おはよう']);
  } finally { await f.cleanup(); }
});

test('past the context limit the loop compacts between turns and the conversation goes on, also after a restart', async () => {
  const f = await setup();
  try {
    const options = { compactAtTokens: 1_500, keepRecentTokens: 400 };
    const { loop, events } = await f.open(options);
    behave(f, {});
    const long = 'あ'.repeat(1_500);
    const first = f.send(loop, `合言葉は ${PASSPHRASE} ${long}`);
    await completed(events, first.eventId);
    for (let i = 0; i < 4; i++) await completed(events, f.send(loop, `話 ${i} ${long}`).eventId);
    await loop.idle();

    const summaries = f.model.contexts.filter(isSummary);
    assert.ok(summaries.length >= 1, 'compacted');
    // The summary is asked for with natsumi's own instructions, and in no turn's middle.
    assert.match(textOf(summaries[0]!.messages.at(-1)!), /本人/);
    const file = String(f.rows()[0]!.pi_session_file);
    const entries = (await readFile(join(f.sessionDirectory, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line).type);
    assert.ok(entries.includes('compaction'));

    let context: Context | undefined;
    behave(f, { owner: (event, seen) => { context = seen; return { calls: [call('reply_to_mac', { event_id: event.event_id, text: '続きです' }), call('finish_event', { event_id: event.event_id })] }; } });
    const after = f.send(loop, 'まだ続く？');
    assert.equal((await completed(events, after.eventId)).payload.status, 'replied');
    assert.match(textOf(context!.messages[0]!), new RegExp(`要約: ${PASSPHRASE}`));
    assert.equal(loop.snapshot().messages.filter(m => m.role === 'owner').length, 6);

    await loop.close();
    const restarted = await f.open(options);
    const last = f.send(restarted.loop, '再起動後');
    assert.equal((await completed(restarted.events, last.eventId)).payload.status, 'replied');
    assert.match(textOf(context!.messages[0]!), /要約/);
    assert.deepEqual(await f.sessionFiles(), [file]);
  } finally { await f.cleanup(); }
});
