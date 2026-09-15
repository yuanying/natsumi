import type { DatabaseSync } from 'node:sqlite';

/** Where the read cursor stands, and the unread replies after it. */
export interface ReadPosition {
  readThroughMessageId: string | null;
  unreadReplyCount: number;
}

/**
 * What the owner has checked, kept on the server so every device agrees (ADR 0013).
 *
 * Replies are read up to one cursor that only moves forward. Notices are acknowledged one by one; the cursor
 * passing a notice does not acknowledge it. Owner messages are never unread.
 */
export class ReadState {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
  }

  position(): ReadPosition {
    const cursor = this.db.prepare(`SELECT c.message_id, m.position FROM read_cursor c
      JOIN conversation_messages m ON m.message_id = c.message_id`).get() as { message_id: string; position: number } | undefined;
    const unread = this.db.prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE kind = 'reply' AND position > ?`)
      .get(cursor?.position ?? 0) as { n: number };
    return { readThroughMessageId: cursor?.message_id ?? null, unreadReplyCount: unread.n };
  }

  /** Every notice not acknowledged yet, oldest first, however far back. */
  unacknowledgedNotificationIds(): string[] {
    return (this.db.prepare(`SELECT m.message_id FROM conversation_messages m
      LEFT JOIN notice_acknowledgements a ON a.message_id = m.message_id
      WHERE m.kind = 'notice' AND a.message_id IS NULL ORDER BY m.position`).all() as { message_id: string }[]).map(row => row.message_id);
  }

  /**
   * Moves the cursor to a message if it is ahead of the current one. A position behind it, sent late by another
   * device, changes nothing. Undefined when there is no such message.
   */
  markRead(messageId: string, deviceId: string): (ReadPosition & { changed: boolean }) | undefined {
    const target = this.db.prepare('SELECT position FROM conversation_messages WHERE message_id = ?').get(messageId) as
      { position: number } | undefined;
    if (!target) return undefined;
    const changed = Number(this.db.prepare(`INSERT INTO read_cursor (owner, message_id, device_id, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT (owner) DO UPDATE SET message_id = excluded.message_id, device_id = excluded.device_id, updated_at = excluded.updated_at
      WHERE ? > (SELECT position FROM conversation_messages WHERE message_id = read_cursor.message_id)`)
      .run(messageId, deviceId, this.iso(), target.position).changes) > 0;
    return { ...this.position(), changed };
  }

  /** Records a notice as checked once; later calls return the first record. Undefined when it is not a notice. */
  acknowledge(notificationId: string, deviceId: string): { acknowledgedAt: string; changed: boolean } | undefined {
    const notice = this.db.prepare(`SELECT 1 FROM conversation_messages WHERE message_id = ? AND kind = 'notice'`).get(notificationId);
    if (notice === undefined) return undefined;
    const changed = Number(this.db.prepare(`INSERT INTO notice_acknowledgements (message_id, device_id, acknowledged_at) VALUES (?, ?, ?)
      ON CONFLICT (message_id) DO NOTHING`).run(notificationId, deviceId, this.iso()).changes) > 0;
    const row = this.db.prepare('SELECT acknowledged_at FROM notice_acknowledgements WHERE message_id = ?').get(notificationId) as
      { acknowledged_at: string };
    return { acknowledgedAt: row.acknowledged_at, changed };
  }

  private iso() { return new Date(this.now()).toISOString(); }
}
