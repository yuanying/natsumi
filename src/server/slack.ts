import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Transaction } from './conversation-store.ts';
import type { ArchivedMessage, ChannelRow, SlackArchive } from './slack-archive.ts';
import { toSlackMessage, type SlackApi, type SlackMessage, type SlackSocket } from './slack-api.ts';
import { imageType } from './view.ts';

/** The images the server fetches. Anything else attached is only noted. */
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** The subtypes that are someone saying something. Joins, topic changes and the like are not recorded. */
const SPOKEN = new Set([undefined, 'file_share', 'thread_broadcast', 'bot_message', 'me_message']);

/** Hands the loop a mention as a new event; the caller's rows go into the event's own transaction. */
export type RaiseSlackMention = (record: (eventId: string, transaction: Transaction) => void) => void;

export interface SlackWorkspaceOptions {
  /** The workspace's name in the config, and in every path and reference natsumi reads. */
  name: string;
  api: SlackApi;
  socket: SlackSocket;
  archive: SlackArchive;
  raise: RaiseSlackMention;
  /** Put on a mention or a DM as it arrives, by the server alone (ADR 0039). */
  reaction: string;
  backfillDays: number;
  maxImageBytes: number;
  now: () => number;
  log?: (line: string) => void;
}

/**
 * One Slack workspace, received (ADR 0012, ADR 0039). Every message of the channels the bot is in goes into the
 * archive; a real mention of the bot, or a DM, also becomes an event, and gets the server's reaction as it arrives.
 * Slack's own retries and its twin `app_mention` event make no second event: one message makes one, whichever way
 * and however often it comes.
 *
 * On every (re)connection each channel is filled in from its last recorded message. What happens here happens in
 * order, one thing at a time, so a fill-in and the live events never write the same day at once.
 *
 * The log names the workspace and the kind of failure, never what anyone said.
 */
export class SlackWorkspace {
  private readonly options: SlackWorkspaceOptions;
  private self: { userId: string; botId?: string } | undefined;
  private readonly names = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(options: SlackWorkspaceOptions) { this.options = options; }

  async start(): Promise<void> {
    const { api, socket } = this.options;
    this.self = await api.whoAmI();
    socket.onEvent(event => this.enqueue('an event', () => this.handle(event)));
    socket.onConnected(() => this.enqueue('a fill-in', () => this.backfill()));
    await socket.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try { await this.options.socket.stop(); } catch { /* going away either way */ }
    await this.idle();
  }

