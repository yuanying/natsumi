import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPersistedPiSession, openPiSession, PiSessionRestoreError, type PiTarget } from '../pi-session.ts';

type PiEvent = Parameters<Parameters<AgentSession['subscribe']>[0]>[0];
type PiEntry = ReturnType<AgentSession['sessionManager']['getBranch']>[number];
type PiMessage = AgentSession['messages'][number];

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

const BASE_INSTRUCTION = `You are natsumi, a personal assistant for one person, who talks with you through a desktop companion on their Macs.
You have no tools in this conversation: you cannot read files, run commands, browse the web or change calendars, so do not claim to.
Reply in the language the person writes in.`;

export type TurnStatus = 'completed' | 'failed' | 'interrupted';
export type OperationState = 'accepted' | 'prompted' | TurnStatus | 'unknown';
/** Safe codes only: upstream error text never leaves the server. */
export type UnavailableCode = 'pi-unavailable' | 'conversation-restore-failed' | 'stopping';

export interface ConversationEvent { type: string; requestId?: string; payload: Record<string, unknown> }

export type SendOutcome =
  | { kind: 'accepted'; turnId: string; state: OperationState }
  | { kind: 'rejected'; code: string; turnId?: string }
  | { kind: 'unavailable'; code: UnavailableCode };

export type InterruptOutcome =
  | { kind: 'accepted'; turnId: string }
  | { kind: 'rejected'; code: string }
  | { kind: 'unavailable'; code: UnavailableCode };

/** A confirmed entry of the current Pi branch, as shown to clients. */
export interface HistoryItem { entryId: string; role: 'user' | 'assistant'; text: string; createdAt: string; status?: TurnStatus }
/** An assistant message still streaming: its text so far, consistent with the snapshot's sequence number. */
export interface LiveItem { itemId: string; role: 'assistant'; text: string }

export interface Snapshot {
  conversationId: string;
  history: HistoryItem[];
  activeTurn: { turnId: string; requestId: string; items: LiveItem[] } | null;
  /** Operations that are in flight or whose outcome could not be determined. */
  operations: { requestId: string; turnId: string; state: OperationState }[];
}

export interface ConversationOptions {
  db: DatabaseSync;
  dataDirectory: string;
  sessionDirectory: string;
  agentDirectory: string;
  target: PiTarget;
  runtime: () => Promise<ModelRuntime>;
  /** Called once with the Pi session before any prompt. Tests replace the model stream here. */
  configureSession?: (session: AgentSession) => void;
  turnTimeoutMs?: number;
  log?: (line: string) => void;
}

interface ActiveTurn {
  turnId: string;
  requestId: string;
  items: LiveItem[];
  current?: LiveItem;
  userEntryId?: string;
  lastAssistant?: PiMessage;
  interruptRequested: boolean;
  done: Promise<void>;
  finish: () => void;
}

interface ConversationRow { conversation_id: string; pi_session_id: string; pi_session_file: string }
interface OperationRow { request_id: string; device_id: string; body_hash: string; state: OperationState; turn_id: string; pi_user_entry_id: string | null }

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const nowIso = () => new Date().toISOString();

/**
 * The one conversation shared by every device, backed by one persistent Pi session (ADR 0001).
 *
 * SQLite keeps only the conversation ↔ Pi session reference and the send operations (request ID, device, body hash,
 * state, turn ID, Pi user entry ID). Turns run one at a time; live Pi events become client events for every device.
 */
export class ConversationService {
  private readonly options: ConversationOptions;
  private readonly listeners = new Set<(event: ConversationEvent) => void>();
  private session: AgentSession | undefined;
  private id: string | undefined;
  private unavailableCode: UnavailableCode | undefined;
  private active: ActiveTurn | undefined;
  private closing: Promise<void> | undefined;

  private constructor(options: ConversationOptions) {
    this.options = options;
  }

  /** Opens or creates the Pi session. Problems leave the service unavailable instead of throwing or replacing history. */
  static async open(options: ConversationOptions): Promise<ConversationService> {
    const service = new ConversationService(options);
    await service.start();
    return service;
  }

  get conversationId(): string | undefined { return this.id; }

  get unavailable(): UnavailableCode | undefined {
    return this.unavailableCode ?? (this.closing ? 'stopping' : undefined);
  }

