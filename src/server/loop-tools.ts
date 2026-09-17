import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { MEMORY_SHELL_COMMANDS } from './memory-shell.ts';

/** The avatar expressions the Mac can show. The model picks from these only. */
export const EXPRESSIONS = ['neutral', 'happy', 'laughing', 'surprised', 'thinking', 'worried', 'sad', 'sleepy'] as const;
export type Expression = typeof EXPRESSIONS[number];

/** A tool call's effect as a sentence the model reads. `ok: false` means nothing was sent or changed. */
export interface ToolOutcome { ok: boolean; text: string; closesTurn?: boolean }

type Outcome = ToolOutcome | Promise<ToolOutcome>;

/** What the tools act on. Every check happens here, on the server, not in the tool description. */
export interface LoopToolHost {
  reply(eventId: string, text: string): Outcome;
  notify(text: string, about: string[]): Outcome;
  finish(eventId: string): Outcome;
  setExpression(expression: Expression): Outcome;
  remember(topic: string, note: string): Outcome;
  recall(query: string): Outcome;
  readMemory(topic: string): Outcome;
  forget(topic: string, text: string): Outcome;
  writeHandoff(eventId: string, text: string): Outcome;
  scheduleSelfCheck(reason: string, when: { inMinutes?: number; at?: string }): Outcome;
  listSelfChecks(): Outcome;
  cancelSelfCheck(checkId: string): Outcome;
  /** Present only when the tools container's runner is configured (ADR 0011). */
  runMemoryShell?(command: string): Outcome;
}

/**
 * The allowlist given to Pi (ADR 0004, ADR 0008, ADR 0009, ADR 0014). Pi's own read/bash/edit/write stay disabled:
 * the memory tools reach only `memory/`, through names the server turns into paths.
 */
export const LOOP_TOOL_NAMES = ['reply_to_mac', 'notify_owner', 'finish_event', 'set_mac_avatar_expression',
  'remember', 'recall', 'read_memory', 'forget', 'write_handoff_note', 'schedule_self_check', 'list_self_checks', 'cancel_self_check'];
/** Added to the allowlist with a runner: a shell confined to a read-only copy of `memory/` in its own container (ADR 0011). */
export const MEMORY_SHELL_TOOL_NAME = 'run_memory_shell';

async function result(outcome: Outcome) {
  const settled = await outcome;
  // A thrown error becomes an error tool result carrying this sentence.
  if (!settled.ok) throw new Error(settled.text);
  return { content: [{ type: 'text' as const, text: settled.text }], details: {}, ...(settled.closesTurn ? { terminate: true } : {}) };
}

