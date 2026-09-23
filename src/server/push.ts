import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ApnsEnvironment, ApnsRequest, ApnsResponse } from './apns.ts';
import { isoAt } from './nightly.ts';
import { decodePublicKey, PUSH_TEXT_MAX_CHARS, pushPlaintext, sealPush } from './push-crypto.ts';
import { ReadState } from './read-state.ts';

/** APNs refuses a payload over 4 KiB. */
export const APNS_PAYLOAD_MAX_BYTES = 4096;
/** Waits before each further try of a push that met a 5xx, a 429 or a failed connection. Kept in memory only (ADR 0029). */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

/** Device tokens are hex. The bounds are loose: APNs does not promise a length, only that it is opaque. */
const DEVICE_TOKEN = /^(?:[0-9a-f]{2}){16,100}$/;

/**
 * What natsumi says on the lock screen for each kind of line she pushes, before the device replaces it with the
 * decrypted text. A new kind (approvals, later) is a new entry here.
 */
const ALERTS: Record<string, { title: string; body: string }> = {
  reply: { title: 'なつみ', body: '返事があります' },
  notice: { title: 'なつみ', body: '知らせがあります' },
};

export interface Registration { token: string; publicKey: Buffer; environment: ApnsEnvironment }
export interface PushTarget extends Registration { deviceId: string }

/** The payload of `push.register`, checked: a hex token, a P-256 public key in standard base64, and the environment. */
export function parseRegistration(payload: unknown): Registration | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { token, publicKey, environment } = payload as Record<string, unknown>;
  if (typeof token !== 'string' || !DEVICE_TOKEN.test(token.toLowerCase())) return undefined;
  if (environment !== 'sandbox' && environment !== 'production') return undefined;
  const key = decodePublicKey(publicKey);
  if (!key) return undefined;
  return { token: token.toLowerCase(), publicKey: key, environment };
}

