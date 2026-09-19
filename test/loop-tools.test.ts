import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoopTools, LOOP_TOOL_NAMES, RUN_SHELL_TOOL_NAME, type LoopToolHost } from '../src/server/loop-tools.ts';
import { RUN_SHELL_DESCRIPTION } from '../src/server/prompts.ts';
import { MAX_COMMAND_CHARS } from '../src/server/workspace-shell.ts';

const ok = (text: string) => ({ ok: true, text });

function host(overrides: Partial<LoopToolHost> = {}): LoopToolHost {
  return {
    reply: () => ok('replied'),
    notify: () => ok('notified'),
    finish: () => ok('finished'),
    setExpression: () => ok('expression'),
    writeHandoff: () => ok('handoff'),
    scheduleSelfCheck: () => ok('scheduled'),
    listSelfChecks: () => ok('listed'),
    cancelSelfCheck: () => ok('cancelled'),
    ...overrides,
  };
}

const names = (h: LoopToolHost) => createLoopTools(h).map(tool => tool.name);

// ADR 0018 and ADR 0019: the shell is the only way to memory. The named memory tools are gone, not deprecated.
test('run_shell is registered with a runner, and the old memory tools are registered by nobody', () => {
  const withShell = names(host({ runShell: () => ok('ran') }));
  assert.ok(withShell.includes(RUN_SHELL_TOOL_NAME));
  assert.equal(RUN_SHELL_TOOL_NAME, 'run_shell');
  assert.equal(names(host()).includes(RUN_SHELL_TOOL_NAME), false);
  for (const gone of ['remember', 'recall', 'read_memory', 'forget', 'run_memory_shell']) {
    assert.equal(withShell.includes(gone), false, gone);
    assert.equal(LOOP_TOOL_NAMES.includes(gone), false, gone);
  }
  // Everything else is as ADR 0008 left it.
  assert.deepEqual([...LOOP_TOOL_NAMES].sort(), ['cancel_self_check', 'finish_event', 'list_self_checks', 'notify_owner',
    'reply_to_mac', 'schedule_self_check', 'set_mac_avatar_expression', 'write_handoff_note']);
});

/**
 * The backend prefills slowly, so the tool definitions must sit on the prefix cache: the description is one fixed
 * string, never built from a setting or from what the image happens to hold (ADR 0019).
 */
test('the run_shell description is a fixed string, not built from settings or from the image', () => {
  const first = createLoopTools(host({ runShell: () => ok('a') })).find(tool => tool.name === RUN_SHELL_TOOL_NAME);
  const second = createLoopTools(host({ runShell: () => ok('b') })).find(tool => tool.name === RUN_SHELL_TOOL_NAME);
  assert.equal(first!.description, RUN_SHELL_DESCRIPTION);
  assert.equal(second!.description, RUN_SHELL_DESCRIPTION);

  // The only number in it is the one limit that does not change with the deployment, and it is the real one.
  assert.deepEqual([...RUN_SHELL_DESCRIPTION.matchAll(/\d+/g)].map(match => match[0]), [String(MAX_COMMAND_CHARS)]);
  assert.equal(MAX_COMMAND_CHARS, 8000);
});

test('the run_shell description says where writing lands and how a long command is left running', () => {
  for (const phrase of ['bash -c', '/memory', '/work', '/home/natsumi', 'ps', 'kill', '8000']) {
    assert.ok(RUN_SHELL_DESCRIPTION.includes(phrase), phrase);
  }
  // Which commands the image holds is not promised: that list is what ADR 0019 did away with.
  for (const listed of ['ripgrep', 'coreutils', 'findutils', 'gawk', 'tzdata']) {
    assert.equal(RUN_SHELL_DESCRIPTION.includes(listed), false, listed);
  }
});

test('run_shell hands the command to the host and carries its sentence back', async () => {
  const commands: string[] = [];
  const tool = createLoopTools(host({ runShell: (command: string) => { commands.push(command); return ok('動きました'); } }))
    .find(t => t.name === RUN_SHELL_TOOL_NAME)!;
  const result = await tool.execute('call-1', { command: 'rg -n 合言葉 /memory' } as never, undefined, undefined, {} as never);
  assert.deepEqual(commands, ['rg -n 合言葉 /memory']);
  assert.equal((result.content[0] as { text: string }).text, '動きました');
});
