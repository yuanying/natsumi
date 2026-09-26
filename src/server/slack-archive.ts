import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { Transaction } from './conversation-store.ts';
import type { ParsedReference } from './dove-request.ts';
import { isoAt } from './nightly.ts';
import { writeFileAtomically } from './paths.ts';
import type { UpdateSource } from './updates.ts';
import { imageType, SOURCES_PATH } from './view.ts';

/**
 * What natsumi reads of Slack (ADR 0039): every message of every channel the bot is in, kept in SQLite and written
 * out as one Markdown file a day under `sources/slack/<workspace>/<channel>/`, which the workspace sees read-only as
 * `/sources/slack/`. A change to a message writes its day's file again from the rows, so an edit or a deletion is
 * never a patch on the file. Nothing is removed from disk: the owner clears old files by hand.
 *
 * It is also Slack's update source — what came since natsumi was last shown it — and what a mention event is made
 * of when it is handed to her. No Slack ID (ts, channel, user) is ever written where she reads it (ADR 0024): a
 * message is named by its workspace, channel, local time to the second, and speaker.
 */

export const SLACK_SOURCE = 'slack';
/** Where natsumi sees this source. */
export const SLACK_PATH = `${SOURCES_PATH}/${SLACK_SOURCE}`;
/** The images of a mention handed to the model with its event, at most. */
export const MAX_MENTION_IMAGES = 4;
/** The longest a mention's own text is in its event. */
export const MAX_MENTION_CHARS = 4000;

/** A message as it is recorded: the speaker's name is resolved and Slack's markup already turned into text. */
export interface ArchivedMessage {
  ts: string;
  /** Set on a reply, to its parent's ts. A parent's own `thread_ts` is not kept. */
  threadTs?: string;
  speaker: string;
  /** Posted by natsumi's own bot. */
  own: boolean;
  text: string;
  /** `path` is where the workspace sees a fetched image; without it the file was only noted. */
  files: { name: string; path?: string }[];
  edited: boolean;
}

/**
 * A reference natsumi wrote, matched against the record (ADR 0040): the channel, and the message when one was named.
 * The Slack IDs stay on the server's side of it.
 */
export interface ResolvedTarget {
  workspace: string;
  channelId: string;
  /** How she names the channel: `work/#dev`, `work/@name`. */
  label: string;
  message?: { ts: string; threadTs?: string; speaker: string; at: string; text: string };
}

/** One message as the dove's judge and the owner see it: who, when (local, to the second), what. */
export interface SeenMessage { from: string; at: string; text: string }

export interface ChannelRow { workspace: string; channel_id: string; directory: string; label: string; is_im: number }

interface MessageRow {
  workspace: string; channel_id: string; ts: string; thread_ts: string | null; speaker: string; own: number; text: string;
  files: string; edited: number; deleted: number; file_date: string; counted: number;
}

export interface SlackArchiveOptions {
  db: DatabaseSync;
  /** `sources/slack` in the data directory. */
  directory: string;
  timeZone: string;
  now: () => number;
  /** The messages before a mention its event carries, and the characters each keeps. */
  mentionContext: { messages: number; chars: number };
}

/** A file natsumi can read: the group reads it, and nobody writes it through the workspace (ADR 0033). */
const FILE_MODE = 0o640;