  subscribe(listener: (event: ConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Records the operation, answers, and only then prompts Pi (on a microtask after this returns), so the caller can
   * deliver `command.accepted` before any turn event.
   */
  send(input: { requestId: string; deviceId: string; text: string }): SendOutcome {
    const unavailable = this.unavailable;
    if (unavailable) return { kind: 'unavailable', code: unavailable };
    const { db } = this.options;
    const hash = sha256(input.text);
    const existing = db.prepare(`SELECT request_id, device_id, body_hash, state, turn_id, pi_user_entry_id
      FROM conversation_operations WHERE request_id = ?`).get(input.requestId) as OperationRow | undefined;
    if (existing) {
      if (existing.body_hash !== hash || existing.device_id !== input.deviceId) return { kind: 'rejected', code: 'request-conflict' };
      if (existing.state === 'unknown') return { kind: 'rejected', code: 'operation-unknown', turnId: existing.turn_id };
      return { kind: 'accepted', turnId: existing.turn_id, state: existing.state };
    }
    if (this.active) return { kind: 'rejected', code: 'busy' };

    const turnId = `turn-${randomUUID()}`;
    const now = nowIso();
    db.prepare(`INSERT INTO conversation_operations (request_id, device_id, conversation_id, body_hash, state, turn_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?)`).run(input.requestId, input.deviceId, this.id!, hash, turnId, now, now);
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const turn: ActiveTurn = { turnId, requestId: input.requestId, items: [], interruptRequested: false, done, finish };
    this.active = turn;
    queueMicrotask(() => { void this.run(turn, input.text); });
    return { kind: 'accepted', turnId, state: 'accepted' };
  }

  /** Stops the current turn only. */
  interrupt(turnId: string): InterruptOutcome {
    const unavailable = this.unavailable;
    if (unavailable) return { kind: 'unavailable', code: unavailable };
    const turn = this.active;
    if (!turn || turn.turnId !== turnId) return { kind: 'rejected', code: 'turn-not-active' };
    turn.interruptRequested = true;
    void this.session!.abort();
    return { kind: 'accepted', turnId };
  }

  /**
   * The current branch as display items plus the turn in progress. It is built synchronously from Pi's in-memory
   * session, so no Pi event can land between reading history and reading the live items: a client applies the deltas
   * numbered after this snapshot on top of the live items' text.
   */
  snapshot(): Snapshot {
    const session = this.session;
    if (!session || !this.id) throw new Error('conversation unavailable');
    const history: HistoryItem[] = [];
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== 'message') continue;
      const role = roleOf(entry.message);
      if (role === 'user') history.push({ entryId: entry.id, role, text: displayText(entry.message), createdAt: entry.timestamp });
      if (role === 'assistant') {
        history.push({ entryId: entry.id, role, text: displayText(entry.message), createdAt: entry.timestamp, status: replyStatus(entry.message) });
      }
    }
    const turn = this.active;
    const operations = (this.options.db.prepare(`SELECT request_id, turn_id, state FROM conversation_operations
      WHERE conversation_id = ? AND state IN ('accepted', 'prompted', 'unknown') ORDER BY created_at, request_id`).all(this.id) as unknown as OperationRow[])
      .map(row => ({ requestId: row.request_id, turnId: row.turn_id, state: row.state }));
    return {
      conversationId: this.id,
      history,
      activeTurn: turn ? { turnId: turn.turnId, requestId: turn.requestId, items: turn.items.map(item => ({ ...item })) } : null,
      operations,
    };
  }

