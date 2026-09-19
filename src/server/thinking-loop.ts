import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSession, AgentSessionEvent, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPersistedPiSession, openPiSession, PiSessionRestoreError, type PiSessionOptions, type PiTarget } from '../pi-session.ts';
import { createLoopTools, type Expression, type LoopToolHost, type ToolOutcome } from './loop-tools.ts';
import { BASE_INSTRUCTION, COMPACTION_INSTRUCTIONS, NO_WORKSPACE_SECTION, REVIEW_INSTRUCTIONS,
  WORKSPACE_SECTION } from './prompts.ts';
import { MemoryRepository, PERSONALITY_FILE, revertNotice } from './memory-repository.ts';
import { DEFAULT_SHELL_WAIT_SECONDS, WorkspaceShell } from './workspace-shell.ts';
import { DEFAULT_SIZE_WARN_BYTES, WorkspaceSize } from './workspace-size.ts';
import { checkOutgoingText, refusalText } from './output-checks.ts';
import { ReadState, type ReadPosition } from './read-state.ts';
import { localDateTime } from './nightly.ts';
import { HOME_DIRECTORY, WORK_DIRECTORY } from './paths.ts';
import { DEFAULT_AWAKE_HOURS, DEFAULT_SELF_CHECK_LIMITS, SelfChecks, type AwakeHours, type SelfCheckLimits } from './scheduler.ts';

/** Model calls one turn may make before it is stopped and its open events fail (the evaluation stopped at 8). */
export const DEFAULT_MAX_MODEL_CALLS = 8;
/** The nightly review may write many memories, so it gets more calls. */
export const DEFAULT_REVIEW_MODEL_CALLS = 16;
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;
/** notify_owner is limited per turn and per rolling hour (ADR 0008). */
export const DEFAULT_NOTIFY_LIMITS = { perTurn: 3, perHour: 12 };
/** Past this estimated context size the session is compacted between turns (ADR 0009). */
export const DEFAULT_COMPACT_AT_TOKENS = 60_000;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
/** The newest messages a snapshot carries. */
export const SNAPSHOT_MESSAGE_LIMIT = 500;
/** The longest the line of thinking sent to the Mac may be; a longer one keeps its newest end (ADR 0017). */
export const THINKING_LINE_MAX_CHARS = 120;
/** The least time between two lines of thinking. What is written in between is thinned out. */
export const THINKING_MIN_INTERVAL_MS = 250;

export type UnavailableCode = 'pi-unavailable' | 'conversation-restore-failed' | 'stopping';
export type EventState = 'queued' | 'processing' | 'replied' | 'no-reply' | 'failed';

/** How a nightly switch ended. A failed switch leaves the current session in place. */
export type RotationOutcome =
  | { result: 'switched' }
  | { result: 'skipped'; reason: 'empty-session' }
  | { result: 'failed'; reason: string };

/** An event for clients. `conversation.message`, `avatar.expression` and `conversation.event.completed`. */
export interface LoopClientEvent {
  type: string;
  payload: Record<string, any>;
  /** Of the moment: sent to whoever is connected, never numbered on a stream and never kept for replay (ADR 0017). */
  ephemeral?: boolean;
}

export type SendOutcome =
  | { kind: 'accepted'; messageId: string; eventId: string; state: EventState }
  | { kind: 'rejected'; code: 'request-conflict' }
  | { kind: 'unavailable'; code: UnavailableCode };

/** Only a message that does not exist (or, for an acknowledgement, is not a notice) is refused. */
export type ReadOutcome =
  | ({ kind: 'accepted' } & ReadPosition)
  | { kind: 'rejected'; code: 'invalid-request' }
  | { kind: 'unavailable'; code: UnavailableCode };

export type AcknowledgeOutcome =
  | { kind: 'accepted'; notificationId: string; acknowledgedAt: string }
  | { kind: 'rejected'; code: 'invalid-request' }
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
  /** The read cursor and the replies after it, including those older than `messages`. */
  readThroughMessageId: string | null;
  unreadReplyCount: number;
  /** Every notice the owner has not checked, oldest first, including those older than `messages`. */
  unacknowledgedNotificationIds: string[];
}

export interface LoopOptions {
  db: DatabaseSync;
  dataDirectory: string;
  sessionDirectory: string;
  agentDirectory: string;
  target: PiTarget;
  thinking: 'on' | 'off';
  runtime: () => Promise<ModelRuntime>;
  /** Called with every Pi session before its first prompt. Tests replace the model stream here. */
  configureSession?: (session: AgentSession) => void;
  maxModelCalls?: number;
  reviewModelCalls?: number;
  runTimeoutMs?: number;
  notifyLimits?: { perTurn: number; perHour: number };
  /** The owner's time zone, for memory dates. UTC when omitted. */
  timeZone?: string;
  compactAtTokens?: number;
  keepRecentTokens?: number;
  /** The workspace container's runner socket. The run_shell tool exists only with it (ADR 0019). */
  workspaceSocket?: string;
  /** `loop.shellWaitSeconds`: how long the server waits for the runner's answer. */
  shellWaitSeconds?: number;
  /** `loop.workspaceSizeWarnBytes`: past this, the next turn is told what the persistent places hold. */
  workspaceSizeWarnBytes?: number;
  /** The memory repository (ADR 0018). `memory/` in the data directory when omitted. */
  memoryRepository?: string;
  /** The longest one memory file may be, in characters. */
  memoryFileMaxChars?: number;
  /** The hours natsumi is up, in `timeZone`: a self-check booked outside them waits for the morning (ADR 0014). */
  awakeHours?: AwakeHours;
  selfCheckLimits?: SelfCheckLimits;
  now?: () => number;
  log?: (line: string) => void;
}

