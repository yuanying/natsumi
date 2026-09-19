import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { MAX_COMMAND_CHARS, MEMORY_SHELL_COMMANDS } from './memory-shell.ts';
import { DEFAULT_FILE_MAX_CHARS } from './memory-repository.ts';

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
  writeHandoff(eventId: string, text: string): Outcome;
  scheduleSelfCheck(reason: string, when: { inMinutes?: number; at?: string }): Outcome;
  listSelfChecks(): Outcome;
  cancelSelfCheck(checkId: string): Outcome;
  /** Present only when the tools container's runner is configured (ADR 0011). */
  runMemoryShell?(command: string): Outcome;
}

/**
 * The allowlist given to Pi (ADR 0004, ADR 0008, ADR 0014, ADR 0018). Pi's own read/bash/edit/write stay disabled,
 * and memory has no tool of its own: it is read and written only with the shell below.
 */
export const LOOP_TOOL_NAMES = ['reply_to_mac', 'notify_owner', 'finish_event', 'set_mac_avatar_expression',
  'write_handoff_note', 'schedule_self_check', 'list_self_checks', 'cancel_self_check'];
/** Added to the allowlist with a runner: a shell confined to the memory repository in its own container (ADR 0011). */
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
      name: MEMORY_SHELL_TOOL_NAME, label: 'Read and write memory with a shell',
      description: '長期記憶を shell のコマンドで読み書きする。記憶の置き場を作業ディレクトリにして sh -c で 1 コマンドずつ動く。'
        + `使えるコマンドは ${MEMORY_SHELL_COMMANDS.join('、')} だけ。ネットワークはない。`
        + '読むとき: rg で探し、cat で読み、ls や find で見渡す。'
        + '書くとき: sh のリダイレクト（> で書き直し、>> で追記）、sed -i で部分の書き換え、mkdir・mv・cp・rm でファイルとフォルダの整理ができる。'
        + 'ファイルの名前、見出し、トピックの分け方、フォルダの作り方は自由。置けるのは .md のファイルとフォルダだけ。'
        + 'always.md（常時記憶）と personality.md（性格・話し方）は、夜の振り返り（nightly_review）のターンでだけ書き換えられる。'
        + 'ターンの終わりに、変えたファイルをサーバーが検査して git にコミットする。検査に当たったファイルは直前のコミットの状態に戻り'
        + '（新しく作ったものは消え）、理由が次のターンで伝わる。ターンの途中ではコミットされない。'
        + `1 コマンドは ${MAX_COMMAND_CHARS} 文字まで、1 ファイルは既定で ${DEFAULT_FILE_MAX_CHARS} 文字までで、時間と出力の大きさにも上限があり、超えると打ち切られる。`
        + '例: rg -n 鍵 / cat 合言葉.md / ls / cat > 予定.md <<EOF ... EOF / sed -i "/古い行/d" 予定.md',
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
