import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from './git.ts';
import { findControlStrings, findForeignScript, hasControlCharacters } from './output-checks.ts';

/**
 * Memory as a git repository (ADR 0018): everything natsumi is made of — her memories, the always-memory, her
 * personality and the nightly handoff — is Markdown in one repository the owner can read, diff and put right.
 *
 * The model writes into the working tree through the memory shell (ADR 0011). The server owns the history: at the
 * end of every turn it checks what changed, puts back what fails a check, and commits the rest. It never pushes or
 * pulls; a remote, a backup and encryption are the owner's to arrange.
 */

/** The always-memory: what goes into every prompt. Written by natsumi at night. */
export const ALWAYS_FILE = 'always.md';
/** Personality and manner of speaking, put into the prompt when a session is made. */
export const PERSONALITY_FILE = 'personality.md';
/** The note the nightly review leaves for the next session. */
export const HANDOFF_FILE = 'handoff.md';
/** The three names the server fixes. Everything else in the repository is natsumi's to arrange. */
export const FIXED_FILES = [ALWAYS_FILE, PERSONALITY_FILE, HANDOFF_FILE] as const;
/** These ride in every prompt, so only the nightly review may change them: a day turn's change is put back. */
export const NIGHT_ONLY_FILES: readonly string[] = [ALWAYS_FILE, PERSONALITY_FILE];

/** The longest one memory file may be, in characters. */
export const DEFAULT_FILE_MAX_CHARS = 32000;

const ALWAYS_TEMPLATE = `# 常時記憶

毎回のプロンプトに入る短いメモです。本人の呼び方と口調、いま続いていること、よく使う事実など、
毎回思い出したいことだけを書きます。夜の再構成のときに見直し、長くなりすぎたら削ります。
`;

const PERSONALITY_TEMPLATE = `# 性格・話し方

natsumi の性格と話し方をここに書きます。夜の再構成のときだけ書き換えられます。
`;

const HANDOFF_TEMPLATE = `# 引き継ぎ

まだ引き継ぎはありません。
`;

/** The longest a machine-made commit subject gets. */
const MAX_SUBJECT_CHARS = 120;
/** File names a machine-made commit subject lists before it says how many more there are. */
const SUBJECT_FILES = 5;
/** File names the line about what changed lists before it says how many more there are (ADR 0019). */
const SUMMARY_FILES = 5;

export interface MemoryRepositoryOptions {
  /** The repository: `loop.memoryRepository`, by default `memory/` in the data directory. */
  directory: string;
  /** Where an older layout left `personality.md`; the first start moves it into the repository. */
  dataDirectory: string;
  /** `loop.memoryFileMaxChars`. */
  fileMaxChars?: number;
  log?: (line: string) => void;
}

/** A file the check caught, put back to the previous commit (or removed when it was new). */
export interface RevertedFile { path: string; reason: string }

export interface CommitOutcome {
  committed: boolean;
  /** The paths the commit carries, empty when nothing was committed. */
  files: string[];
  reverted: RevertedFile[];
}

type Change = 'added' | 'modified' | 'deleted';

interface StatusEntry { path: string; deleted: boolean; change: Change }

const CHANGE_WORDS: Record<Change, string> = { added: '追加', modified: '変更', deleted: '削除' };

export class MemoryRepository {
  readonly directory: string;
  private readonly options: MemoryRepositoryOptions;

  constructor(options: MemoryRepositoryOptions) {
    this.options = options;
    this.directory = options.directory;
  }

  private get fileMaxChars(): number { return this.options.fileMaxChars ?? DEFAULT_FILE_MAX_CHARS; }

