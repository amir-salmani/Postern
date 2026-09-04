-- The provider's id for a message we sent, so delivery events can be matched
-- back to it. Previously the Resend id was only reachable by parsing it out of
-- the synthesised Message-ID, which is fragile and would break the moment the
-- sender changes.
ALTER TABLE messages ADD COLUMN provider_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages (provider_id);
