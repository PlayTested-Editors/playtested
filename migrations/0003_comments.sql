-- Reader comments with Google sign-in. Readers are separate from studio users:
-- signing in to comment never grants studio access.

CREATE TABLE commenters (
  id          TEXT PRIMARY KEY,
  google_sub  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  avatar      TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE reader_sessions (
  id_hash      TEXT PRIMARY KEY,
  commenter_id TEXT NOT NULL REFERENCES commenters(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_reader_sessions_commenter ON reader_sessions(commenter_id);

CREATE TABLE comments (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL,
  parent_id    TEXT,
  commenter_id TEXT NOT NULL REFERENCES commenters(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'deleted')),
  created_at   INTEGER NOT NULL,
  edited_at    INTEGER,
  moderated_by TEXT,
  moderated_at INTEGER
);
CREATE INDEX idx_comments_slug ON comments(slug, created_at);
CREATE INDEX idx_comments_recent ON comments(created_at DESC);
CREATE INDEX idx_comments_status ON comments(status, created_at DESC);
