import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { isAwake, Scheduler, SelfChecks } from '../src/server/scheduler.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions, type SendOutcome } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';

const MINUTE = 60_000;
/** Tokyo is UTC+9 all year, so local times read directly. */
const TZ = 'Asia/Tokyo';
const tokyo = (local: string) => Date.parse(`${local.replace(' ', 'T')}:00+09:00`);
const AWAKE = { start: '08:00', end: '23:00' };
const LIMITS = { minDelayMinutes: 5, maxDelayDays: 7, maxPending: 5, maxPerDay: 20 };

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function setup(start: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-scheduler-')));
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
  const opened: ThinkingLoop[] = [];
  let counter = 0;
  const f = {
    db, model,
    clock: tokyo(start),
    at(local: string) { f.clock = tokyo(local); },
    advance(minutes: number) { f.clock += minutes * MINUTE; },
    async open(options: Partial<LoopOptions> = {}) {
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, maxModelCalls: 6, timeZone: TZ, now: () => f.clock, awakeHours: AWAKE, selfCheckLimits: LIMITS,
        configureSession: (session: AgentSession) => { session.agent.streamFunction = model.streamFunction; },
        ...options,
      });
      opened.push(loop);
      const events: LoopClientEvent[] = [];
      loop.subscribe(event => { events.push(event); });
      const scheduler = new Scheduler({ loop, now: () => f.clock, timeZone: TZ, awakeHours: AWAKE, pingIntervalMinutes: 30, expressionResetMinutes: 3 });
      return { loop, events, scheduler };
    },
    send(loop: ThinkingLoop, text: string) {
      const outcome = loop.send({ requestId: `request-${++counter}`, deviceId: 'device-1', text });
      assert.equal(outcome.kind, 'accepted', JSON.stringify(outcome));
      return outcome as Extract<SendOutcome, { kind: 'accepted' }>;
    },
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
const eventLines = (text: string) => [...text.matchAll(/^\{.*\}$/gm)].map(match => JSON.parse(match[0]) as Record<string, any>);
const toolResults = (context: Context) => {
  const lastAssistant = context.messages.map(m => m.role).lastIndexOf('assistant');
  return context.messages.slice(lastAssistant + 1).filter(m => m.role === 'toolResult')
    .map(m => ({ text: textOf(m), isError: (m as { isError: boolean }).isError }));
};
const expressions = (events: LoopClientEvent[]) => events.filter(e => e.type === 'avatar.expression').map(e => e.payload.expression);
const completed = (events: LoopClientEvent[], eventId: string) =>
  until(() => events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === eventId));

/** Takes the next model call, which must carry exactly one event, and returns that event with the call. */
async function nextEvent(f: Awaited<ReturnType<typeof setup>>) {
  const reply = await f.model.next();
  const lines = eventLines(lastUserText(reply.context));
  assert.equal(lines.length, 1, lastUserText(reply.context));
  return { reply, event: lines[0]! };
}

/** Answers an owner message with the given tool calls, then shows the results to the test and finishes the event. */
async function ownerTurn(f: Awaited<ReturnType<typeof setup>>, loop: ThinkingLoop, events: LoopClientEvent[], text: string,
  calls: [string, Record<string, unknown>][]) {
  const sent = f.send(loop, text);
  const { reply } = await nextEvent(f);
  for (const [name, args] of calls) reply.call(name, args);
  reply.finish();
  const after = await f.model.next();
  const results = toolResults(after.context);
  after.call('finish_event', { event_id: sent.eventId });
  after.finish();
  await completed(events, sent.eventId);
  await loop.idle();
  return results;
}

test('the awake hours are read in the owner\'s time zone and may run past midnight', () => {
  assert.equal(isAwake(tokyo('2026-09-17 07:59'), AWAKE, TZ), false);
  assert.equal(isAwake(tokyo('2026-09-17 08:00'), AWAKE, TZ), true);
  assert.equal(isAwake(tokyo('2026-09-17 22:59'), AWAKE, TZ), true);
  assert.equal(isAwake(tokyo('2026-09-17 23:00'), AWAKE, TZ), false);
  const late = { start: '22:00', end: '06:00' };
  assert.equal(isAwake(tokyo('2026-09-17 23:30'), late, TZ), true);
  assert.equal(isAwake(tokyo('2026-09-17 05:59'), late, TZ), true);
  assert.equal(isAwake(tokyo('2026-09-17 12:00'), late, TZ), false);
});

