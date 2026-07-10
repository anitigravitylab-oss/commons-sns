PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_key TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  password_hash TEXT,
  password_salt TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  reply_to_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'followers')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS posts_author_created_idx ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_reply_to_idx ON posts(reply_to_id, created_at ASC);
CREATE INDEX IF NOT EXISTS posts_live_timeline_idx ON posts(deleted_at, created_at DESC);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

CREATE INDEX IF NOT EXISTS follows_following_idx ON follows(following_id, created_at DESC);

CREATE TABLE IF NOT EXISTS post_reactions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('like', 'repost', 'bookmark')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, post_id, kind)
);

CREATE INDEX IF NOT EXISTS reactions_post_kind_idx ON post_reactions(post_id, kind);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS media_post_idx ON media(post_id);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

INSERT OR IGNORE INTO users (id, handle, display_name, bio, role) VALUES
  ('user_commons', 'commons_dev', 'Commons 開発チーム', 'Commonsの公開開発アカウントです。', 'admin'),
  ('user_aoi', 'aoi_note', 'あおい', '', 'user'),
  ('user_yuu', 'yuu_builds', '朝倉ユウ', '', 'user'),
  ('user_minato', 'minato', 'みなと', '', 'user');

INSERT OR IGNORE INTO posts (id, author_id, body, created_at) VALUES
  ('post_001', 'user_commons', 'Commonsの最初の公開開発が始まりました。使う人が、次の機能を提案し、議論し、ときには自分で実装できるSNSを目指します。最初のテーマは「タイムラインに何を足さないか」です。', datetime('now', '-18 minutes')),
  ('post_002', 'user_aoi', '新しいSNSなのに、最初から操作を覚え直さなくていいのがうれしい。見慣れた形のまま、空気だけ少し穏やかになった感じ。', datetime('now', '-42 minutes')),
  ('post_003', 'user_yuu', '提案 #12「投稿の公開範囲をあとから変更できるようにする」に仕様案を書きました。実装に参加したい人、特にアクセシビリティの観点からレビューしてくれる人を募集中です。', datetime('now', '-1 hour')),
  ('post_004', 'user_minato', '小さいサービスだからできることって、機能の多さじゃなくて、運営と利用者の距離が近いことなのかもしれない。', datetime('now', '-2 hours'));

CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_initial.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_auth.sql');
