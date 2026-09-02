-- Settings as key/value rather than columns, so adding a preference is a write
-- rather than a schema change.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);

-- One auto-reply per sender per cooldown. Someone who mails you four times at
-- midnight should get told once that you're asleep, not four times.
CREATE TABLE IF NOT EXISTS autoreplies (
  sender      TEXT PRIMARY KEY,
  last_ms     INTEGER NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_autoreplies_last ON autoreplies (last_ms DESC);