test('a self-check is booked relative or at a local time and saved as an absolute time; what is out of bounds is refused with the reason', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const checks = new SelfChecks({ db: f.db, now: () => f.clock, timeZone: TZ, limits: { ...LIMITS, maxPending: 3, maxPerDay: 4 }, awakeHours: AWAKE });
    const due = () => (f.db.prepare(`SELECT reason, due_at FROM self_checks WHERE state = 'pending' ORDER BY due_at`).all() as { reason: string; due_at: string }[])
      .map(row => [row.reason, row.due_at]);

    const relative = checks.schedule('洗濯物を取り込んだか確認する', { inMinutes: 30 });
    assert.equal(relative.ok, true, relative.text);
    assert.match(relative.text, /2026-09-17 10:30/);
    const today = checks.schedule('会議の準備を聞く', { at: '15:00' });
    assert.equal(today.ok, true, today.text);
    assert.match(today.text, /2026-09-17 15:00/);
    const dated = checks.schedule('週末の予定を聞く', { at: '2026-09-18T09:00' });
    assert.equal(dated.ok, true, dated.text);
    assert.deepEqual(due(), [
      ['洗濯物を取り込んだか確認する', '2026-09-17T01:30:00.000Z'],
      ['会議の準備を聞く', '2026-09-17T06:00:00.000Z'],
      ['週末の予定を聞く', '2026-09-18T00:00:00.000Z'],
    ]);

    // The same reason again is folded into the existing booking, which keeps its time and counts nothing.
    const again = checks.schedule('　洗濯物を取り込んだか確認する ', { at: '11:00' });
    assert.equal(again.ok, true, again.text);
    assert.match(again.text, /まとめ/);
    assert.match(again.text, /10:30/);
    assert.equal(due().length, 3);

    const refusals: [string, ReturnType<SelfChecks['schedule']>, RegExp][] = [
      ['past', checks.schedule('朝の確認', { at: '09:00' }), /過去/],
      ['too soon', checks.schedule('すぐの確認', { inMinutes: 4 }), /5 分/],
      ['zero', checks.schedule('すぐの確認', { inMinutes: 0 }), /5 分/],
      ['too far', checks.schedule('遠い確認', { at: '2026-09-24 10:01' }), /7 日/],
      ['both', checks.schedule('両方', { inMinutes: 30, at: '15:00' }), /どちらか/],
      ['neither', checks.schedule('なし', {}), /どちらか/],
      ['bad time', checks.schedule('形が違う', { at: '3pm' }), /HH:MM/],
      ['no reason', checks.schedule('  ', { inMinutes: 30 }), /理由/],
      ['full', checks.schedule('四件目', { inMinutes: 60 }), /同時.*3 件/],
    ];
    for (const [name, outcome, reason] of refusals) {
      assert.equal(outcome.ok, false, name);
      assert.match(outcome.text, reason, name);
    }
    assert.equal(due().length, 3);

    // The list reads the bookings; a cancelled one frees its place but still counts for the day.
    const listed = checks.list();
    assert.equal(listed.ok, true);
    const id = /(check-[0-9a-f-]+)[^\n]*洗濯物/.exec(listed.text)?.[1];
    assert.ok(id, listed.text);
    assert.match(listed.text, /2026-09-17 15:00.*会議の準備を聞く/);
    assert.equal(checks.cancel('check-missing').ok, false);
    assert.equal(checks.cancel(id!).ok, true);
    assert.equal(checks.cancel(id!).ok, false);
    assert.equal(checks.schedule('四件目', { inMinutes: 60 }).ok, true);
    checks.cancel(/(check-[0-9a-f-]+)[^\n]*四件目/.exec(checks.list().text)![1]!);
    const perDay = checks.schedule('五件目', { inMinutes: 90 });
    assert.equal(perDay.ok, false);
    assert.match(perDay.text, /1 日.*4 件/);

    // A new local day allows more.
    f.at('2026-09-18 00:05');
    assert.equal(checks.schedule('五件目', { inMinutes: 90 }).ok, true);
  } finally { await f.cleanup(); }
});

