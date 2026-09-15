import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPersistedPiSession, openPiSession, PiSessionRestoreError, type PiTarget } from '../pi-session.ts';
import { createLoopTools, LOOP_TOOL_NAMES, type Expression, type LoopToolHost, type ToolOutcome } from './loop-tools.ts';
import { checkOutgoingText, refusalText } from './output-checks.ts';

/** Model calls one turn may make before it is stopped and its open events fail (the evaluation stopped at 8). */
export const DEFAULT_MAX_MODEL_CALLS = 8;
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;
/** notify_owner is limited per turn and per rolling hour (ADR 0008). */
export const DEFAULT_NOTIFY_LIMITS = { perTurn: 3, perHour: 12 };
/** The newest messages a snapshot carries. */
export const SNAPSHOT_MESSAGE_LIMIT = 500;

const BASE_INSTRUCTION = `あなたは natsumi。一人の本人（オーナー）専属の秘書で、本人の Mac のデスクトップにアバターとして常駐しています。

## 動き方
- あなたは一本の思考ループとして動いています。外で起きた出来事は <events> の中に 1 行 1 件の JSON で届きます。
- あなたが書く本文と思考は、誰にも届かない内心です。
- 外に何かを伝えるには、必ずツールを使います。ツールを呼ばなければ、何もしなかったのと同じです。
  - 本人のメッセージへの返事: reply_to_mac（1 つのメッセージに 1 回だけ）
  - 本人への相談・知らせ: notify_owner
  - アバターの表情: set_mac_avatar_expression
- 出来事への対応を終えたら、finish_event を呼びます。何もしないと決めたときも呼びます。
- 何もしなかったことや内心は、本人に報告しません。
- 本人には日本語で書きます。

## 出来事の種類
- mac_message: 本人との一対一の会話です。`;

export type UnavailableCode = 'pi-unavailable' | 'conversation-restore-failed' | 'stopping';
export type EventState = 'queued' | 'processing' | 'replied' | 'no-reply' | 'failed';

/** An event for clients. `conversation.message`, `avatar.expression` and `conversation.event.completed`. */
export interface LoopClientEvent { type: string; payload: Record<string, any> }

export type SendOutcome =
  | { kind: 'accepted'; messageId: string; eventId: string; state: EventState }
  | { kind: 'rejected'; code: 'request-conflict' }
  | { kind: 'unavailable'; code: UnavailableCode };

/** A message as the owner sees it. */
export interface ShownMessage {
  messageId: string;
  role: 'owner' | 'natsumi';
  kind: 'message' | 'reply' | 'notice';
  text: string;
  createdAt: string;
  /** An owner message's event. */
  eventId?: string;
  /** The event a reply answers. */
  replyTo?: string;
  /** The events a notice is about. */
  about?: string[];
}

export interface LoopSnapshot {
  messages: ShownMessage[];
  /** Owner messages not handled yet. */
  pendingEvents: { eventId: string; messageId: string; state: EventState }[];
  avatar: { expression: Expression };
}

export interface LoopOptions {
  db: DatabaseSync;
  dataDirectory: string;
  sessionDirectory: string;
  agentDirectory: string;
  target: PiTarget;
  thinking: 'on' | 'off';
  runtime: () => Promise<ModelRuntime>;
  /** Called once with the Pi session before any prompt. Tests replace the model stream here. */
  configureSession?: (session: AgentSession) => void;
  maxModelCalls?: number;
  runTimeoutMs?: number;
  notifyLimits?: { perTurn: number; perHour: number };
  now?: () => number;
  log?: (line: string) => void;
}

type StopContext = Parameters<NonNullable<AgentSession['agent']['shouldStopAfterTurn']>>[0];

interface MessageRow {
  message_id: string; position: number; role: ShownMessage['role']; kind: ShownMessage['kind']; text: string;
  event_id: string | null; about_event_ids: string | null; request_id: string | null; device_id: string | null; created_at: string;
}
interface ConversationRow { conversation_id: string; pi_session_id: string; pi_session_file: string }

/** An event handed to Pi in the current turn. */
interface Handling { eventId: string; messageId: string; replied: boolean; finished: boolean }
interface Turn { calls: number; limited: boolean; timedOut: boolean; notices: number }

/**
 * The single thinking loop (ADR 0008): one Pi session that takes events one at a time and acts only through tools.
 *
 * Owner messages are recorded before they are acknowledged, shown to every device at once, and handed to Pi as
 * events. A message that arrives while Pi is working is steered into the running turn at the next model-call boundary.
 * What the owner sees is kept in SQLite; the Pi session is the separate record of thinking.
 */
