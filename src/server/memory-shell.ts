import { createConnection } from 'node:net';
import type { ToolOutcome } from './loop-tools.ts';

/**
 * Every command the tools image installs (docker/tools-commands.txt): reading, and the ones memory is written with
 * (ADR 0018). Nothing that reaches a network, installs packages or runs an interpreter.
 */
export const MEMORY_SHELL_COMMANDS = ['sh', 'cat', 'find', 'grep', 'head', 'ls', 'rg', 'sort', 'tail', 'uniq', 'wc',
  'mkdir', 'mv', 'cp', 'rm', 'sed', 'awk'] as const;
/** One command's length. A file is rewritten in whole commands, so this is well above a single `>` redirection. */
export const MAX_COMMAND_CHARS = 8000;
/** The most stdout characters one result carries, whatever the runner sent. */
export const SHELL_OUTPUT_CHARS = 8000;
const STDERR_CHARS = 2000;
/** Longer than the runner's own time limit, so a command stopped there still comes back as an answer. */
export const DEFAULT_SHELL_TIMEOUT_MS = 20_000;
const MAX_ANSWER_BYTES = 1024 * 1024;

interface RunnerAnswer {
  exitCode: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  timeoutMs?: number;
}

type Exchange =
  | { kind: 'answer'; answer: RunnerAnswer }
  | { kind: 'refused'; error: string }
  | { kind: 'unreachable' | 'no-answer' | 'unreadable' };

export interface MemoryShellOptions {
  /** The runner's Unix socket, shared with the tools container. */
  socketPath: string;
  timeoutMs?: number;
}

const RUNNER = '記憶の shell の実行役（runner）';
const FALLBACK = 'いまは記憶を読むことも書くこともできません。';

/**
 * Runs a model's command in the tools container (ADR 0011, ADR 0018) by asking its runner over a Unix socket.
 * natsumi holds no Docker socket: the runner is the only way in. The confinement is the container's; this side
 * bounds the request, the wait and the text that goes back to the model.
 */
export class MemoryShell {
  private readonly options: MemoryShellOptions;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryShellOptions) { this.options = options; }

  /** One command at a time: Pi runs the tools of one model call concurrently. */
  run(command: string): Promise<ToolOutcome> {
    const run = this.tail.then(() => this.runNow(command), () => this.runNow(command));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async runNow(command: string): Promise<ToolOutcome> {
    if (command.trim() === '') return { ok: false, text: 'コマンドが空です。実行していません。' };
    if ([...command].length > MAX_COMMAND_CHARS) {
      return { ok: false, text: `コマンドが長すぎます（${MAX_COMMAND_CHARS} 文字まで）。実行していません。` };
    }
    if (command.includes('\u0000')) return { ok: false, text: 'コマンドに NUL 文字が含まれています。実行していません。' };
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
    const exchange = await ask(this.options.socketPath, command, timeoutMs);
    switch (exchange.kind) {
      case 'answer': return describe(exchange.answer);
      case 'refused': return { ok: false, text: `${RUNNER}がコマンドを受け付けませんでした（${exchange.error}）。` };
      case 'unreachable': return { ok: false, text: `${RUNNER}に接続できません。コマンドは実行していません。${FALLBACK}` };
      case 'no-answer': return { ok: false, text: `${RUNNER}から ${Math.round(timeoutMs / 1000)} 秒たっても応答がありません。コマンドが動いたかは分かりません。${FALLBACK}` };
      case 'unreadable': return { ok: false, text: `${RUNNER}の応答を読めませんでした。${FALLBACK}` };
    }
  }
}

function ask(socketPath: string, command: string, timeoutMs: number): Promise<Exchange> {
  return new Promise(resolve => {
    let settled = false;
    let connected = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const socket = createConnection(socketPath);
    const finish = (exchange: Exchange) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(exchange);
    };
    const timer = setTimeout(() => finish({ kind: 'no-answer' }), timeoutMs);
    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ command })}\n`);
    });
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) { finish({ kind: 'unreadable' }); return; }
      chunks.push(chunk);
      const received = Buffer.concat(chunks);
      const end = received.indexOf(0x0a);
      if (end >= 0) finish(parse(received.subarray(0, end)));
    });
    socket.on('end', () => finish(parse(Buffer.concat(chunks))));
    socket.on('error', () => finish(connected ? { kind: 'unreadable' } : { kind: 'unreachable' }));
  });
}

function parse(line: Buffer): Exchange {
  let value: unknown;
  try { value = JSON.parse(line.toString('utf8')); } catch { return { kind: 'unreadable' }; }
  if (typeof value !== 'object' || value === null) return { kind: 'unreadable' };
  const answer = value as Record<string, unknown>;
  if (typeof answer.error === 'string') return { kind: 'refused', error: answer.error.slice(0, 200) };
  const exitCode = answer.exitCode;
  if (typeof answer.stdout !== 'string' || typeof answer.stderr !== 'string' || typeof answer.timedOut !== 'boolean'
    || !(exitCode === null || typeof exitCode === 'number')) {
    return { kind: 'unreadable' };
  }
  return { kind: 'answer', answer: answer as unknown as RunnerAnswer };
}

function describe(answer: RunnerAnswer): ToolOutcome {
  const lines: string[] = [];
  let ok = true;
  if (answer.timedOut) {
    ok = false;
    const limit = typeof answer.timeoutMs === 'number' ? `（${Math.round(answer.timeoutMs / 1000)} 秒）` : '';
    lines.push(`時間の上限${limit}で打ち切りました。コマンドは最後まで動いていません。検索語やファイルを絞ってやり直せます。`);
  } else if (answer.exitCode === null) {
    ok = false;
    lines.push(`コマンドはシグナル（${answer.signal ?? '不明'}）で止まりました。プロセス数やメモリの上限に当たった可能性があります。`);
  } else {
    lines.push(`コマンドは終了コード ${answer.exitCode} で終わりました。${answer.exitCode === 1 ? 'rg と grep は、見つからないときも 1 を返します。' : ''}`);
  }
  const stdout = cut(answer.stdout, SHELL_OUTPUT_CHARS);
  lines.push(stdout.text === '' ? '標準出力は空でした。' : `標準出力:\n${stdout.text}`);
  if (stdout.cut || answer.stdoutTruncated) lines.push('（標準出力が長いので先頭だけを返しています。head、rg -m、wc -l などで絞れます）');
  const stderr = cut(answer.stderr, STDERR_CHARS);
  if (stderr.text !== '') lines.push(`標準エラー出力:\n${stderr.text}`);
  if (stderr.cut || answer.stderrTruncated) lines.push('（標準エラー出力が長いので先頭だけを返しています）');
  return { ok, text: lines.join('\n') };
}

function cut(text: string, max: number): { text: string; cut: boolean } {
  const characters = [...text];
  return characters.length > max ? { text: characters.slice(0, max).join(''), cut: true } : { text, cut: false };
}
