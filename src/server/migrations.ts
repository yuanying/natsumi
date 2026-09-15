import type { Migration } from './state-db.ts';

/**
 * natsumi-owned state in `.natsumi/state.sqlite`. The conversation shown to the owner lives here; the thinking loop's
 * own record (every event, thought and tool call) lives only in the Pi session JSONL (ADR 0008).
 * Append new migrations; never edit a released one. Approvals, schedules and notifications are added
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
  {
    version: 3,
    name: 'devices',
    sql: `
      -- Devices the server registered for the allowed GitHub account. A device ID names a client's event stream;
      -- it is never accepted as authentication.
      CREATE TABLE devices (
        device_id TEXT PRIMARY KEY,
        github_user_id INTEGER NOT NULL,
        client_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: 'thinking-loop',
    sql: `
      -- The per-turn send operations of the first design were never used; owner messages carry their request ID instead.
      DROP TABLE conversation_operations;

      -- What the owner sees: owner messages and what natsumi sent them through reply_to_mac and notify_owner.
      -- Thoughts, tool calls and other events stay in the Pi session, which is a different record (ADR 0008).
      CREATE TABLE conversation_messages (
        message_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'natsumi')),
        kind TEXT NOT NULL CHECK (kind IN ('message', 'reply', 'notice')),
        text TEXT NOT NULL,
        -- An owner message: its event. A reply: the event it answers.
        event_id TEXT,
        -- A notice: the JSON array of events it is about, if any.
        about_event_ids TEXT,
        request_id TEXT UNIQUE,
        device_id TEXT,
        created_at TEXT NOT NULL,
        CHECK ((kind = 'message') = (role = 'owner')),
        CHECK (kind <> 'message' OR (event_id IS NOT NULL AND request_id IS NOT NULL AND device_id IS NOT NULL)),
        CHECK (kind <> 'reply' OR event_id IS NOT NULL)
      ) STRICT;
      -- One reply per event, even across restarts.
      CREATE UNIQUE INDEX conversation_messages_one_reply ON conversation_messages (event_id) WHERE kind = 'reply';

      -- Inputs of the thinking loop and how far each got.
      CREATE TABLE loop_events (
        event_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        message_id TEXT REFERENCES conversation_messages (message_id),
        state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'replied', 'no-reply', 'failed')),
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX loop_events_by_state ON loop_events (state, created_at);
    `,
  },
  {
    version: 5,
    name: 'session-rotations',
    sql: `
      -- Nightly switches of the thinking loop's Pi session (ADR 0009). The old session file is kept; conversations
      -- points to the new one only once the switch is committed. A 'switching' row carries a handoff written before
      -- a stop, and the next start finishes that switch.
      CREATE TABLE session_rotations (
        rotation_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES loop_events (event_id),
        conversation_id TEXT NOT NULL REFERENCES conversations (conversation_id),
        from_session_id TEXT NOT NULL,
        from_session_file TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reviewing', 'switching', 'switched', 'failed')),
        -- What the review wrote for the next session. It goes into that session's instructions.
        handoff TEXT,
        to_session_id TEXT UNIQUE,
        to_session_file TEXT UNIQUE,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (state NOT IN ('switching', 'switched') OR handoff IS NOT NULL),
        CHECK (state <> 'switched' OR (to_session_id IS NOT NULL AND to_session_file IS NOT NULL))
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: 'read-state',
    sql: `
      -- How far the owner has read natsumi's replies: one cursor for every device (ADR 0013). It only moves forward.
      CREATE TABLE read_cursor (
        owner INTEGER PRIMARY KEY CHECK (owner = 1),
        message_id TEXT NOT NULL REFERENCES conversation_messages (message_id),
        -- The device that last moved it.
        device_id TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      -- Notices the owner has checked, one by one and apart from the cursor.
      CREATE TABLE notice_acknowledgements (
        message_id TEXT PRIMARY KEY REFERENCES conversation_messages (message_id),
        device_id TEXT,
        acknowledged_at TEXT NOT NULL
      ) STRICT;

      -- What already exists counts as read and checked, so an upgrade does not bring back old words as unread.
      INSERT INTO read_cursor (owner, message_id, device_id, updated_at)
        SELECT 1, message_id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM conversation_messages ORDER BY position DESC LIMIT 1;
      INSERT INTO notice_acknowledgements (message_id, device_id, acknowledged_at)
        SELECT message_id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM conversation_messages WHERE kind = 'notice';
    `,
  },
];