type StopContext = Parameters<NonNullable<AgentSession['agent']['shouldStopAfterTurn']>>[0];

interface MessageRow {
  message_id: string; position: number; role: ShownMessage['role']; kind: ShownMessage['kind']; text: string;
  event_id: string | null; about_event_ids: string | null; request_id: string | null; device_id: string | null; created_at: string;
}
interface ConversationRow { conversation_id: string; pi_session_id: string; pi_session_file: string; created_at: string }
interface RotationRow {
  rotation_id: string; event_id: string; conversation_id: string; from_session_id: string; from_session_file: string;
  state: string; handoff: string | null;
}

/** An event handed to Pi in the current turn. Only owner messages have a message. */
interface Handling { eventId: string; messageId?: string; replied: boolean; finished: boolean }
interface Turn {
  kind: 'events' | 'review';
  calls: number; maxCalls: number; limited: boolean; timedOut: boolean; notices: number;
  /** The review's rotation and the handoff it wrote. */
  rotationId?: string; handoff?: string;
}

/**
 * The single thinking loop (ADR 0008): one Pi session that takes events one at a time and acts only through tools.
 *
 * Owner messages are recorded before they are acknowledged, shown to every device at once, and handed to Pi as
 * events. A message that arrives while Pi is working is steered into the running turn at the next model-call boundary.
 * What the owner sees is kept in SQLite; the Pi session is the separate record of thinking.
 *
 * Long-term memory lives in `memory/`, reached through tools, and is a git repository: at the end of every turn the
 * server checks what changed there, puts back what fails, and commits the rest (ADR 0018). Each night the session is
 * reviewed and replaced by a new one that starts from a handoff; in between, a session past its limit is compacted
 * (ADR 0009).
 */
export class ThinkingLoop {
  private readonly options: LoopOptions;
  private readonly now: () => number;
  private readonly memoryRepository: MemoryRepository;
  private readonly workspaceSize: WorkspaceSize;
  private readonly readState: ReadState;
  private readonly shell: WorkspaceShell | undefined;
  private readonly listeners = new Set<(event: LoopClientEvent) => void>();
  private readonly queue: string[] = [];
  private readonly handling = new Map<string, Handling>();
  /** Prompt text of steered events → event ID, to take back steering Pi did not deliver. */
  private readonly steered = new Map<string, string>();
  private readonly idleWaiters: (() => void)[] = [];
  private readonly rotationWaiters = new Map<string, ((outcome: RotationOutcome) => void)[]>();
  private modelRuntime: ModelRuntime | undefined;
  private session: AgentSession | undefined;
  private unavailableCode: UnavailableCode | undefined;
  private turn: Turn | undefined;
  private running: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  /** After a failed compaction, the context size it waits to exceed before trying again. */
  private compactionRetryAbove: number | undefined;
  private avatar: { expression: Expression; by: 'server' | 'model'; changedAt: number };
  private readonly selfChecks: SelfChecks;
  /** When something last arrived or was last handled: the quiet interval before a ping counts from here (ADR 0014). */
  private activityAt: number;
  /** A nightly switch is under way; natsumi sleeps through it. */
  private rotating = false;
  /** The line of thinking being written, the one last sent, and when it went (ADR 0017). */
  private readonly thinking = { line: '', sent: '', at: 0 };
  /** Stops watching the Pi session the loop is attached to. */
  private unwatch: (() => void) | undefined;
  /** What the last commit put back, waiting to be told to natsumi in the next prompt (ADR 0018). */
  private memoryNotice = '';
  /** What the persistent places hold, when they are past the warning; it waits for the next prompt (ADR 0019). */
  private workspaceNotice = '';

  private constructor(options: LoopOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    // One directory, two ways in: the shell writes the files, and the repository is what commits them.
    const memoryDirectory = options.memoryRepository ?? join(options.dataDirectory, 'memory');
    this.memoryRepository = new MemoryRepository({
      directory: memoryDirectory, dataDirectory: options.dataDirectory,
      ...(options.memoryFileMaxChars === undefined ? {} : { fileMaxChars: options.memoryFileMaxChars }),
      log: line => this.log(line),
    });
    this.readState = new ReadState(options.db, this.now);
    this.shell = options.workspaceSocket
      ? new WorkspaceShell({
        socketPath: options.workspaceSocket,
        timeoutMs: (options.shellWaitSeconds ?? DEFAULT_SHELL_WAIT_SECONDS) * 1000,
        timeZone: options.timeZone ?? 'UTC',
        memoryChanges: () => this.memoryRepository.changeSummary(),
      })
      : undefined;
    // The three places that survive a restart, under the names natsumi sees inside the container (ADR 0019).
    this.workspaceSize = new WorkspaceSize({
      places: [{ label: '/memory', path: memoryDirectory },
        { label: '/work', path: join(options.dataDirectory, WORK_DIRECTORY) },
        { label: '/home/natsumi', path: join(options.dataDirectory, HOME_DIRECTORY) }],
      warnBytes: options.workspaceSizeWarnBytes ?? DEFAULT_SIZE_WARN_BYTES,
      now: this.now,
    });
    this.selfChecks = new SelfChecks({ db: options.db, now: this.now, timeZone: options.timeZone ?? 'UTC',
      limits: options.selfCheckLimits ?? DEFAULT_SELF_CHECK_LIMITS, awakeHours: options.awakeHours ?? DEFAULT_AWAKE_HOURS });
    this.activityAt = this.now();
    this.avatar = { expression: 'neutral', by: 'server', changedAt: this.activityAt };
  }

