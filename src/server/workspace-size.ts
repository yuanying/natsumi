import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How much the persistent writable places hold (ADR 0019). Docker volumes have no size of their own, so the way to
 * the host's disk stays open; forcing a quota would instead stop natsumi mid-task. The server measures and tells her,
 * and she tidies up. Measuring walks directories, so it happens at most once every ten minutes, between turns.
 */

/** `loop.workspaceSizeWarnBytes`. Memory and working files are text: a gibibyte means something is being hoarded. */
export const DEFAULT_SIZE_WARN_BYTES = 1024 * 1024 * 1024;
/** However many turns end, the places are walked no more often than this. */
export const MIN_MEASURE_INTERVAL_MS = 10 * 60_000;

/** One persistent place, under the name natsumi sees it by inside the container. */
export interface Place { label: string; path: string }

export interface WorkspaceSizeOptions {
  places: Place[];
  warnBytes: number;
  now?: () => number;
}

export class WorkspaceSize {
  private readonly options: WorkspaceSizeOptions;
  private readonly now: () => number;
  private measuredAt = 0;

  constructor(options: WorkspaceSizeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * The line for the next turn's prompt, or an empty string: when the interval has not passed, and when the total is
   * under the warning. A place that cannot be read counts as nothing rather than stopping the turn.
   */
  async check(): Promise<string> {
    const now = this.now();
    if (this.measuredAt !== 0 && now - this.measuredAt < MIN_MEASURE_INTERVAL_MS) return '';
    this.measuredAt = now;
    const sizes = await Promise.all(this.options.places.map(async place => ({ label: place.label, bytes: await total(place.path) })));
    const bytes = sizes.reduce((sum, place) => sum + place.bytes, 0);
    if (bytes <= this.options.warnBytes) return '';
    const breakdown = [...sizes].sort((a, b) => b.bytes - a.bytes).map(place => `${place.label} ${human(place.bytes)}`).join('、');
    return `永続する書き場所の合計が ${human(bytes)} になり、目安の ${human(this.options.warnBytes)} を超えています。`
      + `内訳は ${breakdown} です。`
      + '要らないものを片づけてください。残すものは /memory、手を動かした跡は /work と /home/natsumi です。';
  }
}

/** Bytes of the regular files under a directory. Symlinks are counted as nothing and never followed out. */
async function total(path: string): Promise<number> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return 0; }
  let bytes = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { bytes += await total(child); continue; }
    if (!entry.isFile()) continue;
    try { bytes += (await lstat(child)).size; } catch { /* gone between the listing and the look */ }
  }
  return bytes;
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

function human(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}
