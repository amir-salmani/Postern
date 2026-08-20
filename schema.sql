-- Postern — D1 schema, Phase 1 (ingest only).
--
-- Design note: no message body lives here. The raw .eml goes to R2 and is
-- parsed in the browser, because Workers Free allows 10ms CPU per invocation
-- and parsing a multi-megabyte message would blow straight through it.
--
-- `id` is the Resend email id, so a retried webhook collides on the primary
-- key and is ignored rather than storing the same message twice.

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,   -- uuid, also the R2 object name
  r2_key        TEXT NOT NULL,      -- yyyy/mm/<id>.eml

  -- RFC 5322 threading. Captured at ingest because reconstructing it later
  -- is impossible without re-parsing every message in the mailbox.
  message_id    TEXT,
  in_reply_to   TEXT,
  refs          TEXT,               -- "references" is a SQLite keyword
  thread_id     TEXT NOT NULL,

  -- Envelope (SMTP-level, trustworthy) vs header (spoofable). Keep both.
  envelope_from TEXT NOT NULL,
  envelope_to   TEXT NOT NULL,
  header_from   TEXT,

  subject       TEXT,
  date_ms       INTEGER,            -- sender's Date: header, may be a lie
  received_ms   INTEGER NOT NULL,   -- when we got it, authoritative for sorting
  size_bytes    INTEGER NOT NULL,

  -- Cheap spam signal: Cloudflare stamps Authentication-Results on inbound.
  -- Reading it costs nothing; verifying it ourselves would cost everything.
  auth_results  TEXT,
  spf           TEXT,
  dkim          TEXT,
  dmarc         TEXT,

  folder        TEXT NOT NULL DEFAULT 'inbox',  -- inbox | quarantine | sent
  seen          INTEGER NOT NULL DEFAULT 0,
  has_attach    INTEGER NOT NULL DEFAULT 0      -- guessed from Content-Type
);

-- Mailbox listing: newest first within a folder.
CREATE INDEX IF NOT EXISTS idx_messages_folder_date
  ON messages (folder, received_ms DESC);

-- Thread assembly on open.
CREATE INDEX IF NOT EXISTS idx_messages_thread
  ON messages (thread_id, received_ms);

-- Reply-target lookup during ingest. Must be fast: it runs inside the
-- email handler, once per inbound message.
CREATE INDEX IF NOT EXISTS idx_messages_message_id
  ON messages (message_id);

-- Phase 4 will add an FTS5 table over subject + sender + extracted body text,
-- populated lazily on first open rather than at ingest.

-- Every webhook Resend sends, not just inbound mail. The endpoint is
-- subscribed to all event types, so this is where delivery, bounce, open and
-- complaint events for outbound mail end up — otherwise they'd be
-- acknowledged and thrown away.
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,   -- svix message id; makes retries idempotent
  type       TEXT NOT NULL,
  email_id   TEXT,
  created_ms INTEGER NOT NULL,
  summary    TEXT,               -- human-readable one-liner for the UI
  payload    TEXT NOT NULL       -- full event JSON, for anything not modelled
);

CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_events_email   ON events (email_id);