export class ThinkingLoop {
  private readonly options: LoopOptions;
  private readonly now: () => number;
  private readonly listeners = new Set<(event: LoopClientEvent) => void>();
  private readonly queue: string[] = [];
  private readonly handling = new Map<string, Handling>();
  /** Prompt text of steered events → event ID, to take back steering Pi did not deliver. */
  private readonly steered = new Map<string, string>();
  private readonly idleWaiters: (() => void)[] = [];
  private session: AgentSession | undefined;
  private unavailableCode: UnavailableCode | undefined;
  private turn: Turn | undefined;
  private running: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private avatar: { expression: Expression; by: 'server' | 'model' } = { expression: 'neutral', by: 'server' };

  private constructor(options: LoopOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Opens or creates the Pi session. Problems leave the loop unavailable instead of throwing or replacing history. */
  static async open(options: LoopOptions): Promise<ThinkingLoop> {
    const loop = new ThinkingLoop(options);
    await loop.start();
    return loop;
  }

  get unavailable(): UnavailableCode | undefined {
    return this.unavailableCode ?? (this.closing ? 'stopping' : undefined);
  }

  subscribe(listener: (event: LoopClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Records an owner message and its event, then answers. Client events follow on a microtask, so the caller can
   * deliver `command.accepted` first.
   */
  send(input: { requestId: string; deviceId: string; text: string }): SendOutcome {
    const unavailable = this.unavailable;
    if (unavailable) return { kind: 'unavailable', code: unavailable };
    const { db } = this.options;
    const existing = db.prepare(`SELECT m.message_id, m.device_id, m.text, m.event_id, e.state FROM conversation_messages m
      JOIN loop_events e ON e.event_id = m.event_id WHERE m.request_id = ?`).get(input.requestId) as
      { message_id: string; device_id: string; text: string; event_id: string; state: EventState } | undefined;
    if (existing) {
      if (existing.text !== input.text || existing.device_id !== input.deviceId) return { kind: 'rejected', code: 'request-conflict' };
      return { kind: 'accepted', messageId: existing.message_id, eventId: existing.event_id, state: existing.state };
    }

    const eventId = `event-${randomUUID()}`;
    const row = this.transaction(() => {
      const message = this.insertMessage({ role: 'owner', kind: 'message', text: input.text, eventId,
        requestId: input.requestId, deviceId: input.deviceId });
      const now = this.iso();
      db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
        VALUES (?, 'mac-message', ?, 'queued', ?, ?)`).run(eventId, message.message_id, now, now);
      return message;
    });

    let state: EventState = 'queued';
    const session = this.session!;
    if (this.turn && session.isStreaming) {
      // Steered in at the next model-call boundary; the thought in progress is not interrupted (Q1).
      this.beginHandling(eventId, row.message_id);
      const prompt = formatEvents([this.eventLine(eventId)]);
      this.steered.set(prompt, eventId);
      void session.steer(prompt);
      state = 'processing';
    } else {
      // Owner messages are the only kind of event so far; other kinds will queue behind them.
      this.queue.push(eventId);
    }
    queueMicrotask(() => {
      this.emit('conversation.message', shown(row));
      // The server shows that natsumi is thinking without waiting for the model (Q2).
      this.setAvatar('thinking', 'server');
      this.pump();
    });
    return { kind: 'accepted', messageId: row.message_id, eventId, state };
  }

  /** The conversation shown to the owner, built from SQLite only. Pi's record never appears here. */
  snapshot(): LoopSnapshot {
    const { db } = this.options;
    const rows = db.prepare(`SELECT * FROM (SELECT * FROM conversation_messages ORDER BY position DESC LIMIT ?) ORDER BY position`)
      .all(SNAPSHOT_MESSAGE_LIMIT) as unknown as MessageRow[];
    const pending = db.prepare(`SELECT e.event_id, e.message_id, e.state FROM loop_events e
      JOIN conversation_messages m ON m.message_id = e.message_id
      WHERE e.state IN ('queued', 'processing') ORDER BY m.position`).all() as { event_id: string; message_id: string; state: EventState }[];
    return {
      messages: rows.map(shown),
      pendingEvents: pending.map(row => ({ eventId: row.event_id, messageId: row.message_id, state: row.state })),
      avatar: { expression: this.avatar.expression },
    };
  }

  /** Resolves when no turn is running and nothing is queued. */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  /** Refuses new messages, stops the turn in progress, records its events and releases the Pi session. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.running && this.session) {
        await this.session.abort();
        await this.running;
      }
      this.session?.dispose();
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    })();
    return this.closing;
  }

  private async start() {
    const { db, dataDirectory, sessionDirectory, agentDirectory, target } = this.options;
    let modelRuntime: ModelRuntime;
    try { modelRuntime = await this.options.runtime(); } catch { return this.fail('pi-unavailable'); }
    const base = {
      cwd: dataDirectory, agentDir: agentDirectory, sessionDir: sessionDirectory, modelRuntime, target,
      systemPrompt: await this.systemPrompt(),
      thinkingLevel: this.options.thinking === 'on' ? 'medium' as const : 'off' as const,
      tools: { names: LOOP_TOOL_NAMES, definitions: createLoopTools(this.host()) },
    };
    const row = db.prepare('SELECT conversation_id, pi_session_id, pi_session_file FROM conversations ORDER BY created_at LIMIT 1')
      .get() as ConversationRow | undefined;
    let created: AgentSession | undefined;
    try {
      if (row) {
        const file = resolve(sessionDirectory, row.pi_session_file);
        const rel = relative(sessionDirectory, file);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new PiSessionRestoreError('Pi session reference outside the session directory');
        this.session = await openPiSession({ ...base, file, expectedSessionId: row.pi_session_id });
      } else {
        created = await createPersistedPiSession(base);
        db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
          .run(`conversation-${randomUUID()}`, created.sessionId, relative(sessionDirectory, created.sessionFile!), this.iso());
        this.session = created;
      }
    } catch (error) {
      created?.dispose();
      return this.fail(error instanceof PiSessionRestoreError ? 'conversation-restore-failed' : 'pi-unavailable');
    }
    this.options.configureSession?.(this.session);
    // Every steered message waiting at a boundary goes in together.
    this.session.setSteeringMode('all');
    this.session.agent.shouldStopAfterTurn = context => this.shouldStop(context);
    this.recover();
    this.pump();
  }

  private fail(code: UnavailableCode) {
    this.unavailableCode = code;
    this.log(`thinking loop unavailable: ${code}`);
  }

  private log(line: string) { this.options.log?.(line); }

  private iso() { return new Date(this.now()).toISOString(); }

  private async systemPrompt(): Promise<string> {
    let personality = '';
    try { personality = (await readFile(join(this.options.dataDirectory, 'personality.md'), 'utf8')).trim(); } catch { /* none */ }
    return personality ? `${BASE_INSTRUCTION}\n\n# 性格・話し方\n\n${personality}` : BASE_INSTRUCTION;
  }

  /**
   * Events a previous process left behind. Queued ones run again; one that was being handled is never handed to Pi
   * twice: it counts as replied if its reply was recorded, and as failed otherwise.
   */
  private recover() {
    const { db } = this.options;
    const now = this.iso();
    const stopped = db.prepare(`UPDATE loop_events SET
        state = CASE WHEN EXISTS (SELECT 1 FROM conversation_messages r WHERE r.kind = 'reply' AND r.event_id = loop_events.event_id)
          THEN 'replied' ELSE 'failed' END,
        reason = CASE WHEN EXISTS (SELECT 1 FROM conversation_messages r WHERE r.kind = 'reply' AND r.event_id = loop_events.event_id)
          THEN NULL ELSE 'interrupted' END,
        updated_at = ?
      WHERE state = 'processing'`).run(now);
    if (Number(stopped.changes) > 0) this.log(`thinking loop: ${stopped.changes} interrupted event(s) closed`);
    const queued = db.prepare(`SELECT event_id FROM loop_events WHERE state = 'queued' ORDER BY created_at, event_id`).all() as { event_id: string }[];
    this.queue.push(...queued.map(row => row.event_id));
  }

  private pump() {
    if (this.running || this.closing || this.unavailableCode || !this.session) { this.settle(); return; }
    const eventId = this.queue.shift();
    if (!eventId) { this.settle(); return; }
    this.running = this.runTurn([eventId]).finally(() => {
      this.running = undefined;
      this.pump();
    });
  }

  private settle() {
    if (this.running || this.queue.length > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private async runTurn(eventIds: string[]) {
    const session = this.session!;
    const turn: Turn = { calls: 0, limited: false, timedOut: false, notices: 0 };
    this.turn = turn;
    for (const eventId of eventIds) {
      const row = this.options.db.prepare('SELECT message_id FROM loop_events WHERE event_id = ?').get(eventId) as { message_id: string };
      this.beginHandling(eventId, row.message_id);
    }
    const before = session.messages.length;
    const timer = setTimeout(() => { turn.timedOut = true; void session.abort(); }, this.options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    try {
      await session.prompt(formatEvents(eventIds.map(id => this.eventLine(id))), { expandPromptTemplates: false });
    } catch {
      // Judged below from what Pi recorded; the error text never leaves the server.
    } finally { clearTimeout(timer); }

    // Steering Pi did not deliver goes back to the front of the queue.
    for (const text of session.clearQueue().steering.reverse()) {
      const eventId = this.steered.get(text);
      if (!eventId) continue;
      this.handling.delete(eventId);
      this.setEventState(eventId, 'queued');
      this.queue.unshift(eventId);
    }
    this.steered.clear();

    const last = session.messages.slice(before).filter(message => message.role === 'assistant').at(-1) as { stopReason?: string } | undefined;
    const failure = turn.limited ? 'model-call-limit' : turn.timedOut ? 'timeout' : this.closing ? 'stopped'
      : !last || (last.stopReason !== 'stop' && last.stopReason !== 'toolUse') ? 'model-error' : undefined;
    for (const handling of this.handling.values()) {
      const status: EventState = handling.replied ? 'replied' : handling.finished || !failure ? 'no-reply' : 'failed';
      this.setEventState(handling.eventId, status, status === 'failed' ? failure : undefined);
      if (status === 'failed') this.log(`thinking loop: an event failed (${failure})`);
      this.emit('conversation.event.completed', {
        eventId: handling.eventId, messageId: handling.messageId, status, ...(status === 'failed' ? { reason: failure } : {}),
      });
    }
    this.handling.clear();
    this.turn = undefined;
    if (this.avatar.by === 'server' && this.avatar.expression === 'thinking' && this.queue.length === 0) this.setAvatar('neutral', 'server');
  }

  /** Pi asks after every completed model call whether the turn ends here. */
  private shouldStop({ message, toolResults }: StopContext): boolean {
    const turn = this.turn;
    if (!turn) return false;
    turn.calls += 1;
    const allFinished = this.handling.size > 0 && [...this.handling.values()].every(handling => handling.finished);
    if (allFinished && toolResults.some(result => result.toolName === 'finish_event' && !result.isError)
      && this.session!.getSteeringMessages().length === 0) return true;
    if (message.stopReason === 'toolUse' && turn.calls >= (this.options.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS)) {
      turn.limited = true;
      return true;
    }
    return false;
  }

  private beginHandling(eventId: string, messageId: string) {
    this.handling.set(eventId, { eventId, messageId, replied: this.hasReply(eventId), finished: false });
    this.setEventState(eventId, 'processing');
  }

  private hasReply(eventId: string): boolean {
    return this.options.db.prepare(`SELECT 1 FROM conversation_messages WHERE kind = 'reply' AND event_id = ?`).get(eventId) !== undefined;
  }

  private setEventState(eventId: string, state: EventState, reason?: string) {
    this.options.db.prepare('UPDATE loop_events SET state = ?, reason = ?, updated_at = ? WHERE event_id = ?')
      .run(state, reason ?? null, this.iso(), eventId);
  }

  /** The line one event becomes inside `<events>`. New event kinds add their own shape here. */
  private eventLine(eventId: string): Record<string, unknown> {
    const row = this.options.db.prepare(`SELECT e.kind, m.text, m.created_at FROM loop_events e
      JOIN conversation_messages m ON m.message_id = e.message_id WHERE e.event_id = ?`).get(eventId) as { kind: string; text: string; created_at: string };
    return { event_id: eventId, type: 'mac_message', received_at: row.created_at, text: row.text };
  }

  private host(): LoopToolHost {
    return {
      reply: (eventId, text) => this.reply(eventId, text),
      notify: (text, about) => this.notify(text, about),
      finish: eventId => this.finish(eventId),
      setExpression: expression => {
        this.setAvatar(expression, 'model');
        return { ok: true, text: `アバターの表情を ${expression} にしました。` };
      },
    };
  }

  private reply(eventId: string, text: string): ToolOutcome {
    const handling = this.handling.get(eventId);
    if (!handling) {
      return { ok: false, text: `送信していません。${eventId} は処理中の本人のメッセージではありません。返事は、いま届いている本人のメッセージの event_id にだけ送れます。` };
    }
    if (handling.replied) {
      return { ok: false, text: `送信していません。イベント ${eventId} にはすでに返事を送っています。1 つのメッセージへの返事は 1 回だけです。` };
    }
    const check = checkOutgoingText(text);
    if (!check.ok) return { ok: false, text: refusalText(check) };
    const row = this.insertMessage({ role: 'natsumi', kind: 'reply', text, eventId });
    handling.replied = true;
    this.emit('conversation.message', shown(row));
    return { ok: true, text: `本人の Mac に返事を送りました（event_id: ${eventId}）。この返事は確定し、このメッセージにはもう返事を送れません。対応を終えるなら finish_event を呼んでください。` };
  }

  private notify(text: string, about: string[]): ToolOutcome {
    const { db } = this.options;
    for (const eventId of about) {
      if (db.prepare('SELECT 1 FROM loop_events WHERE event_id = ?').get(eventId) === undefined) {
        return { ok: false, text: `送信していません。about_event_ids の ${eventId} は存在しないイベントです。` };
      }
    }
    const limits = this.options.notifyLimits ?? DEFAULT_NOTIFY_LIMITS;
    const turn = this.turn;
    if (turn && turn.notices >= limits.perTurn) {
      return { ok: false, text: `送信していません。1 回の処理で本人に送れる知らせの上限（${limits.perTurn} 件）に達しました。` };
    }
    const hour = db.prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE kind = 'notice' AND created_at >= ?`)
      .get(new Date(this.now() - 3_600_000).toISOString()) as { n: number };
    if (hour.n >= limits.perHour) {
      return { ok: false, text: `送信していません。1 時間に本人に送れる知らせの上限（${limits.perHour} 件）に達しました。急ぎでなければ後でまとめて伝えてください。` };
    }
    const check = checkOutgoingText(text);
    if (!check.ok) return { ok: false, text: refusalText(check) };
    const row = this.insertMessage({ role: 'natsumi', kind: 'notice', text, about: [...new Set(about)] });
    if (turn) turn.notices += 1;
    this.emit('conversation.message', shown(row));
    return { ok: true, text: '本人に知らせを送りました。返事を待つ必要はありません。同じ内容を繰り返し送らないでください。' };
  }

  private finish(eventId: string): ToolOutcome {
    const handling = this.handling.get(eventId);
    if (!handling) return { ok: false, text: `${eventId} は処理中のイベントではありません。` };
    handling.finished = true;
    const open = [...this.handling.values()].filter(other => !other.finished).map(other => other.eventId);
    if (open.length > 0) {
      return { ok: true, text: `イベント ${eventId} の対応は完了しました。まだ対応中のイベント: ${open.join(', ')}。` };
    }
    return { ok: true, text: `イベント ${eventId} の対応は完了しました。このターンはここで終わります。追加の出力は不要です。`, closesTurn: true };
  }

  private insertMessage(message: { role: ShownMessage['role']; kind: ShownMessage['kind']; text: string; eventId?: string;
    about?: string[]; requestId?: string; deviceId?: string }): MessageRow {
    const { db } = this.options;
    const messageId = `message-${randomUUID()}`;
    db.prepare(`INSERT INTO conversation_messages
      (message_id, position, role, kind, text, event_id, about_event_ids, request_id, device_id, created_at)
      VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM conversation_messages), ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      messageId, message.role, message.kind, message.text, message.eventId ?? null,
      message.about && message.about.length > 0 ? JSON.stringify(message.about) : null,
      message.requestId ?? null, message.deviceId ?? null, this.iso());
    return db.prepare('SELECT * FROM conversation_messages WHERE message_id = ?').get(messageId) as unknown as MessageRow;
  }

  private transaction<T>(fn: () => T): T {
    const { db } = this.options;
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  private setAvatar(expression: Expression, by: 'server' | 'model') {
    this.avatar = { expression, by };
    this.emit('avatar.expression', { expression });
  }

  private emit(type: string, payload: object) {
    for (const listener of this.listeners) {
      try { listener({ type, payload: payload as Record<string, unknown> }); } catch { /* one listener cannot stop the others */ }
    }
  }
}

/** Events handed to Pi: one JSON line per event inside `<events>`, as in the loop evaluation. */
export function formatEvents(lines: Record<string, unknown>[]): string {
  return `<events>\n${lines.map(line => JSON.stringify(line)).join('\n')}\n</events>`;
}

function shown(row: MessageRow): ShownMessage {
  const base = { messageId: row.message_id, role: row.role, kind: row.kind, text: row.text, createdAt: row.created_at };
  if (row.kind === 'message') return { ...base, eventId: row.event_id! };
  if (row.kind === 'reply') return { ...base, replyTo: row.event_id! };
  const about = row.about_event_ids ? JSON.parse(row.about_event_ids) as string[] : [];
  return about.length > 0 ? { ...base, about } : base;
}
