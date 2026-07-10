ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;

CREATE INDEX IF NOT EXISTS posts_live_timeline_idx
  ON posts(deleted_at, created_at DESC);
