import type { DatabaseSync } from 'node:sqlite';
import { A2ACallError, type A2AClient, type AgentTaskState, type SendResult } from './a2a-client.ts';
import type { A2AConfig } from './config.ts';
import type { Transaction } from './conversation-store.ts';
import type { ToolOutcome } from './loop-tools.ts';
import { isoAt } from './nightly.ts';
import { checkOutgoingText, refusalText } from './output-checks.ts';

/** The longest answer an event carries. A longer one is cut, and the event says so. */
export const MAX_AGENT_REPLY_CHARS = 8000;

/** Where natsumi reads who she can ask (ADR 0036). Named in refusals, never built from the config. */
export const AGENT_LIST_PATH = '/manual/agents/INDEX.md';

/** How an exchange ended, as the event names it. */
type ReplyStatus = 'completed' | 'failed' | 'input-required' | 'gave-up';

interface TaskRow { agent: string; task_id: string; context_id: string; state: string; sent_at: string }
interface ContextRow { agent: string; context_id: string; task_id: string | null }

/**
 * Hands the loop an agent's answer as a new event. The caller writes its own rows inside the same transaction as the
 * event, so an answer is never recorded without the event that carries it, or the other way round.
 */
export type RaiseAgentReply = (record: (eventId: string, transaction: Transaction) => void) => void;

export interface AgentRequestsOptions {
  db: DatabaseSync;
  now: () => number;
  /** Without it every ask is refused, and the tool is still there (ADR 0036). */
  config: A2AConfig | undefined;
  client: A2AClient | undefined;
  raise: RaiseAgentReply;
  log?: (line: string) => void;
}

/**
 * What natsumi asks outside agents, and what they answer (ADR 0035, ADR 0036). `ask` sends and says only that the
 * request was taken; `poll` fetches the waiting tasks and turns each settled one into an `agent-reply` event.
 *
 * The IDs stay here. natsumi names an agent and says whether she is going on with the last exchange; the context
 * and the task that means are this class's to know, and the event she reads names neither (ADR 0024).
 *
 * The log carries agent names and kinds of failure only, never what was asked or answered.
 */
export class AgentRequests {
  private readonly options: AgentRequestsOptions;
  private readonly db: DatabaseSync;
  private polling: Promise<void> | undefined;
  private closed = false;
  /** Agents whose last fetch failed, so an outage is logged when it starts and when it ends rather than every round. */
  private readonly failing = new Set<string>();

  constructor(options: AgentRequestsOptions) {
    this.options = options;
    this.db = options.db;
  }

  /** Stops writing: a fetch still on its way when the loop closes lands on a database that is going away. */
  close(): void { this.closed = true; }

  async ask(agent: string, message: string, goOn: boolean): Promise<ToolOutcome> {
    const refuse = (text: string): ToolOutcome => ({ ok: false, text: `頼んでいません。${text}` });
    const { config, client } = this.options;
    if (!config || !client) return refuse('外のエージェントに頼む設定がありません。');
    const target = config.agents[agent];
    if (!target) return refuse(`「${agent}」という相手はいません。頼める相手と名前は ${AGENT_LIST_PATH} にあります。`);
    const check = checkOutgoingText(message);
    if (!check.ok) return { ok: false, text: refusalText(check).replace('送信していません', '頼んでいません') };

    let to: { contextId?: string; taskId?: string } = {};
    if (goOn) {
      const last = this.lastContext(agent);
      if (!last) return refuse(`「${agent}」との続けられるやり取りがありません。新しく頼むなら continue を false にしてください。`);
      const task = last.task_id ? this.task(agent, last.task_id) : undefined;
      if (task?.state === 'waiting') {
        return refuse(`「${agent}」に前に頼んだことの返事を、まだ待っています。返事が agent_reply の出来事として届いてから続けてください。`);
      }
      to = task?.state === 'input-required' ? { contextId: last.context_id, taskId: task.task_id } : { contextId: last.context_id };
    }

    let sent: SendResult;
    try {
      sent = await client.send(target.url, { text: message, ...to });
    } catch (error) {
      const kind = error instanceof A2ACallError ? error.kind : 'unavailable';
      this.log(`a2a: sending to ${agent} failed (${kind})`);
      if (kind === 'refused' && goOn) {
        return { ok: false, text: `頼めませんでした。「${agent}」が前のやり取りに続けることを受け付けませんでした。新しく頼むなら continue を false にしてください。` };
      }
      if (kind === 'refused') return { ok: false, text: `頼めませんでした。「${agent}」が受け付けませんでした。` };
      return { ok: false, text: `頼めませんでした。「${agent}」につながりません。時間をおいてもう一度頼むか、急ぎなら本人に伝えてください。` };
    }
    if (this.closed) return { ok: false, text: '頼んだかどうか分かりません。サーバーが止まるところです。' };
    this.record(agent, sent);
    const how = to.taskId ? 'の聞き返しに答えました' : to.contextId ? 'との前のやり取りに続けて送りました' : 'に頼みました';
    return { ok: true, text: `「${agent}」${how}。返事は後で agent_reply の出来事として届きます。待たずに、ほかのことをしてかまいません。` };
  }

  /**
   * One round: every waiting task is fetched once, and each that settled becomes an event. Rounds never overlap: one
   * asked for while another runs joins it.
   */
  poll(): Promise<void> {
    this.polling ??= this.round().finally(() => { this.polling = undefined; });
    return this.polling;
  }

