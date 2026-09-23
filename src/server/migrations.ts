import type { Migration } from './state-db.ts';

/**
 * natsumi-owned state in `.natsumi/state.sqlite`. The conversation shown to the owner lives here; the thinking loop's
 * own record (every event, thought and tool call) lives only in the Pi session JSONL (ADR 0008).
 * Append new migrations; never edit a released one. Approvals and other schedules are added
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
  {
    version: 7,
    name: 'self-checks',
    sql: `
      -- Checks natsumi booked for herself (ADR 0014). due_at is the absolute time the server resolved the booking to.
      -- A delivered check names the event that carried it; a cancelled one stays so it still counts for its day.
      CREATE TABLE self_checks (
        check_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        -- The reason normalized, to fold the same reason into one pending booking.
        reason_key TEXT NOT NULL,
        due_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'cancelled')),
        event_id TEXT REFERENCES loop_events (event_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((state = 'delivered') = (event_id IS NOT NULL))
      ) STRICT;
      CREATE INDEX self_checks_by_due ON self_checks (state, due_at);
      CREATE INDEX self_checks_by_creation ON self_checks (created_at);
      CREATE UNIQUE INDEX self_checks_one_pending_reason ON self_checks (reason_key) WHERE state = 'pending';
    `,
  },
  {
    version: 8,
    name: 'handoff-in-the-repository',
    sql: `
      -- The handoff moves to handoff.md in the memory repository, which is now the only place it is written and the
      -- only place a new session's instructions read it from (ADR 0020). What stays here is which commit of that file
      -- a switch started its session with, so the history can be followed back without holding the text twice.
      --
      -- The only copy of the handoff is about to go, so the newest one is set aside first: the start that follows
      -- this upgrade writes it into handoff.md and empties this table, and nothing ever fills it again.
      CREATE TABLE handoff_carryover (
        carryover INTEGER PRIMARY KEY CHECK (carryover = 1),
        handoff TEXT NOT NULL
      ) STRICT;
      INSERT INTO handoff_carryover (carryover, handoff)
        SELECT 1, handoff FROM session_rotations WHERE handoff IS NOT NULL
        ORDER BY updated_at DESC, rotation_id DESC LIMIT 1;

      -- SQLite drops a column by rebuilding the table. The invariant "a finished switch names a handoff commit" is
      -- deliberately not a CHECK: the switches already recorded were made before the file existed, their commit is
      -- NULL, and a table CHECK would reach back over them and fail this migration. NULL says truthfully that there
      -- was no file then. The code and its tests hold the invariant for the rows written from now on.
      CREATE TABLE session_rotations_new (
        rotation_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES loop_events (event_id),
        conversation_id TEXT NOT NULL REFERENCES conversations (conversation_id),
        from_session_id TEXT NOT NULL,
        from_session_file TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reviewing', 'switching', 'switched', 'failed')),
        -- The commit of handoff.md the new session's instructions were built from. NULL on the rows made before
        -- the file existed, and on a switch that has not written its handoff yet.
        handoff_commit TEXT,
        to_session_id TEXT UNIQUE,
        to_session_file TEXT UNIQUE,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (state <> 'switched' OR (to_session_id IS NOT NULL AND to_session_file IS NOT NULL))
      ) STRICT;
      INSERT INTO session_rotations_new (rotation_id, event_id, conversation_id, from_session_id, from_session_file,
        state, handoff_commit, to_session_id, to_session_file, reason, created_at, updated_at)
        SELECT rotation_id, event_id, conversation_id, from_session_id, from_session_file,
          state, NULL, to_session_id, to_session_file, reason, created_at, updated_at FROM session_rotations;
      DROP TABLE session_rotations;
      ALTER TABLE session_rotations_new RENAME TO session_rotations;
    `,
  },
  {
    version: 9,
    name: 'line-expression',
    sql: `
      -- The feeling natsumi chose for each of her lines, from the avatar expressions (ADR 0026). It is not the avatar's
      -- expression and never moves it. Only her lines carry one. The lines written before this have none and are not
      -- filled in: NULL reads as "not known", not as neutral.
      --
      -- Which values are allowed is kept by the tool and the server, not by a CHECK: the list grows with the avatar's
      -- expressions, and a CHECK here would make every such change a rebuild of this table.
      ALTER TABLE conversation_messages ADD COLUMN expression TEXT CHECK (expression IS NULL OR kind <> 'message');
    `,
  },
  {
    version: 10,
    name: 'push-registrations',
    sql: `
      -- Where to push a device that is not connected (ADR 0029): its APNs device token, the public key its pushes are
      -- encrypted to, and which APNs it belongs to. One per device, overwritten on every push.register; a token
      -- belongs to one device at a time. Only the public key is here: the device keeps its private key.
      -- Whether a device may still be sent to is not kept here: it follows the session the device last synced with.
      CREATE TABLE push_registrations (
        device_id TEXT PRIMARY KEY REFERENCES devices (device_id),
        token TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL CHECK (length(public_key) = 65),
        environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 11,
    name: 'replies-without-an-event',
    // The table is made anew, and loop_events, read_cursor and notice_acknowledgements point at it.
    foreignKeysOff: true,
    sql: `
      -- natsumi may speak to the owner as often as she has something to say, also when no owner message waits for an
      -- answer (ADR 0032). The reply that answers waiting messages still names the newest of them, and there is still
      -- at most one such reply per event: that is what keeps a message from being answered twice across a restart.
      -- Every other reply names no event. SQLite drops the CHECK that required one only by rebuilding the table; the
      -- rest of it, and every row, stays as it was.
      CREATE TABLE conversation_messages_new (
        message_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'natsumi')),
        kind TEXT NOT NULL CHECK (kind IN ('message', 'reply', 'notice')),
        text TEXT NOT NULL,
        -- An owner message: its event. A reply: the event of the newest message it answered, if it answered any.
        event_id TEXT,
        -- A notice: the JSON array of events it is about, if any.
        about_event_ids TEXT,
        request_id TEXT UNIQUE,
        device_id TEXT,
        created_at TEXT NOT NULL,
        expression TEXT CHECK (expression IS NULL OR kind <> 'message'),
        CHECK ((kind = 'message') = (role = 'owner')),
        CHECK (kind <> 'message' OR (event_id IS NOT NULL AND request_id IS NOT NULL AND device_id IS NOT NULL))
      ) STRICT;
      INSERT INTO conversation_messages_new (message_id, position, role, kind, text, event_id, about_event_ids,
        request_id, device_id, created_at, expression)
        SELECT message_id, position, role, kind, text, event_id, about_event_ids,
          request_id, device_id, created_at, expression FROM conversation_messages;
      DROP TABLE conversation_messages;
      ALTER TABLE conversation_messages_new RENAME TO conversation_messages;
      -- One reply that answers an event, even across restarts. The replies that answer none are not in the index.
      CREATE UNIQUE INDEX conversation_messages_one_reply ON conversation_messages (event_id) WHERE kind = 'reply';
    `,
  },
];
