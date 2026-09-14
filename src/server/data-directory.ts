import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findCodeCheckout } from './paths.ts';

export class DataDirectoryError extends Error {
  constructor(message: string) { super(`data directory: ${message}`); this.name = 'DataDirectoryError'; }
}

export const STATE_DIRECTORY = '.natsumi';

const PERSONALITY_TEMPLATE = `# 性格・話し方

natsumi の性格と話し方をここに書きます。このファイルは初回起動時に一度だけ作成され、以後は上書きされません。
`;

/** `--data-dir` wins; otherwise the launch cwd. Resolved once to a real absolute path. */
export async function resolveDataDirectory(flag: string | undefined, cwd: string): Promise<string> {
  let dir: string;
  try { dir = await realpath(resolve(cwd, flag ?? '.')); } catch {
    throw new DataDirectoryError('does not exist; create it first');
  }
  if (!(await stat(dir)).isDirectory()) throw new DataDirectoryError('not a directory');
  if (await findCodeCheckout(dir)) {
    throw new DataDirectoryError('is inside the natsumi code checkout; keep personal data outside the code');
  }
  return dir;
}

/** Creates the initial layout. Existing files and directories are never overwritten or re-permissioned. */
export async function initializeDataDirectory(dir: string): Promise<void> {
  for (const name of ['memory', STATE_DIRECTORY]) {
    const path = join(dir, name);
    try { await mkdir(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await stat(path)).isDirectory()) throw new DataDirectoryError(`${name} exists but is not a directory`);
    }
  }
  try { await writeFile(join(dir, 'personality.md'), PERSONALITY_TEMPLATE, { flag: 'wx', mode: 0o600 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
