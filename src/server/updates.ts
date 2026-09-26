/**
 * The frame every source of things to read shares (ADR 0039). A source keeps its files under `/sources/<name>/`,
 * counts what came since natsumi was last shown it, and records that she was shown it when it is taken. The loop
 * asks every source it was given and knows neither how many there are nor what they read.
 */
/**
 * What one source tells: counts by kind (`new` for what came, and whatever else it counts, such as Slack's
 * `reactions_on_mine`), each keyed by where, and the files to read. A kind with nothing in it is left out.
 */
export interface UpdateCounts {
  [kind: string]: Record<string, number> | string[];
  files: string[];
}

export interface UpdateSource {
  /** The source's name under `/sources/`, and its key in `updates`. */
  readonly name: string;
  /**
   * What came since the last time, and forgets it: from here on it counts from now. Undefined when nothing came, so
   * the source is left out of `updates`, and `updates` itself when every source is.
   */
  take(): UpdateCounts | undefined;
}

/** The `updates` of a ping or a self-check, or undefined when there is nothing to tell (ADR 0039). */
export function takeUpdates(sources: readonly UpdateSource[]): Record<string, unknown> | undefined {
  const updates: Record<string, unknown> = {};
  for (const source of sources) {
    let taken: ReturnType<UpdateSource['take']>;
    // A source that fails is left out this time; the others still go.
    try { taken = source.take(); } catch { continue; }
    if (taken) updates[source.name] = taken;
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}
