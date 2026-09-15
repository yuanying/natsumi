import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolOutcome } from './loop-tools.ts';
import { localDate } from './nightly.ts';
import { findControlStrings, findForeignScript } from './output-checks.ts';

export const MAX_NOTE_CHARS = 1000;
export const MAX_TOPIC_CHARS = 60;
/** The most lines one recall returns. */
export const RECALL_LINE_LIMIT = 20;
/** The most characters one read_memory returns. */
export const READ_CHARS_LIMIT = 8000;

const EXTENSION = '.md';
// C0 controls and DEL. Newlines in a note are folded to spaces before this check.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const NOTE_LINE = /^- \d{4}-\d{2}-\d{2}: (.*)$/;
// Kanji and katakana carry the meaning of a Japanese question; kana particles and punctuation do not.
const CONTENT_CHARACTER = /[\p{Script=Han}\p{Script=Katakana}]/gu;
/** A line without a matching word counts when it holds at least this share of the question's kanji and katakana. */
const COVERAGE_THRESHOLD = 0.5;

/**
 * The file name for a topic: letters, digits, `_` and `-` only, so it has no separator or dot and cannot name a
 * path outside the memory directory. Undefined when nothing usable is left.
 */
export function memoryFileName(topic: string): string | undefined {
  const slug = topic.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  const cut = [...slug].slice(0, MAX_TOPIC_CHARS).join('').replace(/-+$/, '');
  return cut === '' ? undefined : `${cut}${EXTENSION}`;
}

export interface MemoryStoreOptions {
  /** `memory/` inside the data directory. */
  directory: string;
  /** Dates on memory lines are written in this time zone. */
  timeZone: string;
  now: () => number;
}

type Refusal = { ok: false; text: string };

/**
 * Long-term memory as Markdown under `memory/` (ADR 0003, ADR 0009): one file per topic, one dated line per note.
 * The server builds every path from a topic name; the model never names a path. Symlinks are never followed.
 */