  /** Refuses new operations, interrupts the turn in progress, records it and releases the Pi session. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const turn = this.active;
      if (turn && this.session) {
        turn.interruptRequested = true;
        await this.session.abort();
        await turn.done;
      }
      this.session?.dispose();
    })();
    return this.closing;
  }

  private async start() {
    const { db, dataDirectory, sessionDirectory, agentDirectory, target } = this.options;
    let modelRuntime: ModelRuntime;
    try { modelRuntime = await this.options.runtime(); } catch { return this.fail('pi-unavailable'); }
    const base = { cwd: dataDirectory, agentDir: agentDirectory, sessionDir: sessionDirectory, modelRuntime, target,
      systemPrompt: await this.systemPrompt() };
    const row = db.prepare('SELECT conversation_id, pi_session_id, pi_session_file FROM conversations ORDER BY created_at LIMIT 1')
      .get() as ConversationRow | undefined;
    let created: AgentSession | undefined;
    try {
      if (row) {
        const file = resolve(sessionDirectory, row.pi_session_file);
        const rel = relative(sessionDirectory, file);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new PiSessionRestoreError('Pi session reference outside the session directory');
        this.session = await openPiSession({ ...base, file, expectedSessionId: row.pi_session_id });
        this.id = row.conversation_id;
      } else {
        created = await createPersistedPiSession(base);
        const id = `conversation-${randomUUID()}`;
        db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
          .run(id, created.sessionId, relative(sessionDirectory, created.sessionFile!), nowIso());
        this.session = created;
        this.id = id;
      }
    } catch (error) {
      created?.dispose();
      return this.fail(error instanceof PiSessionRestoreError ? 'conversation-restore-failed' : 'pi-unavailable');
    }
    this.options.configureSession?.(this.session);
    this.session.subscribe(event => this.onPiEvent(event));
    this.reconcile();
  }

  private fail(code: UnavailableCode) {
    this.unavailableCode = code;
    this.log(`conversation unavailable: ${code}`);
  }

  private log(line: string) { this.options.log?.(line); }

  private async systemPrompt(): Promise<string> {
    let personality = '';
    try { personality = (await readFile(join(this.options.dataDirectory, 'personality.md'), 'utf8')).trim(); } catch { /* none */ }
    return personality ? `${BASE_INSTRUCTION}\n\n# Personality and speaking style\n\n${personality}` : BASE_INSTRUCTION;
  }

  private emit(type: string, payload: Record<string, unknown>, requestId?: string) {
    const event: ConversationEvent = requestId === undefined ? { type, payload } : { type, requestId, payload };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* one listener cannot stop the others */ }
    }
  }

  private async run(turn: ActiveTurn, text: string) {
    const session = this.session!;
    this.emit('conversation.turn.started', { conversationId: this.id, turnId: turn.turnId }, turn.requestId);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void session.abort(); }, this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    try {
      await session.prompt(text, { expandPromptTemplates: false });
    } catch {
      // Judged below from what Pi recorded; the error text is never forwarded.
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setImmediate(resolve)); // let the persisted-entry callbacks of the last messages run
    const { status, reason } = turnOutcome(turn.lastAssistant, timedOut, turn.interruptRequested);
    this.options.db.prepare('UPDATE conversation_operations SET state = ?, updated_at = ? WHERE request_id = ?').run(status, nowIso(), turn.requestId);
    this.active = undefined;
    this.emit('conversation.turn.completed', { conversationId: this.id, turnId: turn.turnId, status, ...(reason ? { reason } : {}) }, turn.requestId);
    turn.finish();
  }

  private onPiEvent(event: PiEvent) {
    const turn = this.active;
    if (!turn) return;
    switch (event.type) {
      case 'agent_start':
        // An interrupt that arrived before Pi began its run.
        if (turn.interruptRequested) void this.session!.abort();
        return;
      case 'message_start':
        if (roleOf(event.message) === 'assistant') {
          turn.current = { itemId: `item-${randomUUID()}`, role: 'assistant', text: '' };
          turn.items.push(turn.current);
        }
        return;
      case 'message_update': {
        const update = event.assistantMessageEvent;
        if (update.type !== 'text_delta' || !turn.current) return;
        turn.current.text += update.delta;
        this.emit('conversation.delta', { conversationId: this.id, turnId: turn.turnId, itemId: turn.current.itemId, text: update.delta });
        return;
      }
      case 'message_end': {
        const role = roleOf(event.message);
        if (role !== 'user' && role !== 'assistant') return;
        const item = role === 'assistant' ? turn.current : undefined;
        if (role === 'assistant') { turn.current = undefined; turn.lastAssistant = event.message; }
        // Pi appends the entry right after notifying listeners, in the same synchronous step.
        const message = event.message;
        queueMicrotask(() => this.onEntryPersisted(turn, message, item));
        return;
      }
      default:
    }
  }

  private onEntryPersisted(turn: ActiveTurn, message: PiMessage, item: LiveItem | undefined) {
    const entries = this.session!.sessionManager.getEntries();
    let entry: PiEntry | undefined;
    for (let i = entries.length - 1; i >= 0 && i >= entries.length - 32; i--) {
      const candidate = entries[i]!;
      if (candidate.type === 'message' && candidate.message === message) { entry = candidate; break; }
    }
    if (!entry) return;
    const role = roleOf(message);
    if (role === 'user') {
      if (turn.userEntryId) return;
      turn.userEntryId = entry.id;
      this.options.db.prepare(`UPDATE conversation_operations SET state = 'prompted', pi_user_entry_id = ?, updated_at = ?
        WHERE request_id = ? AND state = 'accepted'`).run(entry.id, nowIso(), turn.requestId);
    }
    if (item) turn.items.splice(turn.items.indexOf(item), 1);
    this.emit('conversation.item.completed', {
      conversationId: this.id, turnId: turn.turnId, itemId: item?.itemId ?? `item-${randomUUID()}`, entryId: entry.id,
      role, text: displayText(message),
    });
  }

  /**
   * Resolves operations a previous process left in flight. An operation with no saved user entry is matched by body
   * hash to a user entry after the last one already claimed; without exactly one match it becomes `unknown` and is
   * never sent again.
   */
  private reconcile() {
    const { db } = this.options;
    const pending = db.prepare(`SELECT request_id, device_id, body_hash, state, turn_id, pi_user_entry_id FROM conversation_operations
      WHERE conversation_id = ? AND state IN ('accepted', 'prompted') ORDER BY created_at, request_id`).all(this.id!) as unknown as OperationRow[];
    if (pending.length === 0) return;
    const branch = this.session!.sessionManager.getBranch();
    const claimed = new Set((db.prepare('SELECT pi_user_entry_id FROM conversation_operations WHERE pi_user_entry_id IS NOT NULL')
      .all() as { pi_user_entry_id: string }[]).map(row => row.pi_user_entry_id));
    const update = db.prepare('UPDATE conversation_operations SET state = ?, pi_user_entry_id = ?, updated_at = ? WHERE request_id = ?');
    for (const operation of pending) {
      let index = operation.pi_user_entry_id === null ? -1 : branch.findIndex(entry => entry.id === operation.pi_user_entry_id);
      if (operation.pi_user_entry_id === null) {
        let after = -1;
        branch.forEach((entry, i) => { if (claimed.has(entry.id)) after = i; });
        const matches = branch.map((entry, i) => ({ entry, i })).filter(({ entry, i }) => i > after && entry.type === 'message'
          && roleOf(entry.message) === 'user' && sha256(displayText(entry.message)) === operation.body_hash);
        if (matches.length === 1) index = matches[0]!.i;
      }
      if (index < 0) {
        update.run('unknown', operation.pi_user_entry_id, nowIso(), operation.request_id);
        continue;
      }
      const entryId = branch[index]!.id;
      claimed.add(entryId);
      let reply: PiMessage | undefined;
      for (const entry of branch.slice(index + 1)) {
        if (entry.type !== 'message') continue;
        if (roleOf(entry.message) === 'user') break;
        if (roleOf(entry.message) === 'assistant') reply = entry.message;
      }
      // The process stopped during or before the reply: anything but a normal stop is a failed turn.
      const state: TurnStatus = reply ? replyStatus(reply) : 'failed';
      update.run(state, entryId, nowIso(), operation.request_id);
    }
    this.log(`conversation: reconciled ${pending.length} interrupted operation(s)`);
  }
}

function roleOf(message: PiMessage): string | undefined {
  return (message as { role?: string }).role;
}

/** Visible text only: text parts joined, never thinking, tool calls or provider error details. */
function displayText(message: PiMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('');
}

function replyStatus(message: PiMessage): TurnStatus {
  const stopReason = (message as { stopReason?: string }).stopReason;
  return stopReason === 'stop' ? 'completed' : stopReason === 'aborted' ? 'interrupted' : 'failed';
}

/** Only a reply that stopped normally completes a turn. */
function turnOutcome(last: PiMessage | undefined, timedOut: boolean, interrupted: boolean): { status: TurnStatus; reason?: string } {
  const stopReason = last ? (last as { stopReason?: string }).stopReason : undefined;
  if (stopReason === 'stop') return { status: 'completed' };
  if (timedOut) return { status: 'failed', reason: 'timeout' };
  if (interrupted) return { status: 'interrupted' };
  if (!last) return { status: 'failed', reason: 'prompt-failed' };
  if (stopReason === 'length') return { status: 'failed', reason: 'length' };
  return { status: 'failed', reason: 'model-error' };
}