export class SlackArchive implements UpdateSource {
  readonly name = SLACK_SOURCE;
  private readonly options: SlackArchiveOptions;
  private readonly db: DatabaseSync;
  private readonly clock: Intl.DateTimeFormat;
  /** File writes go one at a time, so two changes to a day never write its file out of order. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(options: SlackArchiveOptions) {
    this.options = options;
    this.db = options.db;
    this.clock = new Intl.DateTimeFormat('en-CA', { timeZone: options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }

  channel(workspace: string, channelId: string): ChannelRow | undefined {
    return this.db.prepare('SELECT * FROM slack_channels WHERE workspace = ? AND channel_id = ?').get(workspace, channelId) as
      ChannelRow | undefined;
  }

  /**
   * Records a channel the first time it is seen. Its directory is fixed then: a channel renamed later keeps its
   * files where natsumi has been reading them. A DM is named after the person, as `@name`.
   */
  addChannel(workspace: string, channelId: string, seen: { name?: string; isIm: boolean; userName?: string }): ChannelRow {
    const existing = this.channel(workspace, channelId);
    if (existing) return existing;
    const base = safeName(seen.isIm ? `@${seen.userName ?? 'someone'}` : seen.name ?? 'channel');
    let directory = base;
    for (let n = 2; this.db.prepare('SELECT 1 FROM slack_channels WHERE workspace = ? AND directory = ?').get(workspace, directory); n += 1) {
      directory = `${base}-${n}`;
    }
    const label = directory.startsWith('@') ? directory : `#${directory}`;
    this.db.prepare(`INSERT INTO slack_channels (workspace, channel_id, directory, label, is_im, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(workspace, channelId, directory, label, seen.isIm ? 1 : 0, this.iso());
    return this.channel(workspace, channelId)!;
  }

  has(workspace: string, channelId: string, ts: string): boolean {
    return this.row(workspace, channelId, ts) !== undefined;
  }

  /** The newest top-level message recorded in a channel: a fill-in asks Slack for what came after it. */
  cursor(workspace: string, channelId: string): string | undefined {
    const row = this.db.prepare(`SELECT ts FROM slack_messages WHERE workspace = ? AND channel_id = ? AND thread_ts IS NULL
      ORDER BY CAST(ts AS REAL) DESC LIMIT 1`).get(workspace, channelId) as { ts: string } | undefined;
    return row?.ts;
  }

  /**
   * Where a fetched image goes: beside the day's files, named by the message's local time. Returns the path on disk
   * and the one natsumi reads.
   */
  imagePath(workspace: string, channelId: string, ts: string, index: number, extension: string): { disk: string; shown: string } {
    const channel = this.channel(workspace, channelId)!;
    const { date, time } = this.local(ts);
    const name = `${date}-${time.replace(/:/g, '')}-${ts.split('.')[1] ?? '0'}-${index + 1}.${extension}`;
    return {
      disk: join(this.options.directory, workspace, channel.directory, 'files', name),
      shown: `${SLACK_PATH}/${workspace}/${channel.directory}/files/${name}`,
    };
  }

  /**
   * Records a message, or what changed in one already recorded, and writes its day's file and the index again.
   * `counted` says whether a new message waits to be shown in the updates. Returns whether it was new.
   */
  async record(workspace: string, channelId: string, message: ArchivedMessage, counted: boolean): Promise<boolean> {
    const existing = this.row(workspace, channelId, message.ts);
    const now = this.iso();
    const files = JSON.stringify(message.files);
    if (existing) {
      this.db.prepare(`UPDATE slack_messages SET text = ?, files = ?, edited = MAX(edited, ?), deleted = 0, updated_at = ?
        WHERE workspace = ? AND channel_id = ? AND ts = ?`)
        .run(message.text, files, message.edited ? 1 : 0, now, workspace, channelId, message.ts);
    } else {
      const parent = message.threadTs ? this.row(workspace, channelId, message.threadTs) : undefined;
      const fileDate = parent?.file_date ?? this.local(message.ts).date;
      this.db.prepare(`INSERT INTO slack_messages (workspace, channel_id, ts, thread_ts, speaker, own, text, files, edited, deleted,
        file_date, counted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
        .run(workspace, channelId, message.ts, message.threadTs ?? null, message.speaker, message.own ? 1 : 0, message.text, files,
          message.edited ? 1 : 0, fileDate, counted && !message.own ? 1 : 0, now, now);
    }
    await this.write(workspace, channelId, (existing ?? this.row(workspace, channelId, message.ts)!).file_date);
    return !existing;
  }

  /** A message deleted in Slack: its day's file is written again without it. */
  async remove(workspace: string, channelId: string, ts: string): Promise<void> {
    const row = this.row(workspace, channelId, ts);
    if (!row || row.deleted) return;
    this.db.prepare(`UPDATE slack_messages SET deleted = 1, counted = 0, updated_at = ? WHERE workspace = ? AND channel_id = ? AND ts = ?`)
      .run(this.iso(), workspace, channelId, ts);
    await this.write(workspace, channelId, row.file_date);
  }

  hasMention(workspace: string, channelId: string, ts: string): boolean {
    return this.db.prepare('SELECT 1 FROM slack_mentions WHERE workspace = ? AND channel_id = ? AND ts = ?')
      .get(workspace, channelId, ts) !== undefined;
  }

  /**
   * Ties a message to the event that hands it to natsumi, inside the event's own transaction. The event shows it, so
   * it no longer waits to be counted in the updates.
   */
  recordMention(eventId: string, workspace: string, channelId: string, ts: string, _transaction: Transaction): void {
    this.db.prepare('INSERT INTO slack_mentions (event_id, workspace, channel_id, ts) VALUES (?, ?, ?, ?)').run(eventId, workspace, channelId, ts);
    this.db.prepare('UPDATE slack_messages SET counted = 0 WHERE workspace = ? AND channel_id = ? AND ts = ?').run(workspace, channelId, ts);
  }

  /**
   * The line a mention or a DM becomes inside `<events>` (ADR 0039): the message, who said it, where, a reference
   * she can copy as it is to name it, the file it is in, and the flow before it — the thread's latest messages in a
   * thread, the channel's otherwise. Built from what is recorded now.
   */
  eventLine(eventId: string, receivedAt: string): Record<string, unknown> {
    const mention = this.db.prepare('SELECT workspace, channel_id, ts FROM slack_mentions WHERE event_id = ?').get(eventId) as
      { workspace: string; channel_id: string; ts: string } | undefined;
    const row = mention && this.row(mention.workspace, mention.channel_id, mention.ts);
    const channel = mention && this.channel(mention.workspace, mention.channel_id);
    if (!mention || !row || !channel) return { type: 'slack_mention', received_at: receivedAt };
    const { date, time } = this.local(row.ts);
    const where = `${mention.workspace}/${channel.label}`;
    const { messages, chars } = this.options.mentionContext;
    const before = row.thread_ts
      ? this.db.prepare(`SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND deleted = 0
          AND (ts = ? OR thread_ts = ?) AND CAST(ts AS REAL) < CAST(? AS REAL) ORDER BY CAST(ts AS REAL) DESC LIMIT ?`)
        .all(mention.workspace, mention.channel_id, row.thread_ts, row.thread_ts, row.ts, messages)
      : this.db.prepare(`SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND deleted = 0 AND thread_ts IS NULL
          AND CAST(ts AS REAL) < CAST(? AS REAL) ORDER BY CAST(ts AS REAL) DESC LIMIT ?`)
        .all(mention.workspace, mention.channel_id, row.ts, messages);
    const images = parseFiles(row.files).flatMap(file => file.path ? [file.path] : []);
    return {
      type: 'slack_mention', received_at: receivedAt, via: channel.is_im ? 'dm' : 'mention', channel: where, from: row.speaker,
      text: cut(row.text, MAX_MENTION_CHARS), reference: `${where} ${date} ${time} ${row.speaker}`,
      file: `${SLACK_PATH}/${mention.workspace}/${channel.directory}/${row.file_date}.md`,
      ...(row.thread_ts ? { in_thread: true } : {}),
      context: (before as unknown as MessageRow[]).reverse().map(item => {
        const at = this.local(item.ts);
        return { at: at.date === date ? at.time : `${at.date} ${at.time}`, from: item.speaker, text: cut(item.text, chars) };
      }),
      ...(images.length > 0 ? { images } : {}),
    };
  }

  /** The images of a mention, read now, as the model is given them beside its event. */
  async images(eventId: string): Promise<ImageContent[]> {
    const mention = this.db.prepare('SELECT workspace, channel_id, ts FROM slack_mentions WHERE event_id = ?').get(eventId) as
      { workspace: string; channel_id: string; ts: string } | undefined;
    const row = mention && this.row(mention.workspace, mention.channel_id, mention.ts);
    if (!row) return [];
    const images: ImageContent[] = [];
    for (const file of parseFiles(row.files).filter(file => file.path).slice(0, MAX_MENTION_IMAGES)) {
      try {
        const data = await readFile(join(this.options.directory, file.path!.slice(SLACK_PATH.length + 1)));
        const mimeType = imageType(data);
        if (mimeType) images.push({ type: 'image', mimeType, data: data.toString('base64') });
      } catch { /* a file cleared by hand is simply not shown */ }
    }
    return images;
  }

  /** What came since the updates were last shown, per channel, with the newest file of each; then counts from now. */
  take(): { new: Record<string, number>; files: string[] } | undefined {
    const rows = this.db.prepare(`SELECT m.workspace, c.label, c.directory, COUNT(*) AS n, MAX(m.file_date) AS latest
      FROM slack_messages m JOIN slack_channels c ON c.workspace = m.workspace AND c.channel_id = m.channel_id
      WHERE m.counted = 1 GROUP BY m.workspace, m.channel_id ORDER BY m.workspace, c.label`).all() as
      { workspace: string; label: string; directory: string; n: number; latest: string }[];
    if (rows.length === 0) return undefined;
    this.db.prepare('UPDATE slack_messages SET counted = 0 WHERE counted = 1').run();
    return {
      new: Object.fromEntries(rows.map(row => [`${row.workspace}/${row.label}`, row.n])),
      files: rows.map(row => `${SLACK_PATH}/${row.workspace}/${row.directory}/${row.latest}.md`),
    };
  }

  /**
   * Finds what a reference names: a channel by its label, and a message by its local date, time to the second, and
   * speaker. A message that is not there, or more than one that fit, is a sentence saying so; the second lists how
   * each begins so natsumi can tell them apart, and never their ts (ADR 0024).
   */
  resolve(reference: ParsedReference): { ok: true; target: ResolvedTarget } | { ok: false; text: string } {
    const channel = this.db.prepare('SELECT * FROM slack_channels WHERE workspace = ? AND label = ?').get(reference.workspace, reference.channel) as
      ChannelRow | undefined;
    const where = `${reference.workspace}/${reference.channel}`;
    if (!channel) return { ok: false, text: `チャンネル ${where} の記録がありません。/sources/slack/INDEX.md にあるチャンネルの名前で書いてください。` };
    const target: ResolvedTarget = { workspace: reference.workspace, channelId: channel.channel_id, label: `${reference.workspace}/${channel.label}` };
    if (!reference.at) return { ok: true, target };
    const { date, time } = reference.at;
    const guess = Date.parse(`${date}T${time}Z`) / 1000;
    if (Number.isNaN(guess)) return { ok: false, text: `${date} ${time} は日付と時刻として読めません。` };
    // Every time zone is within a day of UTC, so the local second is somewhere in these two days.
    const rows = (this.db.prepare(`SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND deleted = 0
      AND CAST(ts AS REAL) BETWEEN ? AND ? ORDER BY CAST(ts AS REAL)`)
      .all(reference.workspace, channel.channel_id, guess - 86_400, guess + 86_400) as unknown as MessageRow[])
      .filter(row => row.speaker === reference.speaker && (({ date: d, time: t }) => d === date && t === time)(this.local(row.ts)))
      .filter(row => reference.begins === undefined || oneLine(row.text).startsWith(reference.begins));
    const named = `${where} ${date} ${time} ${reference.speaker}${reference.begins === undefined ? '' : ` 「${reference.begins}」`}`;
    if (rows.length === 0) return { ok: false, text: `${named} の発言が記録に見つかりません。ファイルの見出しの時刻と発言者を、そのまま写してください。` };
    if (rows.length > 1) {
      const heads = rows.map(row => `「${cut(oneLine(row.text), 30)}」`).join('、');
      return { ok: false, text: `${named} の発言が ${rows.length} 件あり、どれか決められません（${heads}）。`
        + `返信先の最後に、返したい発言の書き出しを「」で添えてください（例: ${named} 「${cut(oneLine(rows[0]!.text), 10).replace(/…$/, '')}」）。` };
    }
    const row = rows[0]!;
    return { ok: true, target: { ...target, message: { ts: row.ts, ...(row.thread_ts ? { threadTs: row.thread_ts } : {}), speaker: row.speaker,
      at: `${date} ${time}`, text: row.text } } };
  }

  /**
   * What surrounds a target, oldest first, up to it: the thread's latest messages for a reply in a thread, and the
   * channel's latest top-level messages otherwise. Each is cut to `chars`.
   */
  around(target: ResolvedTarget, messages: number, chars: number): SeenMessage[] {
    const message = target.message;
    const rows = message?.threadTs
      ? this.db.prepare(`SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND deleted = 0 AND (ts = ? OR thread_ts = ?)
          AND CAST(ts AS REAL) <= CAST(? AS REAL) ORDER BY CAST(ts AS REAL) DESC LIMIT ?`)
        .all(target.workspace, target.channelId, message.threadTs, message.threadTs, message.ts, messages)
      : this.db.prepare(`SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND deleted = 0 AND thread_ts IS NULL
          AND CAST(ts AS REAL) <= CAST(? AS REAL) ORDER BY CAST(ts AS REAL) DESC LIMIT ?`)
        .all(target.workspace, target.channelId, message?.ts ?? '99999999999', messages);
    return (rows as unknown as MessageRow[]).reverse().map(row => {
      const { date, time } = this.local(row.ts);
      return { from: row.speaker, at: `${date} ${time}`, text: cut(row.text, chars) };
    });
  }

  /** How many top-level messages came in the channel after this one. */
  following(workspace: string, channelId: string, ts: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM slack_messages WHERE workspace = ? AND channel_id = ? AND deleted = 0
      AND thread_ts IS NULL AND CAST(ts AS REAL) > CAST(? AS REAL)`).get(workspace, channelId, ts) as { n: number }).n;
  }

  /** Whether a recorded message is still there: neither deleted in Slack nor unknown. */
  isPresent(workspace: string, channelId: string, ts: string): boolean {
    const row = this.row(workspace, channelId, ts);
    return row !== undefined && row.deleted === 0;
  }

  /** Makes the directory natsumi sees and the index, so an empty source still says so. */
  async prepare(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o750 });
    await this.enqueue(() => this.writeIndex());
  }

  private row(workspace: string, channelId: string, ts: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND ts = ?').get(workspace, channelId, ts) as
      MessageRow | undefined;
  }

  private write(workspace: string, channelId: string, date: string): Promise<void> {
    return this.enqueue(async () => {
      await this.writeDay(workspace, channelId, date);
      await this.writeIndex();
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.writing.then(work, work);
    this.writing = run.catch(() => undefined);
    return run;
  }

  /** One day of one channel, from the rows: parents in order, each with its replies indented under it. */
  private async writeDay(workspace: string, channelId: string, date: string): Promise<void> {
    const channel = this.channel(workspace, channelId)!;
    const rows = (this.db.prepare(`SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND file_date = ?
      ORDER BY CAST(ts AS REAL)`).all(workspace, channelId, date) as unknown as MessageRow[]);
    const parents = new Set(rows.filter(row => !row.thread_ts).map(row => row.ts));
    const replies = new Map<string, MessageRow[]>();
    for (const row of rows) {
      if (row.thread_ts && parents.has(row.thread_ts)) replies.set(row.thread_ts, [...replies.get(row.thread_ts) ?? [], row]);
    }
    const lines = [`# ${workspace}/${channel.label} ${date}`];
    for (const row of rows) {
      if (row.thread_ts && parents.has(row.thread_ts)) continue;
      const thread = (replies.get(row.ts) ?? []).filter(reply => !reply.deleted);
      if (row.deleted && thread.length === 0) continue;
      lines.push('', ...this.entry(row, date, ''));
      for (const reply of thread) lines.push('', ...this.entry(reply, date, '  '));
    }
    const path = join(this.options.directory, workspace, channel.directory, `${date}.md`);
    await mkdir(join(this.options.directory, workspace, channel.directory), { recursive: true, mode: 0o750 });
    await writeFileAtomically(path, `${lines.join('\n')}\n`, FILE_MODE);
  }

  private entry(row: MessageRow, fileDate: string, indent: string): string[] {
    const { date, time } = this.local(row.ts);
    const heading = `${indent}${indent ? '###' : '##'} ${date === fileDate ? time : `${date} ${time}`} ${row.speaker}`;
    if (row.deleted) return [heading, '', `${indent}（この発言は削除されました）`];
    // A line opening like a heading would pass for a message of its own, so it is escaped.
    const body = row.text.split('\n').map(line => `${indent}${/^\s*#/.test(line) ? '\\' : ''}${line}`);
    const files = parseFiles(row.files).map(file => `${indent}- ${file.path ? `画像: ${file.path}` : `添付あり（取り込まず）: ${oneLine(file.name)}`}`);
    return [heading, '', ...(row.text ? body : []), ...files, ...(row.edited ? [`${indent}（編集済み）`] : [])];
  }

  /** `INDEX.md`: every channel with when it last changed and its newest file. */
  private async writeIndex(): Promise<void> {
    const rows = this.db.prepare(`SELECT c.workspace, c.label, c.directory, MAX(CAST(m.ts AS REAL)) AS latest, MAX(m.file_date) AS file_date
      FROM slack_channels c LEFT JOIN slack_messages m ON m.workspace = c.workspace AND m.channel_id = c.channel_id
      GROUP BY c.workspace, c.channel_id ORDER BY c.workspace, c.label`).all() as
      { workspace: string; label: string; directory: string; latest: number | null; file_date: string | null }[];
    const lines = [
      '# Slack',
      '',
      'サーバーが書いている Slack の記録の目次です。チャンネルごとに、最後に発言が記録された時刻と、いちばん新しいファイルがあります。',
      '読み方は /manual/slack.md にあります。',
      '',
    ];
    if (rows.length === 0) lines.push('まだ記録しているチャンネルはありません。');
    else {
      lines.push('| チャンネル | 最後の発言 | いちばん新しいファイル |', '| --- | --- | --- |');
      for (const row of rows) {
        const last = row.latest === null ? '（まだなし）' : (({ date, time }) => `${date} ${time}`)(this.localMs(row.latest * 1000));
        const file = row.file_date ? `${SLACK_PATH}/${row.workspace}/${row.directory}/${row.file_date}.md` : '';
        lines.push(`| ${row.workspace}/${row.label} | ${last} | ${file} |`);
      }
    }
    await mkdir(this.options.directory, { recursive: true, mode: 0o750 });
    await writeFileAtomically(join(this.options.directory, 'INDEX.md'), `${lines.join('\n')}\n`, FILE_MODE);
  }

  /** A ts as natsumi's local date and time to the second. */
  private local(ts: string): { date: string; time: string } {
    return this.localMs(Math.floor(Number(ts) * 1000));
  }

  private localMs(ms: number): { date: string; time: string } {
    const parts = Object.fromEntries(this.clock.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
  }

  private iso(): string { return isoAt(this.options.now()); }
}

function parseFiles(json: string): { name: string; path?: string }[] {
  try { return JSON.parse(json) as { name: string; path?: string }[]; } catch { return []; }
}

/** A name that is safe as one directory: no separators, no control characters, no leading dot. */
function safeName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]+/g, '_').replace(/^\.+/, '_').trim().slice(0, 80);
  return cleaned === '' || cleaned === '@' ? `${cleaned}_` : cleaned;
}

function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function cut(text: string, max: number): string {
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : text;
}