export class MemoryStore {
  private readonly options: MemoryStoreOptions;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryStoreOptions) { this.options = options; }

  /**
   * Every operation waits for the previous one. Pi runs the tools of one model call concurrently, and a remember and
   * a forget on the same topic must not interleave.
   */
  private serial(operation: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => undefined);
    return run;
  }

  remember(topic: string, note: string): Promise<ToolOutcome> {
    return this.serial(() => this.rememberNow(topic, note));
  }

  private async rememberNow(topic: string, note: string): Promise<ToolOutcome> {
    const target = await this.target(topic);
    if ('ok' in target) return target;
    const text = note.replace(/\s*\r?\n\s*/g, ' ').trim();
    const refused = checkText(text, '記憶する内容', MAX_NOTE_CHARS);
    if (refused) return refused;
    const existing = await this.readFile(target.path);
    if (existing === 'refused') return notAFile(target.topic);
    if (existing !== undefined && noteLines(existing).some(line => line === text)) {
      return { ok: true, text: `「${target.topic}」にはすでに同じ記憶があります。書き足していません。` };
    }
    const line = `- ${localDate(this.options.now(), this.options.timeZone)}: ${text}\n`;
    const content = existing === undefined ? `# ${target.topic}\n\n${line}` : `${existing.endsWith('\n') || existing === '' ? '' : '\n'}${line}`;
    try {
      const flags = constants.O_WRONLY | constants.O_NOFOLLOW | (existing === undefined ? constants.O_CREAT | constants.O_EXCL : constants.O_APPEND);
      const handle = await open(target.path, flags, 0o600);
      try { await handle.writeFile(content); } finally { await handle.close(); }
    } catch { return notAFile(target.topic); }
    return { ok: true, text: `記憶「${target.topic}」に書きました: ${text}` };
  }

  recall(query: string): Promise<ToolOutcome> {
    return this.serial(() => this.recallNow(query));
  }

  private async recallNow(query: string): Promise<ToolOutcome> {
    const directory = await this.directory();
    if (directory) return directory;
    const folded = fold(query);
    const terms = [...new Set(folded.split(/\s+/).filter(term => term !== ''))];
    const wanted = new Set(folded.match(CONTENT_CHARACTER) ?? []);
    const topics = await this.topics();
    const hits: { score: number; order: number; line: string }[] = [];
    for (const { name, path } of topics) {
      const content = await this.readFile(path);
      if (typeof content !== 'string') continue;
      const lines = content.split('\n');
      const title = lines.find(line => line.startsWith('# '))?.slice(2).trim() ?? name;
      const inTitle = terms.filter(term => fold(title).includes(term) || name.toLowerCase().includes(term)).length;
      for (const line of memoryLines(content)) {
        const text = fold(line);
        // Whole words first; then how much of the question's kanji and katakana the line holds, so a question
        // written without spaces, with a particle or a question mark still finds its memory.
        const words = terms.filter(term => text.includes(term)).length;
        const present = new Set(text.match(CONTENT_CHARACTER) ?? []);
        const shared = [...wanted].filter(character => present.has(character)).length;
        const coverage = wanted.size > 0 && shared >= Math.min(2, wanted.size) ? shared / wanted.size : 0;
        const score = words * 2 + inTitle + (coverage >= COVERAGE_THRESHOLD ? coverage : 0);
        if (words + inTitle > 0 || coverage >= COVERAGE_THRESHOLD) hits.push({ score, order: hits.length, line: `[${title}] ${line.trim()}` });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    const names = topics.map(topic => topic.name.slice(0, -EXTENSION.length));
    const index = names.length > 0 ? `記憶のトピック: ${names.join(', ')}` : '記憶はまだありません。';
    if (hits.length === 0) return { ok: true, text: `「${query}」に当てはまる記憶は見つかりませんでした。\n${index}` };
    const shown = hits.slice(0, RECALL_LINE_LIMIT).map(hit => hit.line);
    const more = hits.length > shown.length ? `\n（ほかに ${hits.length - shown.length} 行あります。read_memory でトピックごとに読めます）` : '';
    return { ok: true, text: `「${query}」に関係する記憶:\n${shown.join('\n')}${more}\n${index}` };
  }

  read(topic: string): Promise<ToolOutcome> {
    return this.serial(() => this.readNow(topic));
  }

  private async readNow(topic: string): Promise<ToolOutcome> {
    const target = await this.target(topic);
    if ('ok' in target) return target;
    const content = await this.readFile(target.path);
    if (content === 'refused') return notAFile(target.topic);
    if (content === undefined || memoryLines(content).length === 0) {
      return { ok: false, text: `「${target.topic}」の記憶はまだありません。recall で探せます。` };
    }
    const cut = [...content].length > READ_CHARS_LIMIT ? `${[...content].slice(0, READ_CHARS_LIMIT).join('')}\n（長いので途中までです）` : content;
    return { ok: true, text: `記憶「${target.topic}」:\n${cut}` };
  }

  forget(topic: string, text: string): Promise<ToolOutcome> {
    return this.serial(() => this.forgetNow(topic, text));
  }

  private async forgetNow(topic: string, text: string): Promise<ToolOutcome> {
    const target = await this.target(topic);
    if ('ok' in target) return target;
    const needle = text.trim();
    if (needle === '') return { ok: false, text: '忘れる内容が空です。消したい記憶の文言を入れてください。' };
    const content = await this.readFile(target.path);
    if (content === 'refused') return notAFile(target.topic);
    if (content === undefined) return { ok: false, text: `「${target.topic}」の記憶はまだありません。` };
    const lines = content.split('\n');
    const kept = lines.filter(line => line.startsWith('#') || line.trim() === '' || !line.includes(needle));
    const removed = lines.length - kept.length;
    if (removed === 0) return { ok: false, text: `「${target.topic}」に「${needle}」を含む記憶はありません。何も消していません。` };
    if (memoryLines(kept.join('\n')).length === 0) {
      // A topic with nothing left is removed, so it is not offered as a topic any more. The path was opened without
      // following symlinks just above, and unlinking removes only the directory entry.
      try { await unlink(target.path); } catch { return notAFile(target.topic); }
      return { ok: true, text: `「${target.topic}」から「${needle}」を含む記憶を ${removed} 行消しました。このトピックの記憶はなくなりました。` };
    }
    // Written beside the file and renamed over it: a symlink put in its place is replaced, never followed.
    const temporary = join(this.options.directory, `.${target.name}.tmp-${randomBytes(6).toString('hex')}`);
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(kept.join('\n')); } finally { await handle.close(); }
      await rename(temporary, target.path);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      return notAFile(target.topic);
    }
    return { ok: true, text: `「${target.topic}」から「${needle}」を含む記憶を ${removed} 行消しました。` };
  }

  /** A refusal unless the memory directory is a real directory (not a symlink). */
  private async directory(): Promise<Refusal | undefined> {
    try {
      const info = await lstat(this.options.directory);
      if (info.isDirectory()) return undefined;
    } catch { /* missing */ }
    return { ok: false, text: '記憶の置き場を使えません。何も読み書きしていません。' };
  }

  private async target(topic: string): Promise<{ topic: string; name: string; path: string } | Refusal> {
    const directory = await this.directory();
    if (directory) return directory;
    const title = topic.replace(/\s+/g, ' ').trim();
    const refused = checkText(title, 'トピック', MAX_TOPIC_CHARS);
    if (refused) return refused;
    const name = memoryFileName(title);
    if (!name) return { ok: false, text: 'トピックに使える文字がありません。文字や数字を含む短い名前にしてください。' };
    return { topic: title, name, path: join(this.options.directory, name) };
  }

  /**
   * Regular Markdown files directly in the memory directory that hold at least one memory line.
   * Symlinks, directories, hidden files and heading-only files are skipped.
   */
  private async topics(): Promise<{ name: string; path: string }[]> {
    let entries;
    try { entries = await readdir(this.options.directory, { withFileTypes: true }); } catch { return []; }
    const topics: { name: string; path: string }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(EXTENSION) || entry.name.startsWith('.')) continue;
      const path = join(this.options.directory, entry.name);
      const content = await this.readFile(path);
      if (typeof content === 'string' && memoryLines(content).length > 0) topics.push({ name: entry.name, path });
    }
    return topics.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The file's text, undefined when it does not exist, or 'refused' when it is a symlink or not a regular file. */
  private async readFile(path: string): Promise<string | undefined | 'refused'> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'refused';
    }
    try {
      if (!(await handle.stat()).isFile()) return 'refused';
      return await handle.readFile('utf8');
    } catch { return 'refused'; } finally { await handle.close(); }
  }
}

