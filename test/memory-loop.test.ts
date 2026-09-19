import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
  const memory = join(data, 'memory');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', memory, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
  const f = {
    root, data, memory, sessionDirectory, db, model, sessions, git,
    commits: () => Number(git('rev-list', '--count', 'HEAD')),
    /** Writes a memory file the way the model's shell would, in the middle of a turn. */
    remember: (name: string, text: string) => writeFile(join(memory, name), text),
    rememberSync: (name: string, text: string) => writeFileSync(join(memory, name), text),
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

test('the first start makes the memory repository, moves personality.md in and keeps the prompt', async () => {
  const f = await setup();
  try {
    await f.remember('合言葉.md', `# 合言葉\n\n- 2026-09-15: 合言葉は ${PASSPHRASE}\n`);
    const { loop } = await f.open();
    const sent = f.send(loop, 'こんにちは');
    const call1 = await f.model.next();

    // The personality is in the prompt, and memory itself never is.
    assert.match(call1.context.systemPrompt ?? '', /落ち着いた話し方/);
    assert.equal((call1.context.systemPrompt ?? '').includes(PASSPHRASE), false);
    call1.call('finish_event', { event_id: sent.eventId });
    call1.finish();
    await loop.idle();

    assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(f.commits(), 1);
    assert.deepEqual(f.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort(),
      ['always.md', 'handoff.md', 'personality.md', '合言葉.md'].sort());
    assert.deepEqual((await readdir(f.data)).sort(), ['memory']);
    assert.match(await readFile(join(f.memory, '合言葉.md'), 'utf8'), new RegExp(PASSPHRASE));
  } finally { await f.cleanup(); }
});

test('the memory tools are gone: reading and writing memory happens only in the shell', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, '覚えておいて');
    const call1 = await f.model.next();
    for (const name of ['remember', 'recall', 'read_memory', 'forget']) call1.call(name, { topic: '合言葉', note: 'x', query: 'x', text: 'x' });
    call1.finish();
    const call2 = await f.model.next();
    const results = toolResults(call2.context);
    assert.deepEqual(results.map(result => result.isError), [true, true, true, true]);
    // The instructions point at the shell, never at a memory tool.
    const prompt = call1.context.systemPrompt ?? '';
    for (const name of ['remember', 'recall', 'read_memory', 'forget']) assert.equal(prompt.includes(name), false, name);
    call2.call('finish_event', { event_id: sent.eventId });
    call2.finish();
    await completed(events, sent.eventId);
    assert.deepEqual((await readdir(f.memory)).filter(name => name !== '.git').sort(),
      ['always.md', 'handoff.md', 'personality.md']);
  } finally { await f.cleanup(); }
});

test('a turn that changed memory ends in one commit; a turn that changed nothing ends in none', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const base = f.commits();

    const first = f.send(loop, `合言葉は ${PASSPHRASE}`);
    const call1 = await f.model.next();
    await f.remember('合言葉.md', `# 合言葉\n\n- 2026-09-19: ${PASSPHRASE}\n`);
    call1.call('reply_to_mac', { event_id: first.eventId, text: '覚えました' });
    call1.call('finish_event', { event_id: first.eventId });
    call1.finish();
    await completed(events, first.eventId);
    assert.equal(f.commits(), base + 1);
    assert.match(f.git('log', '-1', '--format=%s'), /^mac_message: .*合言葉\.md/);
    assert.equal(f.git('status', '--porcelain'), '');

    const second = f.send(loop, 'ありがとう');
    const call2 = await f.model.next();
    call2.call('finish_event', { event_id: second.eventId });
    call2.finish();
    await completed(events, second.eventId);
    assert.equal(f.commits(), base + 1);
  } finally { await f.cleanup(); }
});

test('a file the check catches goes back, and the reason reaches the next turn', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const first = f.send(loop, 'まとめて');
    const call1 = await f.model.next();
    await f.remember('予定.md', '# 予定\n\n- 2026-09-19: 歯医者は金曜\n');
    await f.remember('めも.md', '# めも\n\n这个是简体字\n');
    call1.call('finish_event', { event_id: first.eventId });
    call1.finish();
    await completed(events, first.eventId);

    // The bad one is gone, the good one is committed.
    assert.deepEqual((await readdir(f.memory)).filter(name => name !== '.git').sort(),
      ['always.md', 'handoff.md', 'personality.md', '予定.md'].sort());
    assert.equal(f.git('status', '--porcelain'), '');

    const second = f.send(loop, 'どうだった');
    const call2 = await f.model.next();
    const told = lastUserText(call2.context);
    assert.match(told, /めも\.md/);
    assert.match(told, /日本語以外/);
    call2.call('finish_event', { event_id: second.eventId });
    call2.finish();
    await completed(events, second.eventId);

    // Told once, not again.
    const third = f.send(loop, 'わかった');
    const call3 = await f.model.next();
    assert.doesNotMatch(lastUserText(call3.context), /めも\.md/);
    call3.call('finish_event', { event_id: third.eventId });
    call3.finish();
    await completed(events, third.eventId);
  } finally { await f.cleanup(); }
});