  /**
   * The line one `agent-reply` event becomes inside `<events>`, taken once. No ID: she answers by the agent's name.
   * The answer is emptied from its row as it goes: from here on it is in the Pi session, and the same record is not
   * kept twice (ADR 0008). An event is handed to Pi only once, so nothing ever asks for the line again.
   */
  takeEventLine(eventId: string, receivedAt: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT agent, status, text FROM agent_replies WHERE event_id = ?').get(eventId) as
      { agent: string; status: ReplyStatus; text: string } | undefined;
    if (!row) return { type: 'agent_reply', received_at: receivedAt, status: 'failed' };
    this.db.prepare(`UPDATE agent_replies SET text = '' WHERE event_id = ?`).run(eventId);
    const characters = [...row.text];
    const cut = characters.length > MAX_AGENT_REPLY_CHARS;
    return {
      type: 'agent_reply', received_at: receivedAt, agent: row.agent, status: row.status.replace('-', '_'),
      ...(row.text ? { text: cut ? characters.slice(0, MAX_AGENT_REPLY_CHARS).join('') : row.text } : {}),
      ...(cut ? { truncated: true } : {}),
    };
  }

  private async round(): Promise<void> {
    const { config, client } = this.options;
    if (!config || !client || this.closed) return;
    const limitMs = config.giveUpAfterHours * 3_600_000;
    const waiting = this.db.prepare(`SELECT agent, task_id, context_id, state, sent_at FROM agent_tasks WHERE state = 'waiting'
      ORDER BY sent_at`).all() as unknown as TaskRow[];
    for (const task of waiting) {
      if (this.closed) return;
      if (this.options.now() - Date.parse(task.sent_at) >= limitMs) {
        this.log(`a2a: gave up waiting for ${task.agent}`);
        this.settle(task, 'gave-up', '');
        continue;
      }
      const target = config.agents[task.agent];
      // An agent taken out of the config cannot be asked any more; what it was doing is lost to her.
      if (!target) { this.settle(task, 'failed', ''); continue; }
      let state: AgentTaskState;
      let text: string;
      try {
        ({ state, text } = await client.getTask(target.url, task.task_id));
      } catch (error) {
        const kind = error instanceof A2ACallError ? error.kind : 'unavailable';
        if (kind === 'not-found') {
          this.log(`a2a: ${task.agent} no longer knows a task`);
          this.settle(task, 'failed', '');
          continue;
        }
        if (!this.failing.has(task.agent)) this.log(`a2a: fetching from ${task.agent} failed (${kind}); trying again each round`);
        this.failing.add(task.agent);
        continue;
      }
      if (this.failing.delete(task.agent)) this.log(`a2a: ${task.agent} answers again`);
      if (state !== 'waiting') this.settle(task, state, text);
    }
  }

  /** A task has ended, or is asking: its state and the event that tells her are written together. */
  private settle(task: TaskRow, status: ReplyStatus, text: string): void {
    if (this.closed) return;
    this.options.raise((eventId, _transaction) => {
      const now = this.iso();
      this.db.prepare(`UPDATE agent_tasks SET state = ?, updated_at = ? WHERE agent = ? AND task_id = ?`)
        .run(status, now, task.agent, task.task_id);
      this.insertReply(eventId, task.agent, status, text);
    });
  }

  /** What a send started: the agent's latest exchange, and the task to fetch or the answer that already came. */
  private record(agent: string, sent: SendResult): void {
    const now = this.iso();
    const remember = () => {
      this.db.prepare(`INSERT INTO agent_contexts (agent, context_id, task_id, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (agent) DO UPDATE SET context_id = excluded.context_id, task_id = excluded.task_id, updated_at = excluded.updated_at`)
        .run(agent, sent.contextId, sent.kind === 'task' ? sent.taskId : null, now);
    };
    if (sent.kind === 'message') {
      this.options.raise(eventId => { remember(); this.insertReply(eventId, agent, 'completed', sent.text); });
      return;
    }
    // Whatever the send came back as, the next round reads it: a task never settles here and again there.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      remember();
      this.db.prepare(`INSERT INTO agent_tasks (agent, task_id, context_id, state, sent_at, created_at, updated_at)
        VALUES (?, ?, ?, 'waiting', ?, ?, ?)
        ON CONFLICT (agent, task_id) DO UPDATE SET state = 'waiting', sent_at = excluded.sent_at, updated_at = excluded.updated_at`)
        .run(agent, sent.taskId, sent.contextId, now, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insertReply(eventId: string, agent: string, status: ReplyStatus, text: string): void {
    this.db.prepare('INSERT INTO agent_replies (event_id, agent, status, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, agent, status, text, this.iso());
  }

  private lastContext(agent: string): ContextRow | undefined {
    return this.db.prepare('SELECT agent, context_id, task_id FROM agent_contexts WHERE agent = ?').get(agent) as ContextRow | undefined;
  }

  private task(agent: string, taskId: string): TaskRow | undefined {
    return this.db.prepare('SELECT agent, task_id, context_id, state, sent_at FROM agent_tasks WHERE agent = ? AND task_id = ?')
      .get(agent, taskId) as TaskRow | undefined;
  }

  private iso() { return isoAt(this.options.now()); }

  private log(line: string) { this.options.log?.(line); }
}