export function createLoopTools(host: LoopToolHost) {
  const shell = host.runMemoryShell?.bind(host);
  return [
    ...(shell ? [defineTool({
      name: MEMORY_SHELL_TOOL_NAME, label: 'Search memory with a shell',
      description: '長期記憶のファイル（1 トピック 1 つの Markdown）を shell のコマンドで探す。recall で見つからないとき、'
        + '正規表現・ファイルの一覧・件数で調べたいときに使う。コマンドは記憶のディレクトリを作業ディレクトリにして sh -c で動く。'
        + `使えるコマンドは ${MEMORY_SHELL_COMMANDS.join('、')} だけ。記憶は読み取り専用で、ネットワークはない。`
        + '記憶を書き換えるときは remember と forget を使う。時間と出力の大きさに上限があり、超えると打ち切られる。'
        + '例: rg -n 鍵 / rg -l 誕生日 / ls / wc -l *.md',
      parameters: Type.Object({ command: Type.String() }),
      execute: async (_id, params) => result(shell(params.command)),
    })] : []),
    defineTool({
      name: 'reply_to_mac', label: 'Reply to the owner',
      description: '本人のメッセージ（mac_message）に返事を送り、本人の Mac に表示する。1 つのメッセージに送れる返事は 1 回だけ。'
        + 'event_id には返事の対象の mac_message の event_id を入れる。本文は日本語で書く。',
      parameters: Type.Object({ event_id: Type.String(), text: Type.String() }),
      execute: async (_id, params) => result(host.reply(params.event_id, params.text)),
    }),
    defineTool({
      name: 'notify_owner', label: 'Notify the owner',
      description: '返事とは別に、本人に相談や知らせを送る。about_event_ids には関係するイベントの event_id を任意で入れる。'
        + '何もしなかったことや内心は送らない。送れる回数には上限がある。',
      parameters: Type.Object({ text: Type.String(), about_event_ids: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, params) => result(host.notify(params.text, params.about_event_ids ?? [])),
    }),
    defineTool({
      name: 'finish_event', label: 'Finish an event',
      description: '届いたイベントへの対応を終える。返事や表情などの出力を済ませた後、何もしないと決めたときも、必ず最後に呼ぶ。',
      parameters: Type.Object({ event_id: Type.String() }),
      execute: async (_id, params) => result(host.finish(params.event_id)),
    }),
    defineTool({
      name: 'set_mac_avatar_expression', label: 'Set the avatar expression',
      description: `本人の Mac のデスクトップにいるあなたのアバターの表情を変える。候補: ${EXPRESSIONS.join(', ')}。`,
      parameters: Type.Object({ expression: Type.Union(EXPRESSIONS.map(expression => Type.Literal(expression))) }),
      execute: async (_id, params) => result(host.setExpression(params.expression as Expression)),
    }),
    defineTool({
      name: 'remember', label: 'Remember',
      description: '長期記憶に 1 件書く。本人に「覚えておいて」と言われたこと、本人について今後も役立つこと、本人との約束を残す。'
        + 'topic は「家族」「仕事の予定」のような短いトピック名で、同じトピックは 1 つのファイルにまとまる。note は 1 件の記憶を 1 文で書く。',
      parameters: Type.Object({ topic: Type.String(), note: Type.String() }),
      execute: async (_id, params) => result(host.remember(params.topic, params.note)),
    }),
    defineTool({
      name: 'recall', label: 'Recall',
      description: '長期記憶を言葉で探す。空白で区切った言葉のどれかを含む記憶の行と、トピックの一覧が返る。'
        + '記憶はいつも見えているわけではないので、本人のことや以前の約束が関係しそうなときはまず探す。',
      parameters: Type.Object({ query: Type.String() }),
      execute: async (_id, params) => result(host.recall(params.query)),
    }),
    defineTool({
      name: 'read_memory', label: 'Read a memory topic',
      description: '長期記憶の 1 つのトピックを全部読む。topic には recall で分かったトピック名を入れる。',
      parameters: Type.Object({ topic: Type.String() }),
      execute: async (_id, params) => result(host.readMemory(params.topic)),
    }),
    defineTool({
      name: 'forget', label: 'Forget',
      description: '長期記憶のトピックから、text を含む記憶の行を消す。本人に忘れてと言われたときや、記憶が古くなったときに使う。'
        + '直すときは、古い行を forget してから remember で書き直す。',
      parameters: Type.Object({ topic: Type.String(), text: Type.String() }),
      execute: async (_id, params) => result(host.forget(params.topic, params.text)),
    }),
    defineTool({
      name: 'write_handoff_note', label: 'Write the handoff note',
      description: '夜の振り返り（nightly_review）でだけ使う。明日の新しい思考の記録に引き継ぐメモを書く。何度か呼ぶと最後のものが使われる。',
      parameters: Type.Object({ event_id: Type.String(), text: Type.String() }),
      execute: async (_id, params) => result(host.writeHandoff(params.event_id, params.text)),
    }),
    defineTool({
      name: 'schedule_self_check', label: 'Book a self-check',
      description: '後で自分からもう一度確かめるための予約をする。時刻が来ると、reason を添えた self_check のイベントが届く。'
        + 'in_minutes（今から何分後か）と at（本人のタイムゾーンの "HH:MM" か "YYYY-MM-DD HH:MM"）のどちらか一方だけを指定する。'
        + '近すぎる先・遠すぎる先・件数には上限があり、同じ理由の予約は 1 件にまとまる。夜に来た予約は朝に届く。',
      parameters: Type.Object({ reason: Type.String(), in_minutes: Type.Optional(Type.Number()), at: Type.Optional(Type.String()) }),
      execute: async (_id, params) => result(host.scheduleSelfCheck(params.reason, {
        ...(params.in_minutes === undefined ? {} : { inMinutes: params.in_minutes }), ...(params.at === undefined ? {} : { at: params.at }),
      })),
    }),
    defineTool({
      name: 'list_self_checks', label: 'List self-checks',
      description: 'まだ届いていない自分の予約（schedule_self_check）を、check_id・時刻・理由で一覧する。',
      parameters: Type.Object({}),
      execute: async () => result(host.listSelfChecks()),
    }),
    defineTool({
      name: 'cancel_self_check', label: 'Cancel a self-check',
      description: 'まだ届いていない自分の予約を、check_id を指定して取り消す。',
      parameters: Type.Object({ check_id: Type.String() }),
      execute: async (_id, params) => result(host.cancelSelfCheck(params.check_id)),
    }),
  ];
}
