import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

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
  /** Present only when the workspace container's runner is configured (ADR 0019). */
  runShell?(command: string): Outcome;
}

/**
 * The allowlist given to Pi (ADR 0004, ADR 0008, ADR 0009, ADR 0014). Pi's own read/bash/edit/write stay disabled:
 * the only shell is `run_shell`, and it runs in the workspace container, never here.
 */
export const LOOP_TOOL_NAMES = ['reply_to_mac', 'notify_owner', 'finish_event', 'set_mac_avatar_expression',
  'write_handoff_note', 'schedule_self_check', 'list_self_checks', 'cancel_self_check'];
/** Added to the allowlist with a runner: the whole of natsumi's workspace, memory included (ADR 0019). */
export const RUN_SHELL_TOOL_NAME = 'run_shell';

/**
 * One fixed string, and the reason it is one: the backend prefills slowly, so the tool definitions have to sit on the
 * prefix cache for the life of a session (ADR 0019). Nothing here is built from a setting or from what the image
 * holds, because either would move the prefix whenever a deployment changed. The one number written out is the
 * command length, which is a decision rather than a deployment's choice, and which the server refuses before the
 * command is sent: a command that is too long would otherwise cost a whole turn. Every limit that an environment can
 * change is named without its number, and the number arrives in the result when she meets it.
 */
export const RUN_SHELL_DESCRIPTION = 'あなたの作業環境でコマンドを動かす。ネットワークの無い Debian の環境で、コマンドは bash -c で動く。'
  + '作業ディレクトリは /work。\n'
  + '書ける場所:\n'
  + '- /memory: 記憶。残る。ターンの終わりにサーバーが検査してコミットする。覚えておきたいことはここに書く。\n'
  + '- /work: 手を動かす場所。残るが、検査もコミットもされない。中間ファイル、下書き、集計の途中、自分で書くスクリプトはここ。\n'
  + '- /home/natsumi: あなたのホーム。残る。shell の履歴や自分で用意した道具を置ける。検査もコミットもされない。\n'
  + '- /tmp: 一時。コンテナが再起動すると消える。\n'
  + '記憶として残したいものは必ず /memory に書く。/work と /home/natsumi は本人からも見えず、git の履歴にも残らない。\n'
  + '/memory の .git は読み取り専用。git log や git diff で「いつこう書いたか」を読めるが、コミットするのはサーバー。\n'
  + '長い処理はそのまま残せる。応答の上限までに終わらなければ、そこまでの出力と「まだ動いている」印が返り、'
  + 'プロセスは止まらずに動き続ける。その後の出力は読み捨てられるので、残したいときは /work のファイルへリダイレクトする。'
  + '残ったプロセスは ps で見て、要らなくなったら kill する。\n'
  + 'コマンドの長さは 8000 文字まで。超えると実行されずに返るので、長いものは /work にファイルとして書いて bash で動かす。\n'
  + '時間と出力の大きさにも上限がある。当たったときは結果の文で知らせる。';

async function result(outcome: Outcome) {
  const settled = await outcome;
  // A thrown error becomes an error tool result carrying this sentence.
  if (!settled.ok) throw new Error(settled.text);
  return { content: [{ type: 'text' as const, text: settled.text }], details: {}, ...(settled.closesTurn ? { terminate: true } : {}) };
}

export function createLoopTools(host: LoopToolHost) {
  const shell = host.runShell?.bind(host);
  return [
    ...(shell ? [defineTool({
      name: RUN_SHELL_TOOL_NAME, label: 'Work in the workspace',
      description: RUN_SHELL_DESCRIPTION,
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