test('a booking outside the awake hours is accepted with a note that it waits for the morning', async () => {
  const f = await setup('2026-09-17 21:00');
  try {
    const checks = new SelfChecks({ db: f.db, now: () => f.clock, timeZone: TZ, limits: LIMITS, awakeHours: AWAKE });
    const night = checks.schedule('寝る前の確認', { at: '23:30' });
    assert.equal(night.ok, true, night.text);
    assert.match(night.text, /08:00/);
    assert.deepEqual(checks.due().map(check => check.reason), []);
    f.at('2026-09-17 23:31');
    assert.deepEqual(checks.due().map(check => check.reason), ['寝る前の確認']);
  } finally { await f.cleanup(); }
});

test('the ping comes only in the awake hours after a quiet interval, and carries the count of unchecked notices', async () => {
  const f = await setup('2026-09-17 07:00');
  try {
    const { loop, events, scheduler } = await f.open();
    // Night: quiet for 40 minutes, but no ping.
    f.at('2026-09-17 07:40');
    assert.equal(scheduler.tick(), undefined);
    assert.equal(f.model.calls, 0);

    f.at('2026-09-17 08:00');
    assert.equal(scheduler.tick(), 'ping');
    const ping = await nextEvent(f);
    assert.equal(ping.event.type, 'ping');
    assert.equal(ping.event.local_time, '2026-09-17 08:00');
    assert.equal('unacknowledged_notices' in ping.event, false);
    assert.match(ping.reply.context.systemPrompt ?? '', /ping/);
    ping.reply.call('finish_event', { event_id: ping.event.event_id });
    ping.reply.finish();
    await loop.idle();
    // Nothing reaches the owner for a ping on its own.
    assert.equal(events.filter(e => e.type === 'conversation.event.completed' || e.type === 'conversation.message').length, 0);

    // The ping's own handling restarted the quiet clock.
    assert.equal(scheduler.tick(), undefined);
    f.at('2026-09-17 08:20');
    assert.equal(scheduler.tick(), undefined);

    // A conversation restarts it too.
    const sent = f.send(loop, '相談');
    const turn = await nextEvent(f);
    turn.reply.call('notify_owner', { text: 'あとで確認してほしいことがあります' });
    turn.reply.call('reply_to_mac', { event_id: sent.eventId, text: 'はい' });
    turn.reply.call('finish_event', { event_id: sent.eventId });
    turn.reply.finish();
    await completed(events, sent.eventId);
    await loop.idle();
    f.at('2026-09-17 08:40');
    assert.equal(scheduler.tick(), undefined);
    f.at('2026-09-17 08:50');
    assert.equal(scheduler.tick(), 'ping');
    const second = await nextEvent(f);
    assert.equal(second.event.type, 'ping');
    assert.equal(second.event.unacknowledged_notices, 1);

    // While the ping is being handled, time passing raises nothing more.
    f.at('2026-09-17 10:00');
    assert.equal(scheduler.tick(), undefined);
    second.reply.call('finish_event', { event_id: second.event.event_id });
    second.reply.finish();
    await loop.idle();
    assert.equal(f.model.calls, 3);

    // Late at night the quiet goes on without a ping.
    f.at('2026-09-17 23:30');
    assert.equal(scheduler.tick(), undefined);
    assert.equal(f.model.calls, 3);
  } finally { await f.cleanup(); }
});

