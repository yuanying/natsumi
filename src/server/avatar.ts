import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EXPRESSIONS } from './loop-tools.ts';

/**
 * The faces Slack shows beside what the dove posts (ADR 0040): `<publicOrigin>/avatar/<feeling>.png`, one per
 * feeling natsumi can give a line (ADR 0026). Slack fetches them itself, so they are served without a login; they are
 * the character's public art and nothing else is reachable under this path.
 *
 * The PNGs are in the repository's `assets/avatar/`, made once from the Mac app's icons: Node reads no WebP, and a
 * library to convert them on every build would be a dependency for nine small files.
 */

export const AVATAR_PATH = /^\/avatar\/([a-z]+)\.png$/;

/** `assets/avatar` beside `src/` in a checkout, and beside `dist/` in the image. */
const DIRECTORIES = ['../../assets/avatar/', '../../../assets/avatar/'].map(path => fileURLToPath(new URL(path, import.meta.url)));

const cache = new Map<string, Buffer>();

/** The PNG of a feeling, or undefined for anything that is not one. */
export async function avatarImage(expression: string): Promise<Buffer | undefined> {
  if (!(EXPRESSIONS as readonly string[]).includes(expression)) return undefined;
  const cached = cache.get(expression);
  if (cached) return cached;
  for (const directory of DIRECTORIES) {
    try {
      const image = await readFile(`${directory}${expression}.png`);
      cache.set(expression, image);
      return image;
    } catch { /* the other place */ }
  }
  return undefined;
}
