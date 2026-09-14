import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/pi-session.ts';
import { ConversationService, type ConversationEvent, type SendOutcome } from '../src/server/conversation.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { PRIVATE_DETAIL, ScriptedModel, type ScriptedReply } from './support/scripted-model.ts';

const PERSONALITY_MARKER = 'FIXTURE-PERSONALITY-5521';
const TOKEN = 'SYNTHETIC-ORCHID-731';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function accepted(outcome: SendOutcome): string {
  assert.equal(outcome.kind, 'accepted', JSON.stringify(outcome));
  return (outcome as { turnId: string }).turnId;
}

const completed = (events: ConversationEvent[], turnId: string) =>
  until(() => events.find(e => e.type === 'conversation.turn.completed' && e.payload.turnId === turnId));

interface OpenOptions { runtime?: () => Promise<ModelRuntime>; turnTimeoutMs?: number }

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-conversation-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(data);
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(data, 'personality.md'), `# 性格・話し方\n${PERSONALITY_MARKER}\n`);
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const sessions: AgentSession[] = [];
  const opened: ConversationService[] = [];
  return {
    root, data, sessionDirectory, db, model, sessions,
    async open(options: OpenOptions = {}) {
      const service = await ConversationService.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET,
        runtime: options.runtime ?? fixtureRuntime, turnTimeoutMs: options.turnTimeoutMs,
        configureSession: session => { session.agent.streamFunction = model.streamFunction; sessions.push(session); },
      });
      opened.push(service);
      const events: ConversationEvent[] = [];
      service.subscribe(event => { events.push(event); });
      return { service, events };
    },
    rows: () => db.prepare('SELECT * FROM conversations').all() as Record<string, unknown>[],
    operation: (requestId: string) =>
      db.prepare('SELECT * FROM conversation_operations WHERE request_id = ?').get(requestId) as Record<string, unknown> | undefined,
    sessionFiles: async () => (await readdir(sessionDirectory)).filter(name => name.endsWith('.jsonl')),
    async cleanup() {
      for (const service of opened) await service.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// Recalls the token only when an earlier message (not the latest prompt) carries it.
const recall = (context: { messages: unknown[] }) => JSON.stringify(context.messages.slice(0, -1)).includes(TOKEN) ? TOKEN : 'OK';

test('the first start creates one Pi session and stores only its reference; a restart continues it', async () => {
  const f = await setup();
  try {
    const first = await f.open();
    assert.equal(first.service.unavailable, undefined);
    const rows = f.rows();
    assert.equal(rows.length, 1);
    const file = String(rows[0]!.pi_session_file);
    assert.doesNotMatch(file, /^\/|\.\./);
    // The session file exists before any reply, so a crash cannot leave a reference to a missing file.
    assert.deepEqual(await f.sessionFiles(), [file]);

    f.model.auto = recall;
    await completed(first.events, accepted(first.service.send({ requestId: 'request-1', deviceId: 'device-1', text: `Remember ${TOKEN}` })));
    const history = first.service.snapshot().history;
    assert.deepEqual(history.map(item => [item.role, item.text]), [['user', `Remember ${TOKEN}`], ['assistant', 'OK']]);
    await first.service.close();

    const second = await f.open();
    assert.equal(second.service.conversationId, first.service.conversationId);
    assert.deepEqual(second.service.snapshot().history, history);
    await completed(second.events, accepted(second.service.send({ requestId: 'request-2', deviceId: 'device-2', text: 'What was the token?' })));
    assert.equal(second.service.snapshot().history.at(-1)?.text, TOKEN);
    assert.deepEqual(f.rows(), rows);
    assert.deepEqual(await f.sessionFiles(), [file]);
  } finally { await f.cleanup(); }
});

test('a missing, corrupt or mismatched session file makes the conversation unavailable instead of replacing it', async () => {
  const f = await setup();
  try {
    const first = await f.open();
    f.model.auto = () => 'OK';
    await completed(first.events, accepted(first.service.send({ requestId: 'request-1', deviceId: 'device-1', text: 'hello' })));
    await first.service.close();
    const rows = f.rows();
    const name = String(rows[0]!.pi_session_file);
    const file = join(f.sessionDirectory, name);
    const original = await readFile(file, 'utf8');
    const damage = [
      () => rm(file),
      () => writeFile(file, `${original}{"type":"message","message":\n`),
      () => writeFile(file, original.replace(String(rows[0]!.pi_session_id), '00000000-0000-4000-8000-000000000000')),
    ];
    let n = 0;
    for (const apply of damage) {
      await apply();
      const { service } = await f.open();
      assert.equal(service.unavailable, 'conversation-restore-failed');
      assert.deepEqual(service.send({ requestId: `request-damaged-${n++}`, deviceId: 'device-1', text: 'hello' }),
        { kind: 'unavailable', code: 'conversation-restore-failed' });
      await service.close();
      assert.deepEqual(f.rows(), rows);
      for (const seen of await f.sessionFiles()) assert.equal(seen, name);
      await writeFile(file, original);
    }
    assert.equal(f.model.calls, 1);
  } finally { await f.cleanup(); }
});

test('a model runtime that cannot start leaves the conversation unavailable without creating a session', async () => {
  const f = await setup();
  try {
    const { service } = await f.open({ runtime: async () => { throw new Error(PRIVATE_DETAIL); } });
    assert.equal(service.unavailable, 'pi-unavailable');
    assert.deepEqual(service.send({ requestId: 'request-1', deviceId: 'device-1', text: 'hello' }), { kind: 'unavailable', code: 'pi-unavailable' });
    assert.deepEqual(f.rows(), []);
    assert.deepEqual(await f.sessionFiles(), []);
  } finally { await f.cleanup(); }
});

test('an accepted send is recorded before the prompt, and a resent requestId never prompts twice', async () => {
  const f = await setup();
  try {
    const { service, events } = await f.open();
    const input = { requestId: 'request-1', deviceId: 'device-1', text: '架空のメッセージ' };
    const turnId = accepted(service.send(input));
    const recorded = f.operation('request-1');
    assert.equal(recorded?.state, 'accepted');
    assert.equal(recorded?.body_hash, sha256(input.text));
    assert.equal(recorded?.turn_id, turnId);
    assert.equal(recorded?.device_id, 'device-1');
    assert.equal(recorded?.pi_user_entry_id, null);
    assert.equal(f.model.calls, 0, 'the prompt starts only after the send has been answered');

    const reply = await f.model.next();
    await until(() => f.operation('request-1')?.state === 'prompted');
    assert.deepEqual(service.send(input), { kind: 'accepted', turnId, state: 'prompted' });
    assert.deepEqual(service.send({ ...input, text: '別の本文' }), { kind: 'rejected', code: 'request-conflict' });
    assert.deepEqual(service.send({ ...input, requestId: 'request-2' }), { kind: 'rejected', code: 'busy' });
    assert.equal(f.operation('request-2'), undefined);

    reply.delta('OK');
    reply.finish();
    await completed(events, turnId);
    assert.deepEqual(service.send(input), { kind: 'accepted', turnId, state: 'completed' });
    assert.equal(f.model.calls, 1);
    const entryId = f.operation('request-1')?.pi_user_entry_id;
    assert.equal(typeof entryId, 'string');
    assert.equal(service.snapshot().history[0]?.entryId, entryId);
  } finally { await f.cleanup(); }
});

test('the conversation events carry the user item, deltas and the final assistant item, never Pi internals', async () => {
  const f = await setup();
  try {
    const { service, events } = await f.open();
    const turnId = accepted(service.send({ requestId: 'request-1', deviceId: 'device-1', text: '架空のメッセージ' }));
    const reply = await f.model.next();
    reply.delta('こんに');
    reply.delta('ちは');
    reply.finish();
    await completed(events, turnId);
    const turn = events.filter(event => event.payload.turnId === turnId);
    assert.deepEqual(turn.map(event => event.type), ['conversation.turn.started', 'conversation.item.completed',
      'conversation.delta', 'conversation.delta', 'conversation.item.completed', 'conversation.turn.completed']);
    const [started, user, delta, , assistant, done] = turn;
    const conversationId = service.conversationId;
    assert.deepEqual(started, { type: 'conversation.turn.started', requestId: 'request-1', payload: { conversationId, turnId } });
    assert.equal(user!.payload.role, 'user');
    assert.equal(user!.payload.text, '架空のメッセージ');
    assert.equal(assistant!.payload.role, 'assistant');
    assert.equal(assistant!.payload.text, 'こんにちは');
    assert.equal(delta!.payload.itemId, assistant!.payload.itemId);
    assert.deepEqual(service.snapshot().history.map(item => item.entryId), [user!.payload.entryId, assistant!.payload.entryId]);
    assert.deepEqual(done, { type: 'conversation.turn.completed', requestId: 'request-1', payload: { conversationId, turnId, status: 'completed' } });

    const text = JSON.stringify(events);
    assert.doesNotMatch(text, new RegExp(String(f.rows()[0]!.pi_session_id)));
    assert.equal(text.includes(f.root), false);
    assert.equal(text.includes('.jsonl'), false);
  } finally { await f.cleanup(); }
});

test('only a reply that stops normally completes a turn', async () => {
  const f = await setup();
  try {
    const { service, events } = await f.open();
    const run = async (requestId: string, end: (reply: ScriptedReply, turnId: string) => void) => {
      const turnId = accepted(service.send({ requestId, deviceId: 'device-1', text: requestId }));
      const reply = await f.model.next();
      reply.delta('partial');
      await until(() => events.some(event => event.type === 'conversation.delta' && event.payload.turnId === turnId));
      end(reply, turnId);
      return { ...(await completed(events, turnId)).payload, state: f.operation(requestId)?.state };
    };
    const outcome = ({ status, reason, state }: Record<string, unknown>) => ({ status, reason, state });

    assert.deepEqual(outcome(await run('request-error', reply => reply.finish('error'))), { status: 'failed', reason: 'model-error', state: 'failed' });
    assert.deepEqual(outcome(await run('request-length', reply => reply.finish('length'))), { status: 'failed', reason: 'length', state: 'failed' });
    assert.deepEqual(outcome(await run('request-interrupt', (_reply, turnId) => {
      assert.deepEqual(service.interrupt('turn-other'), { kind: 'rejected', code: 'turn-not-active' });
      assert.deepEqual(service.interrupt(turnId), { kind: 'accepted', turnId });
    })), { status: 'interrupted', reason: undefined, state: 'interrupted' });
    assert.deepEqual(outcome(await run('request-stop', reply => reply.finish())), { status: 'completed', reason: undefined, state: 'completed' });
    assert.deepEqual(service.interrupt('turn-other'), { kind: 'rejected', code: 'turn-not-active' });

    const assistants = service.snapshot().history.filter(item => item.role === 'assistant');
    assert.deepEqual(assistants.map(item => item.status), ['failed', 'failed', 'interrupted', 'completed']);
    assert.equal(JSON.stringify(events).includes(PRIVATE_DETAIL), false);
    assert.equal(JSON.stringify(service.snapshot()).includes(PRIVATE_DETAIL), false);
  } finally { await f.cleanup(); }
});

test('a reply that exceeds the turn deadline is aborted and fails', async () => {
  const f = await setup();
  try {
    const { service, events } = await f.open({ turnTimeoutMs: 50 });
    const turnId = accepted(service.send({ requestId: 'request-1', deviceId: 'device-1', text: 'hello' }));
    await f.model.next();
    const done = await completed(events, turnId);
    assert.equal(done.payload.status, 'failed');
    assert.equal(done.payload.reason, 'timeout');
    assert.equal(f.operation('request-1')?.state, 'failed');
  } finally { await f.cleanup(); }
});

test('a snapshot during a turn holds the confirmed entries and the text streamed so far', async () => {
  const f = await setup();
  try {
    const { service, events } = await f.open();
    const turnId = accepted(service.send({ requestId: 'request-1', deviceId: 'device-1', text: 'hello' }));
    const reply = await f.model.next();
    reply.delta('途中');
    await until(() => events.some(event => event.type === 'conversation.delta'));
    const during = service.snapshot();
    assert.deepEqual(during.history.map(item => [item.role, item.text]), [['user', 'hello']]);
    assert.equal(during.activeTurn?.turnId, turnId);
    assert.equal(during.activeTurn?.requestId, 'request-1');
    assert.deepEqual(during.activeTurn?.items.map(item => [item.role, item.text]), [['assistant', '途中']]);
    reply.delta('の応答');
    reply.finish();
    await completed(events, turnId);
    const after = service.snapshot();
    assert.equal(after.activeTurn, null);
    assert.deepEqual(after.history.map(item => item.text), ['hello', '途中の応答']);
  } finally { await f.cleanup(); }
});

test('an operation cut off before its user entry was saved is matched to Pi history, or marked unknown and never resent', async () => {
  const f = await setup();
  try {
    const first = await f.open();
    f.model.auto = () => 'OK';
    await completed(first.events, accepted(first.service.send({ requestId: 'request-1', deviceId: 'device-1', text: 'first message' })));
    await first.service.close();
    const entryId = f.operation('request-1')?.pi_user_entry_id;
    const now = new Date().toISOString();
    f.db.prepare("UPDATE conversation_operations SET state = 'accepted', pi_user_entry_id = NULL WHERE request_id = 'request-1'").run();
    f.db.prepare(`INSERT INTO conversation_operations (request_id, device_id, conversation_id, body_hash, state, turn_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?)`).run('request-lost', 'device-1', String(f.rows()[0]!.conversation_id),
      sha256('never reached Pi'), 'turn-lost', now, now);

    const second = await f.open();
    assert.equal(f.operation('request-1')?.state, 'completed');
    assert.equal(f.operation('request-1')?.pi_user_entry_id, entryId);
    assert.equal(f.operation('request-lost')?.state, 'unknown');
    const calls = f.model.calls;
    assert.deepEqual(second.service.send({ requestId: 'request-lost', deviceId: 'device-1', text: 'never reached Pi' }),
      { kind: 'rejected', code: 'operation-unknown', turnId: 'turn-lost' });
    assert.equal(f.model.calls, calls);
    assert.deepEqual(second.service.snapshot().operations, [{ requestId: 'request-lost', turnId: 'turn-lost', state: 'unknown' }]);
    // An unknown operation is shown, not retried, and does not block the next message.
    await completed(second.events, accepted(second.service.send({ requestId: 'request-3', deviceId: 'device-1', text: 'next' })));
  } finally { await f.cleanup(); }
});

test('stopping the service interrupts the active turn and records it', async () => {
  const f = await setup();
  try {
    const { service, events } = await f.open();
    const turnId = accepted(service.send({ requestId: 'request-1', deviceId: 'device-1', text: 'hello' }));
    await f.model.next();
    await service.close();
    assert.equal((await completed(events, turnId)).payload.status, 'interrupted');
    assert.equal(f.operation('request-1')?.state, 'interrupted');
    assert.deepEqual(service.send({ requestId: 'request-2', deviceId: 'device-1', text: 'hello' }), { kind: 'unavailable', code: 'stopping' });
  } finally { await f.cleanup(); }
});

test('personality.md becomes the system instruction and Pi has no tools', async () => {
  const f = await setup();
  try {
    const { service, events } = await f.open();
    f.model.auto = () => 'OK';
    await completed(events, accepted(service.send({ requestId: 'request-1', deviceId: 'device-1', text: 'hello' })));
    assert.match(f.model.contexts[0]?.systemPrompt ?? '', new RegExp(PERSONALITY_MARKER));
    assert.deepEqual(f.sessions[0]?.getActiveToolNames(), []);
    assert.equal(f.model.contexts[0]?.tools?.length ?? 0, 0);
  } finally { await f.cleanup(); }
});
