import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPATIBLE_KEY_ENV } from './auth.ts';

export function runChild(worker: URL, args: string[], root: string, timeout = 150_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, 'pi'),
      PI_OFFLINE: '1', LANG: 'C.UTF-8' };
    // Only the explicitly named compatible-endpoint key crosses; other provider keys are never inherited.
    if (process.env[COMPATIBLE_KEY_ENV]) env[COMPATIBLE_KEY_ENV] = process.env[COMPATIBLE_KEY_ENV];
    const child = fork(worker, args, { cwd: root, execArgv: [], silent: true, env });
    let result: unknown;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout?.resume(); child.stderr?.resume(); // Never print upstream payloads or credentials.
    child.on('message', value => { result = value; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Pi worker failed to start')); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Pi worker timeout'));
      else if (code !== 0 || !result) reject(new Error('Pi worker failed'));
      else resolve(result);
    });
  });
}

function round(value: unknown): { sessionId: string; sessionFile: string; entryIds: string[] } {
  if (!value || typeof value !== 'object') throw new Error('Invalid Pi worker result');
  const result = value as Record<string, unknown>;
  if (typeof result.sessionId !== 'string' || typeof result.sessionFile !== 'string' ||
      !Array.isArray(result.entryIds) || !result.entryIds.every(x => typeof x === 'string')) throw new Error('Invalid Pi worker result');
  return result as ReturnType<typeof round>;
}

/** Worker argv: root, route JSON (no secrets), session file or '', operation. */
export async function exerciseRestart(worker: URL, route: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-pi-probe-'));
  try {
    const first = round(await runChild(worker, [root, route, '', 'round'], root));
    const second = round(await runChild(worker, [root, route, first.sessionFile, 'round'], root));
    if (first.sessionId !== second.sessionId || first.sessionFile !== second.sessionFile ||
        first.entryIds.length < 2 || second.entryIds.length <= first.entryIds.length ||
        !first.entryIds.every((id, i) => id === second.entryIds[i])) throw new Error('Pi restart history mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
}

export const TOOL_OUTCOMES = ['proposal-pending-approval', 'unregistered-tool-refused', 'not-called'] as const;

export async function exerciseTool(worker: URL, route: string): Promise<(typeof TOOL_OUTCOMES)[number]> {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-pi-probe-'));
  try {
    const outcome = await runChild(worker, [root, route, '', 'tool'], root);
    if (!TOOL_OUTCOMES.includes(outcome as never)) throw new Error('Invalid Pi worker result');
    return outcome as (typeof TOOL_OUTCOMES)[number];
  } finally { await rm(root, { recursive: true, force: true }); }
}