/** Push registrations in `push_registrations`: one per device, and one device per token. */
export class PushRegistrations {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
  }

  /** Records the device's registration, replacing its previous one and taking the token from any other device. */
  save(deviceId: string, registration: Registration): void {
    const now = isoAt(this.now());
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM push_registrations WHERE token = ? AND device_id <> ?').run(registration.token, deviceId);
      this.db.prepare(`INSERT INTO push_registrations (device_id, token, public_key, environment, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (device_id) DO UPDATE SET token = excluded.token, public_key = excluded.public_key,
          environment = excluded.environment, updated_at = excluded.updated_at`)
        .run(deviceId, registration.token, registration.publicKey, registration.environment, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Registrations that may be sent to: the device's last session is still live, not revoked (a logout revokes it)
   * and of the allowed account. The device's own connection is for the caller to check.
   */
  targets(allowedUserId: number): PushTarget[] {
    const rows = this.db.prepare(`SELECT r.device_id, r.token, r.public_key, r.environment FROM push_registrations r
      JOIN devices d ON d.device_id = r.device_id
      JOIN client_sessions s ON s.session_id = d.client_session_id
      WHERE s.revoked_at IS NULL AND s.expires_at > ? AND s.github_user_id = ? AND d.github_user_id = ?
      ORDER BY r.device_id`).all(isoAt(this.now()), allowedUserId, allowedUserId) as
      { device_id: string; token: string; public_key: Uint8Array; environment: ApnsEnvironment }[];
    return rows.map(row => ({ deviceId: row.device_id, token: row.token, publicKey: Buffer.from(row.public_key), environment: row.environment }));
  }

  /** Drops the registration if it still holds this token; a device that registered a new one since keeps it. */
  remove(deviceId: string, token: string): boolean {
    return Number(this.db.prepare('DELETE FROM push_registrations WHERE device_id = ? AND token = ?').run(deviceId, token).changes) > 0;
  }
}

/** An event the loop shows the owner, as the hub receives it. */
export interface PushEvent { type: string; payload: Record<string, unknown> }

export interface PushNotifierOptions {
  db: DatabaseSync;
  loop: { subscribe(listener: (event: PushEvent) => void): () => void };
  registrations: PushRegistrations;
  sender: { send(request: ApnsRequest): Promise<ApnsResponse> };
  allowedUserId: number;
  /** Whether the device has a connection now; a connected device gets the event instead of a push. */
  isConnected: (deviceId: string) => boolean;
  /** Fixed lines naming devices and APNs answers only: never the text, a whole token or a key. */
  log: (line: string) => void;
  retryDelaysMs?: readonly number[];
}

/**
 * Pushes to the registered devices that are not connected (ADR 0029): an alert when natsumi records a reply or a
 * notice, and a background push when the read cursor moves or a notice is checked. Pushing happens after the
 * loop's event and apart from it: a failure is logged and never reaches the loop or the connections.
 */
export class PushNotifier {
  private readonly options: PushNotifierOptions;
  private readonly readState: ReadState;
  private readonly delays: readonly number[];
  private readonly timers = new Map<NodeJS.Timeout, () => void>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(options: PushNotifierOptions) {
    this.options = options;
    this.readState = new ReadState(options.db, Date.now);
    this.delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.unsubscribe = options.loop.subscribe(event => {
      setImmediate(() => {
        if (this.closed) return;
        try { this.handle(event); } catch (error) {
          this.options.log(`push: could not prepare a push for ${event.type} (${error instanceof Error ? error.name : 'error'})`);
        }
      });
    });
  }

  /** Stops listening and drops the tries still waiting. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
    for (const [timer, wake] of this.timers) { clearTimeout(timer); wake(); }
    this.timers.clear();
  }

  private handle(event: PushEvent) {
    const { type, payload } = event;
    if (type === 'conversation.message') {
      const alert = typeof payload.kind === 'string' ? ALERTS[payload.kind] : undefined;
      if (payload.role !== 'natsumi' || !alert || typeof payload.messageId !== 'string' || typeof payload.text !== 'string') return;
      const position = this.positionOf(payload.messageId);
      if (position === undefined) return;
      const expression = typeof payload.expression === 'string' ? payload.expression : undefined;
      const badge = this.badge();
      for (const target of this.awayTargets()) {
        const body = alertPayload({ alert, badge, messageId: payload.messageId, kind: payload.kind as string, position,
          text: payload.text, expression, devicePublicKey: target.publicKey });
        this.dispatch(target, { environment: target.environment, token: target.token, pushType: 'alert', payload: body, id: randomUUID() });
      }
      return;
    }
    if (type !== 'conversation.read' && type !== 'notification.acked') return;
    const { readThroughMessageId } = this.readState.position();
    const readThroughPosition = readThroughMessageId === null ? undefined : this.positionOf(readThroughMessageId);
    const body = {
      aps: { 'content-available': 1 },
      kind: type === 'conversation.read' ? 'read' : 'acked',
      badge: this.badge(),
      ...(readThroughPosition === undefined ? {} : { readThroughPosition }),
      ...(type === 'notification.acked' && typeof payload.notificationId === 'string' ? { notificationId: payload.notificationId } : {}),
    };
    for (const target of this.awayTargets()) {
      this.dispatch(target, { environment: target.environment, token: target.token, pushType: 'background', payload: body, id: randomUUID() });
    }
  }

  private awayTargets(): PushTarget[] {
    return this.options.registrations.targets(this.options.allowedUserId).filter(target => !this.options.isConnected(target.deviceId));
  }

  /** Unread replies and unchecked notices (ADR 0029 5). */
  private badge(): number {
    return this.readState.position().unreadReplyCount + this.readState.unacknowledgedNotificationIds().length;
  }

  private positionOf(messageId: string): number | undefined {
    const row = this.options.db.prepare('SELECT position FROM conversation_messages WHERE message_id = ?').get(messageId) as
      { position: number } | undefined;
    return row?.position;
  }

  private dispatch(target: PushTarget, request: ApnsRequest) {
    void this.deliver(target, request).catch(() => { /* deliver logs its own failures */ });
  }

  private async deliver(target: PushTarget, request: ApnsRequest): Promise<void> {
    const what = `${request.pushType} to ${target.deviceId}`;
    for (let attempt = 0; ; attempt += 1) {
      let failure: string;
      try {
        const { status, reason } = await this.options.sender.send(request);
        if (status === 200) return;
        if (status === 410 || (status === 400 && reason === 'BadDeviceToken')) {
          if (this.options.registrations.remove(target.deviceId, target.token)) {
            this.options.log(`push: removed the registration of ${target.deviceId} (${status}${reason ? ` ${reason}` : ''})`);
          }
          return;
        }
        if (status !== 429 && status < 500) {
          this.options.log(`push: ${what} was refused with ${status}${reason ? ` ${reason}` : ''}`);
          return;
        }
        failure = `${status}${reason ? ` ${reason}` : ''}`;
      } catch {
        failure = 'no answer';
      }
      const delay = this.delays[attempt];
      if (delay === undefined || this.closed) {
        this.options.log(`push: gave up ${what} after ${attempt + 1} tries (${failure})`);
        return;
      }
      await this.wait(delay);
      if (this.closed) return;
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, ms);
      timer.unref();
      this.timers.set(timer, resolve);
    });
  }
}

/**
 * An alert as ADR 0029 3 sets it out, the text encrypted to the device. The text is cut to 1000 characters, and
 * further when wide characters would still take the payload past APNs' limit.
 */
function alertPayload(input: {
  alert: { title: string; body: string }; badge: number; messageId: string; kind: string; position: number; text: string;
  expression: string | undefined; devicePublicKey: Buffer;
}): object {
  const build = (maxChars: number) => ({
    aps: { alert: input.alert, 'mutable-content': 1, badge: input.badge, sound: 'default' },
    messageId: input.messageId, kind: input.kind, position: input.position,
    e: sealPush({ devicePublicKey: input.devicePublicKey, messageId: input.messageId,
      plaintext: pushPlaintext({ text: input.text, expression: input.expression }, maxChars) }),
  });
  const fits = (payload: object) => Buffer.byteLength(JSON.stringify(payload)) <= APNS_PAYLOAD_MAX_BYTES;
  const whole = build(PUSH_TEXT_MAX_CHARS);
  if (fits(whole)) return whole;
  // The largest cut that fits. The size grows with the cut, so a binary search finds it.
  let low = 1;
  let high = PUSH_TEXT_MAX_CHARS - 1;
  let best = build(1);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const payload = build(middle);
    if (fits(payload)) { best = payload; low = middle + 1; } else high = middle - 1;
  }
  return best;
}
