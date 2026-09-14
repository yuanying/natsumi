import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';

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
