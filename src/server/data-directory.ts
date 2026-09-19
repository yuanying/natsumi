import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findCodeCheckout, HOME_DIRECTORY, WORK_DIRECTORY } from './paths.ts';

export class DataDirectoryError extends Error {
  constructor(message: string) { super(`data directory: ${message}`); this.name = 'DataDirectoryError'; }
}

export const STATE_DIRECTORY = '.natsumi';

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

/**
 * Creates the initial layout. Existing files and directories are never overwritten or re-permissioned.
 * `memory/` is only made here; what goes in it belongs to the memory repository (ADR 0018), personality.md included.
 * `work/` and `home/` are the workspace container's `/work` and `/home/natsumi` (ADR 0019): the server makes them
 * and then never looks inside, so that boundary can be said in one sentence.
 */
export async function initializeDataDirectory(dir: string): Promise<void> {
  for (const name of ['memory', WORK_DIRECTORY, HOME_DIRECTORY, STATE_DIRECTORY]) {
    const path = join(dir, name);
    try { await mkdir(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await stat(path)).isDirectory()) throw new DataDirectoryError(`${name} exists but is not a directory`);
    }
  }
}
