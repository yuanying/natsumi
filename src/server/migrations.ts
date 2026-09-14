import type { Migration } from './state-db.ts';

/**
 * natsumi-owned state in `.natsumi/state.sqlite`. Conversation text lives only in Pi session JSONL (ADR 0001).
 * Append new migrations; never edit a released one. Approvals, schedules, notifications and devices are added
 * by the changes that implement them.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'conversations-and-operations',
    sql: `
      -- The app conversation and the Pi session it maps to. pi_session_file is relative to the Pi session directory.
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        pi_session_id TEXT NOT NULL UNIQUE,
        pi_session_file TEXT NOT NULL UNIQUE CHECK (
          pi_session_file <> '' AND substr(pi_session_file, 1, 1) <> '/'
          AND pi_session_file NOT LIKE '..%' AND pi_session_file NOT LIKE '%/..%'),
        created_at TEXT NOT NULL
      ) STRICT;

      -- conversation.send deduplication: request ID, sender, body hash (never the body) and progress.
      CREATE TABLE conversation_operations (
        request_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations (conversation_id),
        body_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        turn_id TEXT NOT NULL UNIQUE,
        pi_user_entry_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX conversation_operations_by_conversation ON conversation_operations (conversation_id, created_at);
    `,
  },
  {
    version: 2,
    name: 'client-sessions',
    sql: `
      -- Short-lived client sessions issued after GitHub login. Only the SHA-256 of the bearer token is kept, never the token.
      CREATE TABLE client_sessions (
        session_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        github_user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX client_sessions_by_expiry ON client_sessions (expires_at);
    `,
  },
];