test('a turn stopped at the model-call limit still commits what memory holds', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open({ maxModelCalls: 1 });
    const base = f.commits();
    const sent = f.send(loop, '長い作業');
    const call1 = await f.model.next();
    await f.remember('途中.md', '# 途中\n\n- 2026-09-19: 書きかけ\n');
    // No finish_event: the turn is cut at the model-call limit.
    call1.call('set_mac_avatar_expression', { expression: 'thinking' });
    call1.finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'failed');
    assert.equal(f.commits(), base + 1);
    assert.match(await readFile(join(f.memory, '途中.md'), 'utf8'), /書きかけ/);
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
        f.rememberSync('一日の記録.md', `# 一日の記録\n\n- 2026-09-19: ${EARLIER} を覚えた\n`);
        return { calls: [
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
    assert.match(await readFile(join(f.memory, '一日の記録.md'), 'utf8'), new RegExp(EARLIER));
    assert.match(f.git('log', '-1', '--format=%s'), /^nightly_review: 一日の記録\.md$/);
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

test('the first repository takes the handoff SQLite already held, and a night that lost a file says so in the new session', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    behave(f, {
      review: event => {
        // The night rewrites the always-memory, and puts a topic into a file that is not Markdown.
        f.rememberSync('always.md', `# 常時記憶\n\n本人の呼び方は「あなた」\n`);
        f.rememberSync('notes.txt', '# めも\n\n木曜に電話\n');
        return { calls: [
          call('write_handoff_note', { event_id: event.event_id, text: `${HANDOFF} 明日は資料の続き` }),
          call('finish_event', { event_id: event.event_id }),
        ] };
      },
    });
    const day = f.send(loop, `今日の話: ${EARLIER}`);
    await completed(events, day.eventId);
    assert.equal((await loop.rotate()).result, 'switched');

    // always.md is the night's, notes.txt never made it, and the new session is told why.
    assert.match(await readFile(join(f.memory, 'always.md'), 'utf8'), /あなた/);
    assert.equal((await readdir(f.memory)).includes('notes.txt'), false);
    let next: Context | undefined;
    behave(f, { owner: (event, context) => { next = context; return { calls: [call('finish_event', { event_id: event.event_id })] }; } });
    const morning = f.send(loop, 'おはよう');
    await completed(events, morning.eventId);
    assert.match(next!.systemPrompt ?? '', /notes\.txt/);
    assert.match(next!.systemPrompt ?? '', new RegExp(HANDOFF));
    await loop.close();

    // A repository that is not there yet is made from what the data directory and SQLite hold.
    await rm(f.memory, { recursive: true, force: true });
    await mkdir(f.memory, { recursive: true });
    await f.remember('合言葉.md', `# 合言葉\n\n- 2026-09-15: ${PASSPHRASE}\n`);
    const again = await f.open();
    assert.equal(again.loop.unavailable, undefined);
    assert.equal(f.commits(), 1);
    assert.match(await readFile(join(f.memory, 'handoff.md'), 'utf8'), new RegExp(HANDOFF));
    assert.match(await readFile(join(f.memory, '合言葉.md'), 'utf8'), new RegExp(PASSPHRASE));
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

test('run_memory_shell is offered only with a runner socket, and an unreachable runner does not stop the loop', async () => {
  const f = await setup();
  try {
    // Without a socket the tool is not registered and the instructions do not mention it.
    const plain = await f.open();
    const first = f.send(plain.loop, '鍵の番号を探して');
    const call1 = await f.model.next();
    assert.doesNotMatch(call1.context.systemPrompt ?? '', /run_memory_shell/);
    call1.call('run_memory_shell', { command: 'rg 鍵' });
    call1.finish();
    const call2 = await f.model.next();
    const [unregistered] = toolResults(call2.context);
    assert.equal(unregistered!.isError, true);
    assert.doesNotMatch(unregistered!.text, /接続できません/);
    call2.call('finish_event', { event_id: first.eventId });
    call2.finish();
    await completed(plain.events, first.eventId);
    await plain.loop.close();

    // With a socket nobody listens on, the tool answers with the reason and the turn goes on.
    const shelled = await f.open({ memoryShellSocket: join(f.root, 'missing.sock') });
    const asked = f.send(shelled.loop, 'もう一度探して');
    const call3 = await f.model.next();
    assert.match(call3.context.systemPrompt ?? '', /run_memory_shell/);
    call3.call('run_memory_shell', { command: 'rg 鍵' });
    call3.finish();
    const call4 = await f.model.next();
    const [unreachable] = toolResults(call4.context);
    assert.equal(unreachable!.isError, true);
    assert.match(unreachable!.text, /接続できません/);
    call4.call('reply_to_mac', { event_id: asked.eventId, text: 'いまは探せませんでした' });
    call4.call('finish_event', { event_id: asked.eventId });
    call4.finish();
    assert.equal((await completed(shelled.events, asked.eventId)).payload.status, 'replied');
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
