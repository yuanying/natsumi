import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}

export type Command =
  | { command: 'serve'; config: string; dataDir: string | undefined }
  | { command: 'health'; dataDir: string | undefined };

export const USAGE = `usage: natsumi serve [--config <file>] [--data-dir <dir>]
       natsumi health [--data-dir <dir>]`;

export function parseCli(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command !== 'serve' && command !== 'health') throw new UsageError(USAGE);
  const options: ParseArgsOptionsConfig = { 'data-dir': { type: 'string' } };
  if (command === 'serve') options.config = { type: 'string' };
  let values: { config?: string; 'data-dir'?: string };
  try {
    ({ values } = parseArgs({ args: rest, options, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : error}\n${USAGE}`);
  }
  const dataDir = values['data-dir'];
  return command === 'serve' ? { command, config: values.config ?? 'config.local.json', dataDir } : { command, dataDir };
}
