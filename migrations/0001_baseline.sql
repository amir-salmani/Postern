-- Baseline: the schema as it existed on 2026-08-30, captured from the live
-- database rather than reconstructed by hand. IF NOT EXISTS throughout so
-- applying it to the existing database records the version without changing
-- anything, and a fresh deploy gets the identical shape.

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
, reminded_ms INTEGER, trashed_ms INTEGER, forwarded_ms INTEGER);

CREATE INDEX IF NOT EXISTS idx_messages_folder_date
  ON messages (folder, received_ms DESC);

CREATE INDEX IF NOT EXISTS idx_messages_thread
  ON messages (thread_id, received_ms);

CREATE INDEX IF NOT EXISTS idx_messages_message_id
  ON messages (message_id);

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

CREATE TABLE IF NOT EXISTS tombstones (id TEXT PRIMARY KEY, deleted_ms INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT, content_type TEXT, size_bytes INTEGER, r2_key TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(id UNINDEXED, subject, sender, body);

CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, kind TEXT NOT NULL, pattern TEXT NOT NULL, action TEXT NOT NULL, created_ms INTEGER NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_pattern ON rules (kind, pattern);
