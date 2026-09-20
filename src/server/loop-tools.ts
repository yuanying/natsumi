import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { CANCEL_SELF_CHECK_DESCRIPTION, FINISH_EVENT_DESCRIPTION, LIST_SELF_CHECKS_DESCRIPTION,
  NOTIFY_OWNER_DESCRIPTION, REPLY_TO_MAC_DESCRIPTION, RUN_SHELL_DESCRIPTION, SCHEDULE_SELF_CHECK_DESCRIPTION,
  SET_MAC_AVATAR_EXPRESSION_DESCRIPTION, WRITE_CHANGE_NOTE_DESCRIPTION,
  WRITE_HANDOFF_NOTE_DESCRIPTION } from './prompts.ts';

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
  writeChangeNote(eventId: string, text: string): Outcome;
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
  'write_handoff_note', 'write_change_note', 'schedule_self_check', 'list_self_checks', 'cancel_self_check'];
/** Added to the allowlist with a runner: the whole of natsumi's workspace, memory included (ADR 0019). */
export const RUN_SHELL_TOOL_NAME = 'run_shell';

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
      description: REPLY_TO_MAC_DESCRIPTION,
      parameters: Type.Object({ event_id: Type.String(), text: Type.String() }),
      execute: async (_id, params) => result(host.reply(params.event_id, params.text)),
    }),
    defineTool({
      name: 'notify_owner', label: 'Notify the owner',
      description: NOTIFY_OWNER_DESCRIPTION,
      parameters: Type.Object({ text: Type.String(), about_event_ids: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, params) => result(host.notify(params.text, params.about_event_ids ?? [])),
    }),
    defineTool({
      name: 'finish_event', label: 'Finish an event',
      description: FINISH_EVENT_DESCRIPTION,
      parameters: Type.Object({ event_id: Type.String() }),
      execute: async (_id, params) => result(host.finish(params.event_id)),
    }),
    defineTool({
      name: 'set_mac_avatar_expression', label: 'Set the avatar expression',
      description: SET_MAC_AVATAR_EXPRESSION_DESCRIPTION(EXPRESSIONS),
      parameters: Type.Object({ expression: Type.Union(EXPRESSIONS.map(expression => Type.Literal(expression))) }),
      execute: async (_id, params) => result(host.setExpression(params.expression as Expression)),
    }),
    defineTool({
      name: 'write_handoff_note', label: 'Write the handoff note',
      description: WRITE_HANDOFF_NOTE_DESCRIPTION,
      parameters: Type.Object({ event_id: Type.String(), text: Type.String() }),
      execute: async (_id, params) => result(host.writeHandoff(params.event_id, params.text)),
    }),
    defineTool({
      name: 'write_change_note', label: 'Write the change note',
      description: WRITE_CHANGE_NOTE_DESCRIPTION,
      parameters: Type.Object({ event_id: Type.String(), text: Type.String() }),
      execute: async (_id, params) => result(host.writeChangeNote(params.event_id, params.text)),
    }),
    defineTool({
      name: 'schedule_self_check', label: 'Book a self-check',
      description: SCHEDULE_SELF_CHECK_DESCRIPTION,
      parameters: Type.Object({ reason: Type.String(), in_minutes: Type.Optional(Type.Number()), at: Type.Optional(Type.String()) }),
      execute: async (_id, params) => result(host.scheduleSelfCheck(params.reason, {
        ...(params.in_minutes === undefined ? {} : { inMinutes: params.in_minutes }), ...(params.at === undefined ? {} : { at: params.at }),
      })),
    }),
    defineTool({
      name: 'list_self_checks', label: 'List self-checks',
      description: LIST_SELF_CHECKS_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async () => result(host.listSelfChecks()),
    }),
    defineTool({
      name: 'cancel_self_check', label: 'Cancel a self-check',
      description: CANCEL_SELF_CHECK_DESCRIPTION,
      parameters: Type.Object({ check_id: Type.String() }),
      execute: async (_id, params) => result(host.cancelSelfCheck(params.check_id)),
    }),
  ];
}