  /**
   * Opens or creates the Pi session. Problems leave the loop unavailable instead of throwing or replacing history.
   * The memory repository is the exception: without it nothing natsumi writes could be kept, so it is made first
   * and a failure there stops the server with the reason (ADR 0018).
   */
  static async open(options: LoopOptions): Promise<ThinkingLoop> {
    const loop = new ThinkingLoop(options);
    await loop.memoryRepository.initialize(loop.latestHandoff());
    await loop.start();
    return loop;
  }

  /** The newest handoff SQLite holds, to seed `handoff.md` on the first start (ADR 0018). */
  private latestHandoff(): string | undefined {
    const row = this.options.db.prepare(`SELECT handoff FROM session_rotations
      WHERE handoff IS NOT NULL ORDER BY updated_at DESC, rotation_id DESC LIMIT 1`).get() as { handoff: string } | undefined;
    return row?.handoff;
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

    this.activityAt = this.now();
    let state: EventState = 'queued';
    const session = this.session!;
    const reviewing = this.turn?.kind === 'review' || this.isRotationQueuedFirst();
    if (this.turn?.kind === 'events' && session.isStreaming) {
      // Steered in at the next model-call boundary; the thought in progress is not interrupted (Q1).
      this.beginHandling(eventId, row.message_id);
      const prompt = formatEvents([this.eventLine(eventId)]);
      this.steered.set(prompt, eventId);
      void session.steer(prompt);
      state = 'processing';
    } else {
      // During the nightly switch or a compaction the message waits, and is handled by the session that follows.
      this.queue.push(eventId);
    }
    queueMicrotask(() => {
      this.emit('conversation.message', shown(row));
      // The server shows that natsumi is thinking without waiting for the model (Q2); asleep, she stays asleep.
      if (!reviewing) this.setAvatar('thinking', 'server');
      this.pump();
    });
    return { kind: 'accepted', messageId: row.message_id, eventId, state };
  }

  /**
   * Marks natsumi's replies read up to a message, for every device (ADR 0013). A position behind the cursor is ignored
   * and the current one returned. Only a move is broadcast, after the answer.
   */
  markRead(input: { throughMessageId: string; deviceId: string }): ReadOutcome {
    const unavailable = this.unavailable;
    if (unavailable) return { kind: 'unavailable', code: unavailable };
    const result = this.readState.markRead(input.throughMessageId, input.deviceId);
    if (!result) return { kind: 'rejected', code: 'invalid-request' };
    const { changed, ...position } = result;
    if (changed) queueMicrotask(() => this.emit('conversation.read', position));
    return { kind: 'accepted', ...position };
  }

  /** Records that the owner checked a notice. Acknowledging it again returns the first record and broadcasts nothing. */
  acknowledgeNotice(input: { notificationId: string; deviceId: string }): AcknowledgeOutcome {
    const unavailable = this.unavailable;
    if (unavailable) return { kind: 'unavailable', code: unavailable };
    const result = this.readState.acknowledge(input.notificationId, input.deviceId);
    if (!result) return { kind: 'rejected', code: 'invalid-request' };
    const acked = { notificationId: input.notificationId, acknowledgedAt: result.acknowledgedAt };
    if (result.changed) queueMicrotask(() => this.emit('notification.acked', acked));
    return { kind: 'accepted', ...acked };
  }

  /**
   * Reviews the day in the current session and switches to a new one that starts from the review's handoff.
   * Resolves once the switch has ended; a switch already waiting or running is joined rather than repeated.
   */
  rotate(): Promise<RotationOutcome> {
    const unavailable = this.unavailable;
    if (unavailable) return Promise.resolve({ result: 'failed', reason: unavailable });
    const { db } = this.options;
    const pending = db.prepare(`SELECT event_id FROM loop_events WHERE kind = 'nightly-review' AND state IN ('queued', 'processing')`)
      .get() as { event_id: string } | undefined;
    let eventId = pending?.event_id;
    if (!eventId) {
      eventId = this.insertEvent('nightly-review');
      this.queue.push(eventId);
    }
    const id = eventId;
    return new Promise(resolve => {
      this.rotationWaiters.set(id, [...(this.rotationWaiters.get(id) ?? []), resolve]);
      this.pump();
    });
  }

