import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import type { ModelCommand } from './model-routes.ts';

export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}

export type Command =
  | { command: 'serve'; config: string; dataDir: string | undefined }
  | { command: 'health'; dataDir: string | undefined }
  | ModelCommand;

export const USAGE = `usage: natsumi serve [--config <file>] [--data-dir <dir>]
       natsumi health [--data-dir <dir>]
       natsumi model list|status [--data-dir <dir>]
       natsumi model use <route> [--data-dir <dir>]`;

export function parseCli(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command !== 'serve' && command !== 'health' && command !== 'model') throw new UsageError(USAGE);
  const options: ParseArgsOptionsConfig = { 'data-dir': { type: 'string' } };
  if (command === 'serve') options.config = { type: 'string' };
  let values: { config?: string; 'data-dir'?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: rest, options, strict: true, allowPositionals: command === 'model' }));
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : error}\n${USAGE}`);
  }
  const dataDir = values['data-dir'];
  if (command === 'model') {
    const [action, ...names] = positionals;
    if ((action === 'list' || action === 'status') && names.length === 0) return { command, action, dataDir };
    if (action === 'use' && names.length === 1) return { command, action, route: names[0]!, dataDir };
    throw new UsageError(USAGE);
  }
  return command === 'serve' ? { command, config: values.config ?? 'config.local.json', dataDir } : { command, dataDir };
}