test('natsumi books a self-check with the tools, sees it arrive as an event with its reason, and can list and cancel', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const { loop, events, scheduler } = await f.open();
    const results = await ownerTurn(f, loop, events, '30 分後に洗濯物のことを聞いて', [
      ['schedule_self_check', { reason: '洗濯物を取り込んだか聞く', in_minutes: 30 }],
      ['schedule_self_check', { reason: 'すぐ聞く', in_minutes: 2 }],
      ['schedule_self_check', { reason: '取り消す予定', at: '12:00' }],
      ['list_self_checks', {}],
    ]);
    assert.deepEqual(results.map(r => r.isError), [false, true, false, false]);
    assert.match(results[0]!.text, /2026-09-17 10:30/);
    assert.match(results[1]!.text, /5 分/);
    const cancelId = /(check-[0-9a-f-]+)[^\n]*取り消す予定/.exec(results[3]!.text)?.[1];
    assert.ok(cancelId, results[3]!.text);
    const cancelled = await ownerTurn(f, loop, events, 'お昼のは要らない', [['cancel_self_check', { check_id: cancelId }]]);
    assert.deepEqual(cancelled.map(r => r.isError), [false]);

    f.at('2026-09-17 10:29');
    assert.equal(scheduler.tick(), undefined);
    f.at('2026-09-17 10:30');
    // The check is due at the same moment as the ping would be: the check goes first and the ping waits.
    assert.equal(scheduler.tick(), 'self-check');
    const check = await nextEvent(f);
    assert.equal(check.event.type, 'self_check');
    assert.equal(check.event.checks.length, 1);
    assert.equal(check.event.checks[0].reason, '洗濯物を取り込んだか聞く');
    assert.equal(check.event.checks[0].scheduled_for, '2026-09-17 10:30');
    assert.equal('late_minutes' in check.event.checks[0], false);
    assert.match(check.reply.context.systemPrompt ?? '', /self_check/);
    check.reply.call('list_self_checks', {});
    check.reply.finish();
    const after = await f.model.next();
    assert.doesNotMatch(toolResults(after.context)[0]!.text, /check-/);
    after.call('finish_event', { event_id: check.event.event_id });
    after.finish();
    await loop.idle();
    assert.equal(scheduler.tick(), undefined);
    f.at('2026-09-17 12:30');
    // The cancelled one never comes; only the ping does.
    assert.equal(scheduler.tick(), 'ping');
    const ping = await nextEvent(f);
    assert.equal(ping.event.type, 'ping');
    ping.reply.call('finish_event', { event_id: ping.event.event_id });
    ping.reply.finish();
    await loop.idle();
  } finally { await f.cleanup(); }
});

test('bookings survive a restart, and those that passed while stopped or asleep arrive together in one event with how late they are', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const first = await f.open();
    await ownerTurn(f, first.loop, first.events, '予定を覚えておいて', [
      ['schedule_self_check', { reason: 'お昼を食べたか聞く', in_minutes: 60 }],
      ['schedule_self_check', { reason: '午後の会議の準備を聞く', at: '12:00' }],
      ['schedule_self_check', { reason: '寝る前に明日の予定を聞く', at: '23:30' }],
    ]);
    await first.loop.close();

    f.at('2026-09-17 13:30');
    const second = await f.open();
    assert.equal(second.scheduler.tick(), 'self-check');
    const late = await nextEvent(f);
    assert.equal(late.event.type, 'self_check');
    assert.deepEqual(late.event.checks.map((check: Record<string, unknown>) => [check.reason, check.scheduled_for, check.late_minutes]), [
      ['お昼を食べたか聞く', '2026-09-17 11:00', 150],
      ['午後の会議の準備を聞く', '2026-09-17 12:00', 90],
    ]);
    // No second event follows while the first is handled.
    assert.equal(second.scheduler.tick(), undefined);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.model.calls, 3);
    late.reply.call('finish_event', { event_id: late.event.event_id });
    late.reply.finish();
    await second.loop.idle();
    assert.equal(second.scheduler.tick(), undefined);

    // The night one waits through the night and comes in the morning.
    f.at('2026-09-17 23:31');
    assert.equal(second.scheduler.tick(), undefined);
    f.at('2026-09-18 07:59');
    assert.equal(second.scheduler.tick(), undefined);
    f.at('2026-09-18 08:00');
    assert.equal(second.scheduler.tick(), 'self-check');
    const morning = await nextEvent(f);
    assert.deepEqual(morning.event.checks.map((check: Record<string, unknown>) => [check.reason, check.late_minutes]), [['寝る前に明日の予定を聞く', 510]]);
    morning.reply.call('finish_event', { event_id: morning.event.event_id });
    morning.reply.finish();
    await second.loop.idle();
    assert.equal(f.model.calls, 4);
  } finally { await f.cleanup(); }
});