  /** When the current Pi session began: its switch, or the conversation's creation. */
  sessionStartedAt(): number | undefined {
    const row = this.conversation();
    if (!row) return undefined;
    const switched = this.options.db.prepare(`SELECT updated_at FROM session_rotations WHERE state = 'switched' AND to_session_id = ?`)
      .get(row.pi_session_id) as { updated_at: string } | undefined;
    return Date.parse(switched?.updated_at ?? row.created_at);
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
      ...this.readState.position(),
      unacknowledgedNotificationIds: this.readState.unacknowledgedNotificationIds(),
    };
  }

  /** No turn is running and nothing is waiting: the scheduler may raise an event. */
  get quiet(): boolean {
    return !this.running && this.queue.length === 0 && !this.closing && !this.unavailableCode && this.session !== undefined;
  }

  get lastActivityAt(): number { return this.activityAt; }

  /**
   * Hands every due self-check to the loop as one event, however many there are and however late (ADR 0014).
   * The checks are marked delivered together with the event, so none is handed over twice.
   */
  deliverDueSelfChecks(): boolean {
    if (!this.quiet) return false;
    const due = this.selfChecks.due();
    if (due.length === 0) return false;
    const eventId = this.transaction(() => {
      const id = this.insertEvent('self-check');
      this.selfChecks.deliver(due.map(check => check.checkId), id);
      return id;
    });
    this.queue.push(eventId);
    this.pump();
    return true;
  }

  /** Hands the loop a ping: the "anything you want to do?" of a quiet moment (ADR 0014). */
  ping(): boolean {
    if (!this.quiet) return false;
    this.queue.push(this.insertEvent('ping'));
    this.pump();
    return true;
  }

  /**
   * Returns the avatar to neutral once an expression has been shown for `afterMs`. Thinking is released when the
   * handling ends instead, and natsumi stays asleep through the nightly switch.
   */
  relaxExpression(afterMs: number): void {
    const { expression, changedAt } = this.avatar;
    if (expression === 'neutral' || expression === 'thinking' || this.rotating) return;
    if (this.now() - changedAt >= afterMs) this.setAvatar('neutral', 'server');
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
        this.session.abortCompaction();
        await this.session.abort();
        await this.running;
      }
      this.unwatch?.();
      this.unwatch = undefined;
      this.session?.dispose();
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      for (const [eventId, waiters] of this.rotationWaiters) {
        this.rotationWaiters.delete(eventId);
        for (const resolve of waiters) resolve({ result: 'failed', reason: 'stopped' });
      }
    })();
    return this.closing;
  }

  private async start() {
    const { db, sessionDirectory } = this.options;
    try { this.modelRuntime = await this.options.runtime(); } catch { return this.fail('pi-unavailable'); }
    this.closeInterruptedReviews();
    const row = this.conversation();
    let created: AgentSession | undefined;
    try {
      if (row) {
        const unfinished = db.prepare(`SELECT * FROM session_rotations WHERE state IN ('reviewing', 'switching')
          AND handoff IS NOT NULL AND conversation_id = ? AND from_session_id = ?`).get(row.conversation_id, row.pi_session_id) as
          RotationRow | undefined;
        if (unfinished) {
          // A switch stopped after its handoff was written: finish it rather than lose the review or start blank.
          created = await createPersistedPiSession(await this.sessionOptions(unfinished.handoff!));
          this.commitSwitch(unfinished, created);
          this.log('thinking loop: an interrupted nightly switch was finished');
          this.session = created;
        } else {
          const file = resolve(sessionDirectory, row.pi_session_file);
          const rel = relative(sessionDirectory, file);
          if (rel.startsWith('..') || isAbsolute(rel)) throw new PiSessionRestoreError('Pi session reference outside the session directory');
          this.session = await openPiSession({ ...await this.sessionOptions(this.handoffFor(row.pi_session_id)),
            file, expectedSessionId: row.pi_session_id });
        }
      } else {
        created = await createPersistedPiSession(await this.sessionOptions());
        db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
          .run(`conversation-${randomUUID()}`, created.sessionId, relative(sessionDirectory, created.sessionFile!), this.iso());
        this.session = created;
      }
    } catch (error) {
      created?.dispose();
      this.session = undefined;
      return this.fail(error instanceof PiSessionRestoreError ? 'conversation-restore-failed' : 'pi-unavailable');
    }
    this.attach(this.session);
    this.recover();
    this.pump();
  }

  private async sessionOptions(handoff?: string): Promise<Omit<PiSessionOptions, 'file' | 'expectedSessionId'>> {
    const { dataDirectory, sessionDirectory, agentDirectory, target } = this.options;
    const tools = createLoopTools(this.host());
    return {
      cwd: dataDirectory, agentDir: agentDirectory, sessionDir: sessionDirectory, modelRuntime: this.modelRuntime!, target,
      systemPrompt: await this.systemPrompt(handoff),
      thinkingLevel: this.options.thinking === 'on' ? 'medium' as const : 'off' as const,
      tools: { names: tools.map(tool => tool.name), definitions: tools },
      keepRecentTokens: this.options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    };
  }

  private attach(session: AgentSession) {
    this.session = session;
    this.options.configureSession?.(session);
    this.unwatch?.();
    // The thinking in progress is read off the session, never out of the record it writes.
    this.unwatch = session.subscribe(event => this.watchThinking(event));
    // Every steered message waiting at a boundary goes in together.
    session.setSteeringMode('all');
    session.agent.shouldStopAfterTurn = context => this.shouldStop(context);
  }

  private fail(code: UnavailableCode) {
    this.unavailableCode = code;
    this.log(`thinking loop unavailable: ${code}`);
  }

  private log(line: string) { this.options.log?.(line); }

  private iso() { return new Date(this.now()).toISOString(); }

  private conversation(): ConversationRow | undefined {
    return this.options.db.prepare('SELECT conversation_id, pi_session_id, pi_session_file, created_at FROM conversations ORDER BY created_at LIMIT 1')
      .get() as ConversationRow | undefined;
  }

  /** The handoff a session was started with, if it came from a nightly switch. */
  private handoffFor(sessionId: string): string | undefined {
    const row = this.options.db.prepare(`SELECT handoff FROM session_rotations WHERE state = 'switched' AND to_session_id = ?`)
      .get(sessionId) as { handoff: string } | undefined;
    return row?.handoff;
  }

  /**
   * The instructions: natsumi's base, the personality, and the handoff of the night this session began with.
   * Memories are never included; they are read through tools when needed.
   */
  private async systemPrompt(handoff?: string): Promise<string> {
    let personality = '';
    try { personality = (await readFile(join(this.memoryRepository.directory, PERSONALITY_FILE), 'utf8')).trim(); } catch { /* none */ }
    const instruction = BASE_INSTRUCTION(this.shell ? WORKSPACE_SECTION : NO_WORKSPACE_SECTION);
    let prompt = personality ? `${instruction}\n\n# 性格・話し方\n\n${personality}` : instruction;
    if (handoff) prompt += `\n\n# 前の思考の記録からの引き継ぎ\n\n昨夜の振り返りで、あなた自身が書いたメモです。\n\n${handoff}`;
    // A review turn has no next turn, so what its commit put back rides in the new session's instructions instead.
    const notice = this.takeMemoryNotice();
    if (notice) prompt += `\n\n# 記憶の検査\n\n${notice}`;
    return prompt;
  }

  /** The note about reverted files, taken once: whoever writes the next prompt carries it. */
  private takeMemoryNotice(): string {
    const notice = this.memoryNotice;
    this.memoryNotice = '';
    return notice;
  }

  /**
   * The note about how much the persistent places hold, taken once. It only ever rides on a turn's prompt, never in
   * the instructions: what changes every turn must stay off the prefix cache (ADR 0019).
   */
  private takeWorkspaceNotice(): string {
    const notice = this.workspaceNotice;
    this.workspaceNotice = '';
    return notice;
  }

  /** Measures the persistent places, at most once every ten minutes, and keeps the line for the next turn. */
  private async checkWorkspaceSize(): Promise<void> {
    try {
      const notice = await this.workspaceSize.check();
      if (notice) {
        this.workspaceNotice = notice;
        this.log('workspace: the persistent directories are past the size warning');
      }
    } catch {
      // Measuring is a courtesy; a directory that cannot be walked never stops a turn.
    }
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

  /** Reviews stopped before writing a handoff, and switches that no longer start from the current session, have failed. */
  private closeInterruptedReviews() {
    const { db } = this.options;
    const row = this.conversation();
    const closed = db.prepare(`UPDATE session_rotations SET state = 'failed', reason = 'interrupted', updated_at = ?
      WHERE state IN ('reviewing', 'switching') AND (handoff IS NULL OR from_session_id IS NOT ?)`).run(this.iso(), row?.pi_session_id ?? null);
    if (Number(closed.changes) > 0) this.log('thinking loop: an interrupted nightly switch left the session as it was');
  }

  private pump() {
    if (this.running || this.closing || this.unavailableCode || !this.session) { this.settle(); return; }
    const eventId = this.queue.shift();
    if (!eventId) { this.settle(); return; }
    const kind = (this.options.db.prepare('SELECT kind FROM loop_events WHERE event_id = ?').get(eventId) as { kind: string }).kind;
    const work = kind === 'nightly-review' ? this.runRotation(eventId) : this.runTurn([eventId], 'events').then(() => this.maintain());
    this.running = work.finally(() => {
      this.running = undefined;
      this.activityAt = this.now();
      this.pump();
    });
  }

  private settle() {
    if (this.running || this.queue.length > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private isRotationQueuedFirst(): boolean {
    const first = this.queue[0];
    if (!first || this.running) return false;
    const row = this.options.db.prepare('SELECT kind FROM loop_events WHERE event_id = ?').get(first) as { kind: string } | undefined;
    return row?.kind === 'nightly-review';
  }

  /** Runs one turn and records how its events ended. Returns the turn, with the failure if it did not end cleanly. */
  private async runTurn(eventIds: string[], kind: Turn['kind'], rotationId?: string): Promise<Turn & { failure?: string }> {
    const session = this.session!;
    const maxCalls = kind === 'review'
      ? this.options.reviewModelCalls ?? DEFAULT_REVIEW_MODEL_CALLS : this.options.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS;
    const turn: Turn = { kind, calls: 0, maxCalls, limited: false, timedOut: false, notices: 0, rotationId };
    this.turn = turn;
    for (const eventId of eventIds) {
      const row = this.options.db.prepare('SELECT message_id FROM loop_events WHERE event_id = ?').get(eventId) as { message_id: string | null };
      this.beginHandling(eventId, row.message_id ?? undefined);
    }
    const before = session.messages.length;
    const timer = setTimeout(() => { turn.timedOut = true; void session.abort(); }, this.options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    const notices = [this.takeMemoryNotice(), this.takeWorkspaceNotice()].filter(Boolean).join('\n\n');
    const prompt = formatEvents(eventIds.map(id => this.eventLine(id))) + (notices ? `\n\n${notices}` : '');
    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
    } catch {
      // Judged below from what Pi recorded; the error text never leaves the server.
    } finally { clearTimeout(timer); }
    this.endThinking();

    // Steering Pi did not deliver goes back to the front of the queue.
    for (const text of session.clearQueue().steering.reverse()) {
      const eventId = this.steered.get(text);
      if (!eventId) continue;
      this.handling.delete(eventId);
      this.setEventState(eventId, 'queued');
      this.queue.unshift(eventId);
    }
    this.steered.clear();

    // Whatever ended the turn, what memory holds now is checked and committed before the next event (ADR 0018).
    await this.commitMemory(eventIds, kind);
    await this.checkWorkspaceSize();

    const last = session.messages.slice(before).filter(message => message.role === 'assistant').at(-1) as { stopReason?: string } | undefined;
    const failure = turn.limited ? 'model-call-limit' : turn.timedOut ? 'timeout' : this.closing ? 'stopped'
      : !last || (last.stopReason !== 'stop' && last.stopReason !== 'toolUse') ? 'model-error' : undefined;
    for (const handling of this.handling.values()) {
      const status: EventState = handling.replied ? 'replied' : handling.finished || !failure ? 'no-reply' : 'failed';
      this.setEventState(handling.eventId, status, status === 'failed' ? failure : undefined);
      if (!handling.messageId) continue;
      if (status === 'failed') this.log(`thinking loop: an event failed (${failure})`);
      this.emit('conversation.event.completed', {
        eventId: handling.eventId, messageId: handling.messageId, status, ...(status === 'failed' ? { reason: failure } : {}),
      });
    }
    this.handling.clear();
    this.turn = undefined;
    // Thinking ends with the handling, whoever set it (ADR 0014); other expressions return to neutral with time.
    if (this.avatar.expression === 'thinking' && this.queue.length === 0) this.setAvatar('neutral', 'server');
    return { ...turn, ...(failure ? { failure } : {}) };
  }

  /**
   * One commit for the turn, or none when memory did not change. A file that fails the check goes back to the
   * previous commit and its reason waits for the next prompt. A commit that cannot be made is logged, never thrown:
   * the memory is still on disk, and the next turn commits it.
   */
  private async commitMemory(eventIds: string[], kind: Turn['kind']): Promise<void> {
    try {
      const outcome = await this.memoryRepository.commit({ event: this.eventLabel(eventIds), night: kind === 'review' });
      if (outcome.committed) this.log(`memory: committed ${outcome.files.length} file(s)`);
      const notice = revertNotice(outcome.reverted);
      if (notice) this.memoryNotice = this.memoryNotice ? `${this.memoryNotice}\n${notice}` : notice;
    } catch {
      // The error text is the git CLI's and never leaves the server.
      this.log('memory: the commit failed; the changes stay in the working tree');
    }
  }

  /** The event kinds of a turn, in the names the model sees, for the machine-made commit message. */
  private eventLabel(eventIds: string[]): string {
    const kinds = eventIds.map(eventId => {
      const row = this.options.db.prepare('SELECT kind FROM loop_events WHERE event_id = ?').get(eventId) as { kind: string } | undefined;
      return (row?.kind ?? 'event').replace(/-/g, '_');
    });
    return [...new Set(kinds)].join('+');
  }

  /**
   * The nightly switch (ADR 0009): a review turn in the current session writes memories and a handoff, then a new
   * session starts from that handoff. The old session file is kept. The shown conversation is untouched.
   */
  private async runRotation(eventId: string): Promise<void> {
    const { db, sessionDirectory } = this.options;
    const session = this.session!;
    const finish = (outcome: RotationOutcome) => {
      if (outcome.result === 'failed') this.log(`thinking loop: the nightly switch failed (${outcome.reason})`);
      const waiters = this.rotationWaiters.get(eventId) ?? [];
      this.rotationWaiters.delete(eventId);
      for (const resolve of waiters) resolve(outcome);
    };
    if (session.messages.length === 0) {
      this.setEventState(eventId, 'no-reply');
      return finish({ result: 'skipped', reason: 'empty-session' });
    }
    this.rotating = true;
    const conversation = this.conversation()!;
    const rotationId = `rotation-${randomUUID()}`;
    const now = this.iso();
    db.prepare(`INSERT INTO session_rotations (rotation_id, event_id, conversation_id, from_session_id, from_session_file, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'reviewing', ?, ?)`)
      .run(rotationId, eventId, conversation.conversation_id, conversation.pi_session_id, conversation.pi_session_file, now, now);
    this.setAvatar('sleepy', 'server');

    const outcome = await (async (): Promise<RotationOutcome> => {
      const turn = await this.runTurn([eventId], 'review', rotationId);
      const setRotation = (state: string, reason?: string) => db.prepare('UPDATE session_rotations SET state = ?, reason = ?, updated_at = ? WHERE rotation_id = ?')
        .run(state, reason ?? null, this.iso(), rotationId);
      if (!turn.handoff) {
        const reason = this.closing ? 'stopped' : turn.failure ?? 'no-handoff';
        setRotation('failed', reason);
        this.setEventState(eventId, 'failed', reason);
        return { result: 'failed', reason };
      }
      setRotation('switching');
      if (this.closing) {
        // The handoff is kept; the next start finishes this switch.
        this.setEventState(eventId, 'failed', 'stopped');
        return { result: 'failed', reason: 'stopped' };
      }
      let created: AgentSession | undefined;
      try {
        created = await createPersistedPiSession(await this.sessionOptions(turn.handoff));
        this.commitSwitch({ rotation_id: rotationId, conversation_id: conversation.conversation_id, handoff: turn.handoff }, created);
      } catch {
        created?.dispose();
        setRotation('failed', 'session-create-failed');
        this.setEventState(eventId, 'failed', 'session-create-failed');
        return { result: 'failed', reason: 'session-create-failed' };
      }
      this.attach(created);
      session.dispose();
      this.compactionRetryAbove = undefined;
      this.setEventState(eventId, 'no-reply');
      this.log(`thinking loop: switched to a new session (the old one is kept as ${relative(sessionDirectory, session.sessionFile!)})`);
      return { result: 'switched' };
    })();
    this.rotating = false;
    if (this.avatar.by === 'server' && this.avatar.expression === 'sleepy') this.setAvatar(this.queue.length > 0 ? 'thinking' : 'neutral', 'server');
    finish(outcome);
  }

  /** Points the conversation at the new session and marks the switch done, together. */
  private commitSwitch(rotation: Pick<RotationRow, 'rotation_id' | 'conversation_id' | 'handoff'>, created: AgentSession) {
    const { db, sessionDirectory } = this.options;
    const file = relative(sessionDirectory, created.sessionFile!);
    this.transaction(() => {
      db.prepare('UPDATE conversations SET pi_session_id = ?, pi_session_file = ? WHERE conversation_id = ?')
        .run(created.sessionId, file, rotation.conversation_id);
      db.prepare(`UPDATE session_rotations SET state = 'switched', handoff = ?, to_session_id = ?, to_session_file = ?, reason = NULL, updated_at = ?
        WHERE rotation_id = ?`).run(rotation.handoff, created.sessionId, file, this.iso(), rotation.rotation_id);
    });
  }

  /** Between turns: compacts a session past its limit, so compaction never cuts into a turn (ADR 0009). */
  private async maintain() {
    const session = this.session;
    if (this.closing || !session) return;
    const tokens = session.getContextUsage()?.tokens;
    const limit = this.options.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS;
    if (tokens === undefined || tokens === null || tokens <= limit) return;
    if (this.compactionRetryAbove !== undefined && tokens <= this.compactionRetryAbove) return;
    try {
      await session.compact(COMPACTION_INSTRUCTIONS);
      this.compactionRetryAbove = undefined;
      this.log('thinking loop: the session was compacted');
    } catch {
      // The session is unchanged; try again once the context has grown further.
      this.compactionRetryAbove = tokens + Math.floor(limit / 10);
      this.log('thinking loop: compaction failed');
    }
  }

  /** Pi asks after every completed model call whether the turn ends here. */
  private shouldStop({ message, toolResults }: StopContext): boolean {
    const turn = this.turn;
    if (!turn) return false;
    turn.calls += 1;
    const allFinished = this.handling.size > 0 && [...this.handling.values()].every(handling => handling.finished);
    if (allFinished && toolResults.some(result => result.toolName === 'finish_event' && !result.isError)
      && this.session!.getSteeringMessages().length === 0) return true;
    if (message.stopReason === 'toolUse' && turn.calls >= turn.maxCalls) {
      turn.limited = true;
      return true;
    }
    return false;
  }

  private beginHandling(eventId: string, messageId: string | undefined) {
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
    const row = this.options.db.prepare(`SELECT e.kind, e.created_at, m.text, m.created_at AS message_at FROM loop_events e
      LEFT JOIN conversation_messages m ON m.message_id = e.message_id WHERE e.event_id = ?`).get(eventId) as
      { kind: string; created_at: string; text: string | null; message_at: string | null };
    if (row.kind === 'nightly-review') {
      return { event_id: eventId, type: 'nightly_review', received_at: row.created_at, instructions: REVIEW_INSTRUCTIONS };
    }
    const timeZone = this.options.timeZone ?? 'UTC';
    const raisedAt = Date.parse(row.created_at);
    if (row.kind === 'self-check') {
      return { event_id: eventId, type: 'self_check', received_at: row.created_at, local_time: localDateTime(raisedAt, timeZone),
        checks: this.selfChecks.carriedBy(eventId, raisedAt) };
    }
    // How many of her notices the owner has not checked, when any: read-only, so she need not send them again.
    const unacknowledged = this.readState.unacknowledgedNotificationIds().length;
    const notices = unacknowledged > 0 ? { unacknowledged_notices: unacknowledged } : {};
    if (row.kind === 'ping') {
      return { event_id: eventId, type: 'ping', received_at: row.created_at, local_time: localDateTime(raisedAt, timeZone), ...notices };
    }
    return { event_id: eventId, type: 'mac_message', received_at: row.message_at, text: row.text, ...notices };
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
      writeHandoff: (eventId, text) => this.writeHandoff(eventId, text),
      scheduleSelfCheck: (reason, when) => this.selfChecks.schedule(reason, when),
      listSelfChecks: () => this.selfChecks.list(),
      cancelSelfCheck: checkId => this.selfChecks.cancel(checkId),
      ...(this.shell ? { runShell: (command: string) => this.shell!.run(command) } : {}),
    };
  }

  private reply(eventId: string, text: string): ToolOutcome {
    const handling = this.handling.get(eventId);
    if (!handling?.messageId) {
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
    const turn = this.turn;
    if (turn?.kind === 'review') {
      return { ok: false, text: '送信していません。夜の振り返りの間は、本人に知らせを送りません。明日に伝えたいことは write_handoff_note に書いてください。' };
    }
    for (const eventId of about) {
      if (db.prepare('SELECT 1 FROM loop_events WHERE event_id = ?').get(eventId) === undefined) {
        return { ok: false, text: `送信していません。about_event_ids の ${eventId} は存在しないイベントです。` };
      }
    }
    const limits = this.options.notifyLimits ?? DEFAULT_NOTIFY_LIMITS;
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

  private writeHandoff(eventId: string, text: string): ToolOutcome {
    const turn = this.turn;
    if (turn?.kind !== 'review' || !turn.rotationId || !this.handling.has(eventId)) {
      return { ok: false, text: '書いていません。write_handoff_note は、いま処理中の夜の振り返り（nightly_review）の event_id にだけ使えます。' };
    }
    const check = checkOutgoingText(text);
    if (!check.ok) return { ok: false, text: refusalText(check).replace('送信していません', '書いていません') };
    turn.handoff = text;
    // Saved at once, so a stop after this point finishes the switch instead of losing the review.
    this.options.db.prepare('UPDATE session_rotations SET handoff = ?, updated_at = ? WHERE rotation_id = ?').run(text, this.iso(), turn.rotationId);
    return { ok: true, text: '引き継ぎのメモを保存しました。明日の新しい思考の記録は、このメモから始まります。書き直すなら、もう一度呼んでください。' };
  }

  /** A loop event without an owner message, queued but not yet handed to the queue. */
  private insertEvent(kind: 'nightly-review' | 'ping' | 'self-check'): string {
    const eventId = `event-${randomUUID()}`;
    const now = this.iso();
    this.options.db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
      VALUES (?, ?, NULL, 'queued', ?, ?)`).run(eventId, kind, now, now);
    return eventId;
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

  /**
   * The line natsumi is writing, as Pi streams it (ADR 0017). Only the thinking text is read: what a tool was
   * called with or answered is never sent. Nothing here is recorded; it is a sight of the moment for the owner's
   * own devices, and the turn's end clears it.
   */
  private watchThinking(event: AgentSessionEvent) {
    if (event.type !== 'message_update') return;
    const inner = event.assistantMessageEvent;
    if (inner.type === 'thinking_start') { this.thinking.line = ''; return; }
    if (inner.type === 'thinking_delta') {
      const newline = inner.delta.lastIndexOf('\n');
      // Only the newest line is shown; what came before it is behind her already.
      this.thinking.line = newline >= 0 ? inner.delta.slice(newline + 1) : this.thinking.line + inner.delta;
      this.publishThinking(false);
      return;
    }
    // The end of a block of thinking: the line it stopped on goes out whatever the interval says.
    if (inner.type === 'thinking_end') this.publishThinking(true);
  }

  /** Whether the owner is waiting on this turn. Only then is there a balloon to put a line in. */
  private streamsThinking(): boolean {
    if (this.options.thinking !== 'on') return false;
    if (this.turn?.kind !== 'events') return false;
    return [...this.handling.values()].some(handling => handling.messageId !== undefined);
  }

  private publishThinking(force: boolean) {
    if (!this.streamsThinking()) return;
    const line = thinkingLine(this.thinking.line);
    // An empty line is the space between two lines, not the end of the thinking: the one before it stays up.
    if (line === '' || line === this.thinking.sent) return;
    const now = this.now();
    if (!force && now - this.thinking.at < THINKING_MIN_INTERVAL_MS) return;
    this.thinking.sent = line;
    this.thinking.at = now;
    this.emit('conversation.thinking', { line }, true);
  }

  /** Says the thinking is over, so the Mac goes back to the blinking dots without waiting for anything else. */
  private endThinking() {
    this.thinking.line = '';
    if (this.thinking.sent === '') return;
    this.thinking.sent = '';
    this.thinking.at = this.now();
    this.emit('conversation.thinking', { line: '' }, true);
  }

  private setAvatar(expression: Expression, by: 'server' | 'model') {
    this.avatar = { expression, by, changedAt: this.now() };
    this.emit('avatar.expression', { expression });
  }

  private emit(type: string, payload: object, ephemeral = false) {
    for (const listener of this.listeners) {
      try {
        listener({ type, payload: payload as Record<string, unknown>, ...(ephemeral ? { ephemeral } : {}) });
      } catch { /* one listener cannot stop the others */ }
    }
  }
}

/**
 * One line of thinking as the Mac is given it: trimmed, and cut to `THINKING_LINE_MAX_CHARS`. A line that has grown
 * past the limit keeps its newest end, because that is where she is writing.
 */
export function thinkingLine(raw: string): string {
  const trimmed = raw.trim();
  const characters = [...trimmed];
  if (characters.length <= THINKING_LINE_MAX_CHARS) return trimmed;
  return `…${characters.slice(-(THINKING_LINE_MAX_CHARS - 1)).join('')}`;
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
