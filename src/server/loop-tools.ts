import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

/** The avatar expressions the Mac can show. The model picks from these only. */
export const EXPRESSIONS = ['neutral', 'happy', 'laughing', 'surprised', 'thinking', 'worried', 'sad', 'sleepy'] as const;
export type Expression = typeof EXPRESSIONS[number];

/** A tool call's effect as a sentence the model reads. `ok: false` means nothing was sent or changed. */
export interface ToolOutcome { ok: boolean; text: string; closesTurn?: boolean }

/** What the tools act on. Every check happens here, on the server, not in the tool description. */
export interface LoopToolHost {
  reply(eventId: string, text: string): ToolOutcome;
  notify(text: string, about: string[]): ToolOutcome;
  finish(eventId: string): ToolOutcome;
  setExpression(expression: Expression): ToolOutcome;
}

/** The whole allowlist given to Pi (ADR 0004, ADR 0008). Pi's own read/bash/edit/write stay disabled. */
export const LOOP_TOOL_NAMES = ['reply_to_mac', 'notify_owner', 'finish_event', 'set_mac_avatar_expression'];

function result(outcome: ToolOutcome) {
  // A thrown error becomes an error tool result carrying this sentence.
  if (!outcome.ok) throw new Error(outcome.text);
  return { content: [{ type: 'text' as const, text: outcome.text }], details: {}, ...(outcome.closesTurn ? { terminate: true } : {}) };
}

export function createLoopTools(host: LoopToolHost) {
  return [
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
  ];
}
