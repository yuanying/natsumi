import { describeFailure, type SlackApi } from './slack-api.ts';
import { STANDARD_EMOJI, TONED_EMOJI } from './slack-emoji-names.ts';

/**
 * Which emoji the dove may put on (ADR 0042): any emoji that exists. A standard one by any of its names, with a skin
 * tone (`::skin-tone-2` to `-6`) where it takes one, or a custom one of the workspace, aliases included.
 *
 * The standard names are the server's own (slack-emoji-names.ts). The custom ones are read with `emoji.list`, one list
 * per workspace, and kept: read again once it is old, or for a name it lacks, but never more often than once a while.
 * When the list cannot be read (`missing_scope` without `emoji:read`, most likely), the standard names are all there
 * is until the next read, and the log says why in one line.
 */

/** A list older than this is read again before a name is taken from it. */
export const EMOJI_REFRESH_MS = 60 * 60 * 1000;
/** A name the list lacks reads it again, but no sooner than this after the last read, whatever it answered. */
export const EMOJI_REFETCH_MS = 60 * 1000;

const STANDARD = new Set(STANDARD_EMOJI);
const TONED = new Set(TONED_EMOJI);
const SKIN_TONE = /^(.+)::skin-tone-[2-6]$/;

export interface SlackEmojiOptions {
  /** The Web API of each configured workspace, by its name in the config. */
  workspaces: Record<string, SlackApi>;
  now: () => number;
  log?: (line: string) => void;
}

interface Kept { names: ReadonlySet<string>; readAt: number }

export class SlackEmoji {
  private readonly options: SlackEmojiOptions;
  private readonly kept = new Map<string, Kept>();
  private readonly reading = new Map<string, Promise<Kept>>();

  constructor(options: SlackEmojiOptions) {
    this.options = options;
  }

  /** Reads every workspace's list, so that the first requests wait for nothing and a missing scope shows at the start. */
  async warm(): Promise<void> {
    await Promise.all(Object.keys(this.options.workspaces).map(workspace => this.read(workspace)));
  }

  /** Whether `name` (without colons) is an emoji Slack will put on in `workspace`. */
  async exists(workspace: string, name: string): Promise<boolean> {
    if (STANDARD.has(name)) return true;
    const toned = SKIN_TONE.exec(name);
    if (toned) return TONED.has(toned[1]!);
    if (!this.options.workspaces[workspace]) return false;
    let kept = this.kept.get(workspace);
    const age = kept ? this.options.now() - kept.readAt : Infinity;
    if (!kept || age >= EMOJI_REFRESH_MS || (!kept.names.has(name) && age >= EMOJI_REFETCH_MS)) kept = await this.read(workspace);
    return kept.names.has(name);
  }

  /** One read at a time per workspace; a failure keeps what was read before, and counts as a read. */
  private read(workspace: string): Promise<Kept> {
    const already = this.reading.get(workspace);
    if (already) return already;
    const reading = (async () => {
      let names: ReadonlySet<string>;
      try {
        names = new Set(await this.options.workspaces[workspace]!.customEmoji());
      } catch (error) {
        this.options.log?.(`slack (${workspace}): the custom emoji could not be read (${describeFailure(error)})`);
        names = this.kept.get(workspace)?.names ?? new Set();
      }
      const kept = { names, readAt: this.options.now() };
      this.kept.set(workspace, kept);
      return kept;
    })().finally(() => { this.reading.delete(workspace); });
    this.reading.set(workspace, reading);
    return reading;
  }
}