  /**
   * Makes the repository if it is not one yet, on `main`, taking whatever Markdown is already there into the first
   * commit under its own name and contents. An existing repository keeps its history: only the three fixed files
   * that are missing are written, and only those are committed.
   */
  async initialize(handoff?: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const fresh = !(await this.isRepository());
    if (fresh) await runGit(this.directory, ['init', '-b', 'main']);
    const placed = await this.placeFixedFiles(handoff);
    if (fresh) await runGit(this.directory, ['add', '-A', '--', '.']);
    else if (placed.length > 0) await runGit(this.directory, ['add', '--', ...placed]);
    else return;
    const staged = (await runGit(this.directory, ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean);
    if (staged.length === 0) return;
    await this.commitStaged('start', staged);
    this.log(`memory: ${fresh ? 'made the repository' : 'wrote the missing files'} (${staged.length} file(s))`);
  }

  /**
   * The end of a turn: what changed is checked file by file, what fails goes back to the previous commit (a new file
   * is removed), and what is left becomes one commit. A turn that changed nothing commits nothing.
   * Removing and renaming is natsumi's to do, save for the three fixed files, which come back.
   */
  async commit(input: { event: string; night?: boolean }): Promise<CommitOutcome> {
    const reverted: RevertedFile[] = [];
    for (const entry of await this.status()) {
      const reason = entry.deleted ? this.inspectRemoval(entry.path) : await this.inspect(entry.path, input.night === true);
      if (!reason) continue;
      await this.restore(entry.path);
      reverted.push({ path: entry.path, reason });
    }
    const files = (await this.status()).map(entry => entry.path);
    if (files.length === 0) return { committed: false, files: [], reverted };
    await runGit(this.directory, ['add', '-A', '--', '.']);
    await this.commitStaged(input.event, files);
    if (reverted.length > 0) this.log(`memory: ${reverted.length} changed file(s) went back to the previous commit`);
    return { committed: true, files, reverted };
  }

  /**
   * What memory holds that the last commit does not, as one line, or an empty string when nothing differs. It rides
   * on the result of every shell command: the working places are never inspected, so without this natsumi could
   * write a memory into `/work` and have nothing tell her it was not kept (ADR 0019).
   */
  async changeSummary(): Promise<string> {
    let entries: StatusEntry[];
    try { entries = await this.status(); } catch { return ''; }
    if (entries.length === 0) return '';
    const shown = entries.slice(0, SUMMARY_FILES).map(entry => `${entry.path}（${CHANGE_WORDS[entry.change]}）`);
    const more = entries.length > SUMMARY_FILES ? [`ほか ${entries.length - SUMMARY_FILES} 件`] : [];
    return [...shown, ...more].join('、').replace(/\s+/g, ' ');
  }

  /** True when the directory is a repository of its own, rather than a directory inside somebody else's. */
  private async isRepository(): Promise<boolean> {
    try { await lstat(join(this.directory, '.git')); return true; } catch { return false; }
  }

  /** Writes the fixed files that are missing and returns their paths. */
  private async placeFixedFiles(handoff: string | undefined): Promise<string[]> {
    const placed: string[] = [];
    if (!(await this.exists(PERSONALITY_FILE))) {
      const previous = join(this.options.dataDirectory, PERSONALITY_FILE);
      const moved = await this.move(previous, join(this.directory, PERSONALITY_FILE));
      if (!moved) await writeFile(join(this.directory, PERSONALITY_FILE), PERSONALITY_TEMPLATE, { mode: 0o600 });
      placed.push(PERSONALITY_FILE);
    }
    if (!(await this.exists(ALWAYS_FILE))) {
      await writeFile(join(this.directory, ALWAYS_FILE), ALWAYS_TEMPLATE, { mode: 0o600 });
      placed.push(ALWAYS_FILE);
    }
    if (!(await this.exists(HANDOFF_FILE))) {
      const text = handoff?.trim() ? `# 引き継ぎ\n\n${handoff.trim()}\n` : HANDOFF_TEMPLATE;
      await writeFile(join(this.directory, HANDOFF_FILE), text, { mode: 0o600 });
      placed.push(HANDOFF_FILE);
    }
    return placed;
  }

  /** Moves a file, falling back to a copy when the two are on different filesystems. False when there was none. */
  private async move(from: string, to: string): Promise<boolean> {
    try {
      const info = await lstat(from);
      if (!info.isFile()) return false;
    } catch { return false; }
    try { await rename(from, to); } catch {
      await copyFile(from, to);
      await rm(from, { force: true });
    }
    return true;
  }

  private async exists(name: string): Promise<boolean> {
    try { await lstat(join(this.directory, name)); return true; } catch { return false; }
  }

  private async commitStaged(event: string, files: string[]): Promise<void> {
    await runGit(this.directory, ['commit', '--no-verify', '--quiet', '-m', subject(event, files)]);
  }

  /** What differs from the last commit, one entry per path. Renames come back as a removal and an addition. */
  private async status(): Promise<StatusEntry[]> {
    const { stdout } = await runGit(this.directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
    return stdout.split('\0').filter(entry => entry.length > 3).map(entry => {
      const code = entry.slice(0, 2);
      const deleted = code[0] === 'D' || code[1] === 'D';
      return {
        path: entry.slice(3),
        deleted,
        change: deleted ? 'deleted' : code === '??' || code[0] === 'A' ? 'added' : 'modified',
      } as StatusEntry;
    });
  }

  /**
   * Why a removal may not be committed, or undefined when it may. Only the three names the server fixes are kept:
   * everything else in the repository is natsumi's, and what she deletes the history still holds. The three are
   * the server's own footing — the prompt reads them every turn — so losing one would quietly break what the server
   * assumes, with nobody told. A rename reaches here as the removal half, and is put back the same way.
   */
  private inspectRemoval(path: string): string | undefined {
    if (!FIXED_FILES.includes(path as typeof FIXED_FILES[number])) return undefined;
    return `${path} はサーバーが名前と置き場所を固定しているファイルなので、消すことも改名することもできません`;
  }

  /** Why the changed file may not be committed, or undefined when it may. A removal goes through inspectRemoval. */
  private async inspect(path: string, night: boolean): Promise<string | undefined> {
    if (!night && NIGHT_ONLY_FILES.includes(path)) {
      return `${path} は毎回のプロンプトに入るので、夜の再構成のターンでだけ書き換えられます`;
    }
    let info;
    try { info = await lstat(join(this.directory, path)); } catch { return undefined; }
    if (info.isSymbolicLink()) return 'symlink は記憶に置けません';
    if (!info.isFile()) return '通常のファイルではありません';
    if (!path.endsWith('.md')) return '.md 以外のファイルは記憶に置けません';
    let text: string;
    try { text = await readFile(join(this.directory, path), 'utf8'); } catch { return '読めないファイルです'; }
    if (text.trim() === '') return '中身が空です';
    if ([...text].length > this.fileMaxChars) return `1 ファイルの上限（${this.fileMaxChars} 文字）を超えています`;
    const control = findControlStrings(text);
    if (control.length > 0) return `テンプレートの制御文字列（${control.join(' ')}）が含まれています`;
    if (hasControlCharacters(text)) return '制御文字が含まれています';
    const foreign = findForeignScript(text);
    if (foreign.length > 0) return `日本語以外の文字（${foreign.join(' ')}）が含まれています`;
    return undefined;
  }

  /** Back to the last commit, or removed when the last commit did not have it. */
  private async restore(path: string): Promise<void> {
    const known = await runGit(this.directory, ['cat-file', '-e', `HEAD:${path}`], { allowFailure: true });
    if (known.code === 0) {
      await runGit(this.directory, ['checkout', 'HEAD', '--', path]);
      return;
    }
    await rm(join(this.directory, path), { force: true, recursive: true });
  }

  private log(line: string) { this.options.log?.(line); }
}

/** The sentence the next turn reads about what went back, or an empty string when nothing did. */
export function revertNotice(reverted: readonly RevertedFile[]): string {
  if (reverted.length === 0) return '';
  return ['記憶の検査に当たったので、次のファイルを直前のコミットの状態に戻しました（新しく作ったファイルは消えています）。',
    ...reverted.map(file => `- ${file.path}: ${file.reason}`),
    '理由を直してから書き直してください。'].join('\n');
}

/** The commit message the server makes during the day: the kind of event, and what changed. */
export function subject(event: string, files: readonly string[]): string {
  const shown = files.slice(0, SUBJECT_FILES).join(', ');
  const more = files.length > SUBJECT_FILES ? `, ほか ${files.length - SUBJECT_FILES} 件` : '';
  const line = `${event}: ${shown}${more}`.replace(/\s+/g, ' ');
  return [...line].length > MAX_SUBJECT_CHARS ? `${[...line].slice(0, MAX_SUBJECT_CHARS - 1).join('')}…` : line;
}
