import type { SlackApi, SlackConversation, SlackMessage, SlackSocket } from '../../src/server/slack-api.ts';

/** A PNG's first bytes, enough for the server to take a file for an image. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/** Slack's `ts` for a moment given in UTC. The fraction keeps two messages of the same second apart. */
export function tsAt(iso: string, fraction = '000100'): string {
  return `${Math.floor(Date.parse(iso) / 1000)}.${fraction}`;
}

/**
 * A stand-in for one Slack workspace: the Web API the server calls and the Socket Mode connection it listens on.
 * Nothing goes over the network. The test puts channels, users and messages in, and emits events as Slack would.
 */
export class FakeSlack implements SlackApi, SlackSocket {
  readonly botUserId = 'UBOT';
  readonly botId = 'BBOT';
  readonly channels = new Map<string, SlackConversation>();
  /** Every message of a channel, replies included (they carry `threadTs`). */
  readonly messages = new Map<string, SlackMessage[]>();
  readonly users = new Map<string, string>([['U1', '山田'], ['U2', '佐藤'], ['UBOT', 'natsumi']]);
  readonly files = new Map<string, Buffer>();
  readonly reactions: { channel: string; ts: string; name: string }[] = [];
  readonly historyCalls: { channel: string; oldest: string }[] = [];
  readonly downloads: string[] = [];
  started = 0;
  stopped = 0;
  private eventHandler: ((event: Record<string, unknown>) => void) | undefined;
  private connectedHandler: (() => void) | undefined;

  addChannel(conversation: SlackConversation): void {
    this.channels.set(conversation.id, conversation);
    if (!this.messages.has(conversation.id)) this.messages.set(conversation.id, []);
  }

  /** A message Slack already holds, as a backfill would find it. */
  post(channel: string, message: SlackMessage): void {
    this.messages.get(channel)!.push(message);
  }

  /** Slack sends an event over the socket. */
  emit(event: Record<string, unknown>): void { this.eventHandler?.(event); }

  /** Slack (re)connects: the server fills in what it missed. */
  connect(): void { this.connectedHandler?.(); }

  // SlackSocket

  onEvent(handler: (event: Record<string, unknown>) => void): void { this.eventHandler = handler; }
  onConnected(handler: () => void): void { this.connectedHandler = handler; }
  async start(): Promise<void> { this.started += 1; }
  async stop(): Promise<void> { this.stopped += 1; }

  // SlackApi

  async whoAmI() { return { userId: this.botUserId, botId: this.botId }; }

  async conversations(): Promise<SlackConversation[]> { return [...this.channels.values()]; }

  async conversation(id: string): Promise<SlackConversation> {
    const found = this.channels.get(id);
    if (!found) throw new Error('channel_not_found');
    return found;
  }

  async history(channel: string, oldest: string): Promise<SlackMessage[]> {
    this.historyCalls.push({ channel, oldest });
    const all = this.messages.get(channel) ?? [];
    return all
      .filter(message => (!message.threadTs || message.threadTs === message.ts) && Number(message.ts) > Number(oldest))
      .map(message => ({ ...message, replyCount: all.filter(reply => reply.threadTs === message.ts && reply.ts !== message.ts).length }));
  }

  async replies(channel: string, threadTs: string): Promise<SlackMessage[]> {
    const all = this.messages.get(channel) ?? [];
    return all.filter(message => message.ts === threadTs || message.threadTs === threadTs)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  async userName(userId: string): Promise<string> { return this.users.get(userId) ?? userId; }

  async addReaction(channel: string, ts: string, name: string): Promise<void> { this.reactions.push({ channel, ts, name }); }

  async download(url: string, maxBytes: number): Promise<Buffer | undefined> {
    this.downloads.push(url);
    const body = this.files.get(url);
    if (!body) throw new Error('not found');
    return body.length > maxBytes ? undefined : body;
  }
}
