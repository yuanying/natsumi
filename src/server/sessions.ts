import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isoAt as iso } from './nightly.ts';

/**
 * A client session ends this long after it was last used; when one ends the client logs in through GitHub again
 * (ADR 0006, made sliding by ADR 0030).
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A use within this long of the last renewal writes nothing: the end would move by less than this. */
export const SESSION_RENEW_INTERVAL_MS = 60 * 60 * 1000;

export interface IssuedSession { sessionId: string; token: string; expiresAt: string }
export interface VerifiedSession { sessionId: string; githubUserId: number; expiresAt: string }

interface Row { session_id: string; github_user_id: number; expires_at: string; revoked_at: string | null }

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Bearer sessions in `client_sessions`. The token is 256 random bits and only its SHA-256 is stored,
 * so a copy of the state database cannot be replayed as a session.
 */
export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  create(githubUserId: number): IssuedSession {
    const now = this.now();
    const token = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    const expiresAt = iso(now + SESSION_TTL_MS);
    this.db.prepare('DELETE FROM client_sessions WHERE expires_at <= ?').run(iso(now));
    this.db.prepare(`INSERT INTO client_sessions (session_id, token_hash, github_user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`).run(sessionId, hashToken(token), githubUserId, iso(now), expiresAt);
    return { sessionId, token, expiresAt };
  }

  /** The live session for `token`, or undefined when unknown, revoked, expired or not the allowed account. */
  verify(token: string, allowedUserId: number): VerifiedSession | undefined {
    if (!token) return undefined;
    const row = this.db.prepare('SELECT session_id, github_user_id, expires_at, revoked_at FROM client_sessions WHERE token_hash = ?')
      .get(hashToken(token)) as Row | undefined;
    if (!row || row.revoked_at !== null || row.github_user_id !== allowedUserId || Date.parse(row.expires_at) <= this.now()) return undefined;
    return { sessionId: row.session_id, githubUserId: row.github_user_id, expiresAt: row.expires_at };
  }

  /**
   * Records a use of a live session: its end moves to SESSION_TTL_MS from now, unless it was already moved within
   * SESSION_RENEW_INTERVAL_MS, in which case nothing is written. Returns the session's end either way, or undefined
   * when the session is unknown, revoked or expired, which are never brought back.
   */
  renew(sessionId: string): string | undefined {
    const now = this.now();
    this.db.prepare('UPDATE client_sessions SET expires_at = ? WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ? AND expires_at <= ?')
      .run(iso(now + SESSION_TTL_MS), sessionId, iso(now), iso(now + SESSION_TTL_MS - SESSION_RENEW_INTERVAL_MS));
    const row = this.db.prepare('SELECT expires_at, revoked_at FROM client_sessions WHERE session_id = ?').get(sessionId) as
      Pick<Row, 'expires_at' | 'revoked_at'> | undefined;
    if (!row || row.revoked_at !== null || Date.parse(row.expires_at) <= now) return undefined;
    return row.expires_at;
  }

  /** True when a live session was revoked by this call. */
  revoke(token: string): boolean {
    const result = this.db.prepare('UPDATE client_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(iso(this.now()), hashToken(token));
    return Number(result.changes) > 0;
  }
}