function checkText(text: string, label: string, max: number): Refusal | undefined {
  if (text === '') return { ok: false, text: `${label}が空です。` };
  if ([...text].length > max) return { ok: false, text: `${label}が長すぎます（${max} 文字まで）。短くまとめてください。` };
  const control = findControlStrings(text);
  if (control.length > 0) {
    return { ok: false, text: `${label}にテンプレートの制御文字列（${control.join(' ')}）が含まれています。除いて書き直してください。` };
  }
  if (CONTROL_CHARACTERS.test(text)) return { ok: false, text: `${label}に制御文字が含まれています。除いて書き直してください。` };
  const foreign = findForeignScript(text);
  if (foreign.length > 0) {
    return { ok: false, text: `${label}に日本語以外の文字（${foreign.join(' ')}）が含まれています。日本語で書き直してください。` };
  }
  return undefined;
}

/** Lines that are memories: everything but headings and blank lines. A hand-written file may use any line shape. */
function memoryLines(content: string): string[] {
  return content.split('\n').filter(line => line.trim() !== '' && !line.startsWith('#'));
}

/** NFKC, lower case, and punctuation and symbols turned into spaces. */
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ');
}

function noteLines(content: string): string[] {
  return content.split('\n').map(line => NOTE_LINE.exec(line)?.[1]?.trim()).filter((line): line is string => line !== undefined);
}

function notAFile(topic: string): Refusal {
  return { ok: false, text: `「${topic}」の記憶ファイルを安全に扱えません（通常のファイルではありません）。何も読み書きしていません。` };
}