test('a self-check or a ping that comes due during the nightly switch waits for it and goes to the new session', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const { loop, events, scheduler } = await f.open();
    await ownerTurn(f, loop, events, '10 分後に聞いて', [['schedule_self_check', { reason: '水を飲んだか聞く', in_minutes: 10 }]]);
    const rotating = loop.rotate();
    const review = await nextEvent(f);
    assert.equal(review.event.type, 'nightly_review');
    f.at('2026-09-17 11:00');
    assert.equal(scheduler.tick(), undefined);
    review.reply.call('write_handoff_note', { event_id: review.event.event_id, text: '引き継ぎ HANDOFF-SCHEDULER-31' });
    review.reply.call('finish_event', { event_id: review.event.event_id });
    review.reply.finish();
    assert.equal((await rotating).result, 'switched');
    await loop.idle();

    assert.equal(scheduler.tick(), 'self-check');
    const check = await nextEvent(f);
    assert.match(check.reply.context.systemPrompt ?? '', /HANDOFF-SCHEDULER-31/);
    assert.deepEqual(check.event.checks.map((c: Record<string, unknown>) => [c.reason, c.late_minutes]), [['水を飲んだか聞く', 50]]);
    check.reply.call('finish_event', { event_id: check.event.event_id });
    check.reply.finish();
    await loop.idle();
  } finally { await f.cleanup(); }
});

test('thinking ends with the handling whoever set it; other expressions return to neutral after a while, but not sleepy during the review', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const { loop, events, scheduler } = await f.open();
    const sent = f.send(loop, '考えて');
    const first = await nextEvent(f);
    // Thinking set by the server stays while the turn runs, however long.
    f.advance(10);
    assert.equal(scheduler.tick(), undefined);
    assert.equal(loop.snapshot().avatar.expression, 'thinking');
    first.reply.call('set_mac_avatar_expression', { expression: 'thinking' });
    first.reply.call('reply_to_mac', { event_id: sent.eventId, text: 'うーん' });
    first.reply.call('finish_event', { event_id: sent.eventId });
    first.reply.finish();
    await completed(events, sent.eventId);
    await loop.idle();
    // The model's own thinking is released at the end too.
    assert.equal(loop.snapshot().avatar.expression, 'neutral');
    assert.equal(expressions(events).at(-1), 'neutral');

    const happy = f.send(loop, 'いい知らせ');
    const second = await nextEvent(f);
    second.reply.call('set_mac_avatar_expression', { expression: 'happy' });
    second.reply.call('finish_event', { event_id: happy.eventId });
    second.reply.finish();
    await completed(events, happy.eventId);
    await loop.idle();
    assert.equal(loop.snapshot().avatar.expression, 'happy');
    f.advance(2);
    scheduler.tick();
    assert.equal(loop.snapshot().avatar.expression, 'happy');
    f.advance(1);
    scheduler.tick();
    assert.equal(loop.snapshot().avatar.expression, 'neutral');
    assert.equal(expressions(events).at(-1), 'neutral');
    const count = expressions(events).length;
    f.advance(10);
    scheduler.tick();
    assert.equal(expressions(events).length, count);

    // Asleep for the review: sleepy stays however long it takes, then the switch releases it.
    const rotating = loop.rotate();
    const review = await nextEvent(f);
    f.advance(30);
    assert.equal(scheduler.tick(), undefined);
    assert.equal(loop.snapshot().avatar.expression, 'sleepy');
    review.reply.call('write_handoff_note', { event_id: review.event.event_id, text: '引き継ぎ' });
    review.reply.call('finish_event', { event_id: review.event.event_id });
    review.reply.finish();
    assert.equal((await rotating).result, 'switched');
    assert.equal(loop.snapshot().avatar.expression, 'neutral');
  } finally { await f.cleanup(); }
});
