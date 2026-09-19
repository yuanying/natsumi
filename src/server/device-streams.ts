import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isoAt } from './nightly.ts';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_STREAM_BUFFER_SIZE = 256;

/**
 * One numbered event stream. Every event gets the next `seq`; the latest `capacity` events stay in memory so a
 * client that reconnects in the same epoch can receive what it missed. The buffer is never persisted.
 */
export class EventStream {
  readonly streamId = randomUUID();
  /** The connection currently receiving this stream, if any. */
  sink: ((text: string) => void) | undefined;
  private readonly epoch: string;
  private readonly capacity: number;
  private readonly events: { seq: number; text: string }[] = [];
  private seq = 0;

  constructor(epoch: string, capacity: number) {
    this.epoch = epoch;
    this.capacity = capacity;
  }

  publish(type: string, payload: Record<string, unknown>, requestId?: string): void {
    this.seq += 1;
    const text = JSON.stringify({
      v: PROTOCOL_VERSION, epoch: this.epoch, streamId: this.streamId, seq: this.seq, type,
      ...(requestId === undefined ? {} : { requestId }), payload,
    });
    this.events.push({ seq: this.seq, text });
    if (this.events.length > this.capacity) this.events.shift();
    this.sink?.(text);
  }

  /**
   * Sends an event of the moment to whoever is listening now: it takes no number of its own and is not kept for
   * replay (ADR 0017). It carries the number the stream is at, which a client that does not know the type has
   * already seen, so an older client ignores it instead of reading a gap into the stream.
   */
  publishEphemeral(type: string, payload: Record<string, unknown>): void {
    if (!this.sink) return;
    this.sink(JSON.stringify({ v: PROTOCOL_VERSION, epoch: this.epoch, streamId: this.streamId, seq: this.seq, type, payload }));
  }

  /** Every event after `seq`, or undefined when any of them is no longer buffered or `seq` is not one this stream issued. */
  replayAfter(seq: unknown): string[] | undefined {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > this.seq) return undefined;
    if (seq === this.seq) return [];
    const oldest = this.events[0]?.seq;
    if (oldest === undefined || oldest > seq + 1) return undefined;
    return this.events.filter(event => event.seq > seq).map(event => event.text);
  }
}

/** Devices registered in SQLite and their streams for this process epoch. */
export class DeviceStreams {
  private readonly db: DatabaseSync;
  private readonly epoch: string;
  private readonly capacity: number;
  private readonly streams = new Map<string, EventStream>();

  constructor(db: DatabaseSync, epoch: string, capacity: number) {
    this.db = db;
    this.epoch = epoch;
    this.capacity = capacity;
  }

  /**
   * The device ID to use for an authenticated client session. A requested ID is kept only when the server issued it
   * to the same GitHub account; anything else gets a new registration rather than being adopted.
   */
  register(requested: unknown, githubUserId: number, clientSessionId: string): string {
    const now = isoAt(Date.now());
    if (typeof requested === 'string') {
      const row = this.db.prepare('SELECT github_user_id FROM devices WHERE device_id = ?').get(requested) as { github_user_id: number } | undefined;
      if (row?.github_user_id === githubUserId) {
        this.db.prepare('UPDATE devices SET client_session_id = ?, last_seen_at = ? WHERE device_id = ?').run(clientSessionId, now, requested);
        return requested;
      }
    }
    const deviceId = `device-${randomUUID()}`;
    this.db.prepare(`INSERT INTO devices (device_id, github_user_id, client_session_id, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)`).run(deviceId, githubUserId, clientSessionId, now, now);
    return deviceId;
  }

  /** The device's stream in this epoch, created on first use. */
  stream(deviceId: string): EventStream {
    let stream = this.streams.get(deviceId);
    if (!stream) {
      stream = new EventStream(this.epoch, this.capacity);
      this.streams.set(deviceId, stream);
    }
    return stream;
  }

  /** Numbers the event separately on every device stream of this epoch, connected or not. */
  broadcast(type: string, payload: Record<string, unknown>, requestId?: string): void {
    for (const stream of this.streams.values()) stream.publish(type, payload, requestId);
  }

  /** Sends an event of the moment to every device connected now, without numbering or keeping it (ADR 0017). */
  broadcastEphemeral(type: string, payload: Record<string, unknown>): void {
    for (const stream of this.streams.values()) stream.publishEphemeral(type, payload);
  }
}
