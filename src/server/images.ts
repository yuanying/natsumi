import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isWithin } from './paths.ts';
import { imageType } from './view.ts';

/**
 * Images natsumi hands the server from /work (ADR 0044), such as those she names under `画像:` in a request to the
 * dove. Only what is under `/work` is taken — a link or `..` that leads out of it is refused as if it were outside —
 * only PNG, JPEG and WebP by their bytes, and only within the limits. What passes is copied at once to the server's
 * side, where the workspace cannot write, and given an ID: the owner is shown the copy and the copy is what is sent,
 * whatever becomes of the file in /work. The copies do not belong to the dove: each is one image of the server's,
 * which the devices fetch by its ID with the session, whatever shows it to them.
 */

/** Where the workspace sees its working directory, which is `work/` in the data directory. */
export const WORK_PATH = '/work';
/** Where the copies are kept, under the server's own state directory. */
export const IMAGE_DIRECTORY = 'images';

export type PostImageType = 'image/png' | 'image/jpeg' | 'image/webp';
const EXTENSIONS: Record<PostImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export interface ImageLimits {
  /** The largest image taken. */
  maxBytes: number;
  /** The most images in one request. */
  maxCount: number;
}

export interface TakenImage {
  imageId: string;
  /** The path as the workspace names it, normalized. */
  source: string;
  /** Where the copy is. */
  file: string;
  mimeType: PostImageType;
  bytes: number;
  sha256: string;
}

export type TakenImages = { ok: true; images: TakenImage[] } | { ok: false; text: string };

/**
 * Checks every image and copies them all into `destination`, each named by its new ID, or copies none and says in one
 * sentence what to fix. `workDirectory` is `/work` as the server sees it.
 */
export async function takeImages(paths: string[], options: { workDirectory: string; destination: string; limits: ImageLimits }):
  Promise<TakenImages> {
  const { limits } = options;
  if (paths.length > limits.maxCount) return { ok: false, text: `画像は 1 回に ${limits.maxCount} 枚までです（${paths.length} 枚ありました）。` };
  const read: { source: string; data: Buffer; mimeType: PostImageType }[] = [];
  for (const path of paths) {
    const one = await readImage(path, options.workDirectory, limits.maxBytes);
    if (!one.ok) return one;
    read.push(one);
  }
  const images = read.map(({ source, data, mimeType }) => {
    const imageId = `image-${randomUUID()}`;
    return { imageId, source, file: join(options.destination, `${imageId}.${EXTENSIONS[mimeType]}`), mimeType, bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'), data };
  });
  try {
    await mkdir(options.destination, { recursive: true, mode: 0o700 });
    for (const image of images) await writeFile(image.file, image.data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await discardImages(images);
    throw error;
  }
  return { ok: true, images: images.map(({ data: _data, ...image }) => image) };
}

/** Removes copies that were taken and then not kept. */
export async function discardImages(images: { file: string }[]): Promise<void> {
  await Promise.all(images.map(image => rm(image.file, { force: true })));
}

/**
 * The images the server has taken, recorded in the state database (the `images` table) with their copies in
 * `directory`. Whatever shows an image — an approval now — names it by `imageId` only.
 */
export class ImageStore {
  readonly directory: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, directory: string) {
    this.db = db;
    this.directory = directory;
  }

  take(paths: string[], workDirectory: string, limits: ImageLimits): Promise<TakenImages> {
    return takeImages(paths, { workDirectory, destination: this.directory, limits });
  }

  /** Records taken images. Called inside the transaction that records what they belong to. */
  record(images: TakenImage[], createdAt: string): void {
    const insert = this.db.prepare(`INSERT INTO images (image_id, source, file, mime_type, bytes, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const image of images) {
      insert.run(image.imageId, image.source, basename(image.file), image.mimeType, image.bytes, image.sha256, createdAt);
    }
  }

  /** An image's copy by its ID, or undefined when there is no such image or its copy is gone. */
  async read(imageId: string): Promise<{ mimeType: string; data: Buffer } | undefined> {
    const row = this.db.prepare('SELECT file, mime_type FROM images WHERE image_id = ?').get(imageId) as
      { file: string; mime_type: string } | undefined;
    if (!row) return undefined;
    try { return { mimeType: row.mime_type, data: await readFile(join(this.directory, row.file)) }; } catch { return undefined; }
  }

  /** Where an image's copy is, for sending it. */
  path(file: string): string { return join(this.directory, file); }
}

async function readImage(path: string, workDirectory: string, maxBytes: number):
  Promise<{ ok: true; source: string; data: Buffer; mimeType: PostImageType } | { ok: false; text: string }> {
  const refuse = (text: string) => ({ ok: false as const, text });
  const outside = refuse(`画像「${path}」は使えません。画像にできるのは /work/ の下のファイルだけです。`);
  const source = posix.normalize(path);
  if (!source.startsWith(`${WORK_PATH}/`)) return outside;
  let root: string;
  let real: string;
  try {
    root = await realpath(workDirectory);
    real = await realpath(join(root, source.slice(WORK_PATH.length + 1)));
  } catch { return refuse(`画像 ${source} が見つかりません。`); }
  // A link that leads out of /work is refused as if it were outside, and says nothing of where it leads.
  if (!isWithin(real, root) || real === root) return outside;
  let handle;
  try { handle = await open(real, 'r'); } catch { return refuse(`画像 ${source} が見つかりません。`); }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return refuse(`画像 ${source} はファイルではありません。`);
    if (stats.size > maxBytes) return refuse(`画像 ${source} は大きすぎます（${size(maxBytes)} まで）。`);
    const data = await handle.readFile();
    // Read again rather than trusted: the file may have grown since it was looked at.
    if (data.length > maxBytes) return refuse(`画像 ${source} は大きすぎます（${size(maxBytes)} まで）。`);
    const mimeType = imageType(data);
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') {
      return refuse(`画像 ${source} は PNG・JPEG・WebP のどれでもありません（中身で見分けます）。`);
    }
    return { ok: true, source, data, mimeType };
  } finally { await handle.close(); }
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.floor(bytes / 1024 / 1024)} MB` : `${Math.floor(bytes / 1024)} KB`;
}