  /** Resolves once everything received so far has been handled. */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do { current = this.chain; await current; } while (current !== this.chain);
  }

  private enqueue(what: string, work: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (this.stopped) return;
      try { await work(); } catch (error) {
        this.log(`handling ${what} failed (${error instanceof Error ? error.name : 'error'})`);
      }
    });
  }

  private async handle(event: Record<string, unknown>): Promise<void> {
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    const channelId = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelId) return;
    const { archive, name } = this.options;
    const subtype = typeof event.subtype === 'string' ? event.subtype : undefined;
    if (subtype === 'message_deleted') {
      if (typeof event.deleted_ts === 'string') await archive.remove(name, channelId, event.deleted_ts);
      return;
    }
    const channel = await this.channel(channelId);
    if (subtype === 'message_changed') {
      const changed = event.message && typeof event.message === 'object' ? toSlackMessage(event.message as Record<string, unknown>) : undefined;
      // An edit changes the file, never raises: what she was handed once is not handed again.
      if (changed?.ts) await archive.record(name, channelId, { ...await this.archived(channel, changed), edited: true }, true);
      return;
    }
    if (!SPOKEN.has(subtype)) return;
    await this.receive(channel, toSlackMessage(event), { live: true, mayRaise: true });
  }

  /**
   * Fills in every channel from its last recorded message, and one never recorded from `backfillDays` back. Nothing
   * recorded is removed. A first fill-in raises no mention: they are old news, and natsumi finds them in the files.
   */
  private async backfill(): Promise<void> {
    const { api, archive, name } = this.options;
    let filled = 0;
    for (const conversation of await api.conversations()) {
      if (this.stopped) return;
      const channel = await this.channel(conversation.id, conversation);
      const cursor = archive.cursor(name, conversation.id);
      const oldest = cursor ?? String(Math.floor(this.options.now() / 1000) - this.options.backfillDays * 86_400);
      for (const message of await api.history(conversation.id, oldest)) {
        if (!SPOKEN.has(message.subtype)) continue;
        if (await this.receive(channel, message, { live: false, mayRaise: cursor !== undefined })) filled += 1;
        if (!message.replyCount) continue;
        for (const reply of await api.replies(conversation.id, message.ts)) {
          if (reply.ts === message.ts || !SPOKEN.has(reply.subtype)) continue;
          if (await this.receive(channel, reply, { live: false, mayRaise: cursor !== undefined })) filled += 1;
        }
      }
    }
    if (filled > 0) this.log(`filled in ${filled} message(s)`);
  }

  /** Records one message and, when it is for her, raises it once. Returns whether it was new. */
  private async receive(channel: ChannelRow, message: SlackMessage, how: { live: boolean; mayRaise: boolean }): Promise<boolean> {
    const { archive, name } = this.options;
    if (!message.ts) return false;
    const reply = message.threadTs && message.threadTs !== message.ts ? message.threadTs : undefined;
    if (reply && !archive.has(name, channel.channel_id, reply)) await this.fetchParent(channel, reply, message.ts);
    const isNew = await archive.record(name, channel.channel_id, { ...await this.archived(channel, message), ...(reply ? { threadTs: reply } : {}) }, true);
    if (!how.mayRaise || !(isNew || how.live) || !this.forHer(channel, message)) return isNew;
    if (archive.hasMention(name, channel.channel_id, message.ts)) return isNew;
    this.options.raise((eventId, transaction) => archive.recordMention(eventId, name, channel.channel_id, message.ts, transaction));
    try { await this.options.api.addReaction(channel.channel_id, message.ts, this.options.reaction); } catch {
      this.log('the reaction could not be added');
    }
    return isNew;
  }

  /** A reply to a thread recorded nowhere: its parent is fetched and recorded, not counted, so the reply has a place. */
  private async fetchParent(channel: ChannelRow, threadTs: string, except: string): Promise<void> {
    const thread = await this.options.api.replies(channel.channel_id, threadTs);
    const parent = thread.find(message => message.ts === threadTs);
    if (parent && parent.ts !== except) {
      await this.options.archive.record(this.options.name, channel.channel_id, await this.archived(channel, parent), false);
    }
  }

  /** A real mention of the bot, or a DM, from a person. No bot raises an event, her own least of all. */
  private forHer(channel: ChannelRow, message: SlackMessage): boolean {
    const self = this.self!;
    if (message.botId || !message.user || message.user === self.userId) return false;
    return channel.is_im === 1 || message.text.includes(`<@${self.userId}>`);
  }

  private async channel(channelId: string, known?: { name?: string; isIm: boolean; user?: string }): Promise<ChannelRow> {
    const { archive, api, name } = this.options;
    const existing = archive.channel(name, channelId);
    if (existing) return existing;
    const conversation = known ?? await api.conversation(channelId);
    const userName = conversation.isIm && conversation.user ? await this.userName(conversation.user) : undefined;
    return archive.addChannel(name, channelId, { ...(conversation.name ? { name: conversation.name } : {}), isIm: conversation.isIm,
      ...(userName ? { userName } : {}) });
  }

  private async archived(channel: ChannelRow, message: SlackMessage): Promise<ArchivedMessage> {
    const self = this.self!;
    const own = message.user === self.userId || (self.botId !== undefined && message.botId === self.botId);
    const speaker = message.user ? await this.userName(message.user) : message.username ?? 'bot';
    return {
      ts: message.ts, speaker, own, text: await this.plainText(message.text), edited: message.edited === true,
      files: await this.files(channel, message),
    };
  }

  /** Slack's markup as natsumi reads it: names instead of IDs, links with their address. */
  private async plainText(text: string): Promise<string> {
    const users = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map(match => match[1]!);
    for (const user of new Set(users)) await this.userName(user);
    return text
      .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, user: string) => `@${this.names.get(user) ?? 'someone'}`)
      .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `#${label || this.options.archive.channel(this.options.name, id)?.directory || 'channel'}`)
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label?: string) => label || '@group')
      .replace(/<!date\^[^|>]*\|([^>]*)>/g, '$1')
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
      .replace(/<mailto:[^|>]*\|([^>]*)>/g, '$1')
      .replace(/<([a-z][a-z0-9+.-]*:[^|>]*)\|([^>]*)>/g, '$2（$1）')
      .replace(/<([a-z][a-z0-9+.-]*:[^>]*)>/g, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  /** Images within the limit are fetched beside the day's file; the rest are only noted by name. */
  private async files(channel: ChannelRow, message: SlackMessage): Promise<ArchivedMessage['files']> {
    const noted: ArchivedMessage['files'] = [];
    for (const [index, file] of message.files.entries()) {
      const extension = IMAGE_TYPES[file.mimetype];
      if (!extension || file.size > this.options.maxImageBytes || !file.url) { noted.push({ name: file.name }); continue; }
      const path = this.options.archive.imagePath(this.options.name, channel.channel_id, message.ts, index, extension);
      if (await exists(path.disk)) { noted.push({ name: file.name, path: path.shown }); continue; }
      try {
        const body = await this.options.api.download(file.url, this.options.maxImageBytes);
        if (!body || !imageType(body)) { noted.push({ name: file.name }); continue; }
        await mkdir(dirname(path.disk), { recursive: true, mode: 0o750 });
        await writeFile(path.disk, body, { mode: 0o640 });
        noted.push({ name: file.name, path: path.shown });
      } catch {
        this.log('an image could not be fetched');
        noted.push({ name: file.name });
      }
    }
    return noted;
  }

  private async userName(userId: string): Promise<string> {
    const known = this.names.get(userId);
    if (known) return known;
    let name: string;
    try { name = (await this.options.api.userName(userId)).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || 'someone'; } catch {
      return 'someone';
    }
    this.names.set(userId, name);
    return name;
  }

  private log(line: string) { this.options.log?.(`slack (${this.options.name}): ${line}`); }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
