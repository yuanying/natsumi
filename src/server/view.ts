import { open, realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { ToolOutcome } from './loop-tools.ts';
import { isWithin } from './paths.ts';

/**
 * `view <path>` in the shell (ADR 0039): the server answers it itself, putting the image into the tool result, so
 * natsumi looks at a picture only when she wants to and no tool is added. Only what is under `/sources` is shown —
 * a place she reads and never writes, so nothing she makes can point the server anywhere else — only images, and
 * only up to a size.
 */

/** Where the workspace sees the sources, which is `sources/` in the data directory. */
export const SOURCES_PATH = '/sources';
/** The largest image `view` shows. */
export const VIEW_MAX_BYTES = 5 * 1024 * 1024;

const LONE_VIEW = /^\s*view\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/;

/** The path of a command that is `view` and one path and nothing else; undefined for anything the runner should run. */
export function parseView(command: string): string | undefined {
  const match = LONE_VIEW.exec(command);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

/** An image's type from its first bytes. The name and what Slack said are not trusted. */
export function imageType(head: Buffer): string | undefined {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

/** Reads the image at a workspace path under `/sources`, mapped onto `sourcesDirectory` on the server. */
export async function viewImage(path: string, sourcesDirectory: string): Promise<ToolOutcome & { images?: ImageContent[] }> {
  const refuse = (text: string) => ({ ok: false, text: `表示していません。${text}` });
  if (!path.startsWith('/')) return refuse('view には /sources/ から始まる絶対パスを書いてください。');
  const normalized = posix.normalize(path);
  if (!normalized.startsWith(`${SOURCES_PATH}/`)) return refuse('view で見られるのは /sources/ の下のファイルだけです。');
  let real: string;
  let root: string;
  try {
    root = await realpath(sourcesDirectory);
    real = await realpath(posix.join(root, normalized.slice(SOURCES_PATH.length + 1)));
  } catch { return refuse(`${normalized} が見つかりません。`); }
  // A link that leads out of the sources is refused as if it were outside, and says nothing of where it leads.
  if (!isWithin(real, root)) return refuse('view で見られるのは /sources/ の下のファイルだけです。');
  let handle;
  try { handle = await open(real, 'r'); } catch { return refuse(`${normalized} が見つかりません。`); }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return refuse(`${normalized} はファイルではありません。`);
    if (stats.size > VIEW_MAX_BYTES) {
      return refuse(`${normalized} は大きすぎます（${Math.round(VIEW_MAX_BYTES / 1024 / 1024)} MB まで）。`);
    }
    const data = await handle.readFile();
    const mimeType = imageType(data);
    if (!mimeType) return refuse(`${normalized} は画像ではありません（PNG・JPEG・GIF・WebP を見られます）。`);
    return { ok: true, text: `${normalized} を表示します（${mimeType}、${Math.ceil(data.length / 1024)} KB）。`,
      images: [{ type: 'image', mimeType, data: data.toString('base64') }] };
  } finally { await handle.close(); }
}
