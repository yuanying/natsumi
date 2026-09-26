import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';

/**
 * Where `/work` and `/home/natsumi` live inside the data directory. The workspace container mounts them from the
 * same volume by subpath (ADR 0019); the server makes them and then never looks inside.
 */
export const WORK_DIRECTORY = 'work';
export const HOME_DIRECTORY = 'home';
/** What natsumi reads besides memory, one directory per source; the workspace sees it read-only as `/sources` (ADR 0039). */
export const SOURCES_DIRECTORY = 'sources';

/** Real path of `path`, following symlinks of the longest existing prefix; the rest need not exist yet. */
export async function realPathAllowingMissing(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await realPathAllowingMissing(parent), basename(path));
  }
}

/** True when `child` is `parent` or below it. Both must already be real absolute paths. */
export function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The natsumi code checkout containing `path` (itself or an ancestor with this package's package.json), if any. */
export async function findCodeCheckout(path: string): Promise<string | undefined> {
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (pkg.name === 'natsumi') return dir;
    } catch { /* not a checkout root */ }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Replaces `path` with a new file of `mode`, atomically: written under a temporary name beside it and renamed over.
 * A reader sees the old file or the new one, never a half-written one, and never a file whose mode came from
 * somewhere else — the temporary name is made fresh, so a leftover from an earlier crash cannot be written through.
 */
export async function writeFileAtomically(path: string, text: string, mode: number): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, text, { flag: 'wx', mode });
  await rename(temporary, path);
}
