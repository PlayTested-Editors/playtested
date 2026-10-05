-- PlayTested Studio — initial schema.
-- Git stays the published source the static build reads; D1 holds the
-- editorial layer (working copies, revisions, review workflow, users) plus a
-- mirror of each published article for the live fallback and search.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  avatar        TEXT,
  author_name   TEXT,                       -- byline written into articles
  role          TEXT NOT NULL CHECK (role IN ('chief', 'editor', 'contributor')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE invites (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL COLLATE NOCASE,
  role             TEXT NOT NULL CHECK (role IN ('chief', 'editor', 'contributor')),
  author_name      TEXT,
  token_hash       TEXT NOT NULL UNIQUE,
  invited_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  accepted_at      INTEGER,
  accepted_user_id TEXT
);
CREATE INDEX idx_invites_email ON invites(email);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,                -- sha256 of the cookie token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- One-time sign-in links the chief editor can hand out (works without Google).
CREATE TABLE login_links (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE articles (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  collection    TEXT NOT NULL DEFAULT 'article',
  git_path      TEXT,                         -- e.g. src/content/article/foo.md
  -- Working copy (what editors are changing).
  draft_json    TEXT NOT NULL,
  draft_rev     INTEGER NOT NULL DEFAULT 1,   -- optimistic-lock counter
  state         TEXT NOT NULL CHECK (state IN ('draft', 'in_review', 'changes_requested', 'approved', 'published')),
  -- Live copy (what the site shows). NULL until first publish.
  live_json     TEXT,
  live_hash     TEXT,                         -- sha256 of the published markdown file (LF)
  pub_date      INTEGER,                      -- live pubDate in ms, for scheduling/visibility
  published_at  INTEGER,                      -- last studio publish, drives the live-fallback window
  publish_commit TEXT,                        -- commit sha of the last studio publish
  publish_commit_time INTEGER,
  -- Denormalised working-copy fields for fast listing/filtering.
  title         TEXT NOT NULL DEFAULT '',
  category      TEXT,
  author        TEXT,
  score         REAL,
  featured      INTEGER NOT NULL DEFAULT 0,
  thumb         TEXT,
  created_by    TEXT,
  updated_by    TEXT,
  assigned_to   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  locked_by     TEXT,                         -- soft edit lock (presence)
  locked_at     INTEGER
);
CREATE INDEX idx_articles_state ON articles(state, updated_at DESC);
CREATE INDEX idx_articles_updated ON articles(updated_at DESC);
CREATE INDEX idx_articles_pub ON articles(pub_date DESC);

CREATE TABLE revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  rev        INTEGER NOT NULL,
  data_json  TEXT NOT NULL,
  kind       TEXT NOT NULL,                   -- import|sync|save|submit|request_changes|approve|publish|unpublish|restore
  note       TEXT,
  user_id    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_revisions_article ON revisions(article_id, id DESC);

-- Editorial notes / review comments on an article.
CREATE TABLE notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id  TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_notes_article ON notes(article_id, id);

-- Uploaded images. Staged in R2 for previews; committed to git (blob_sha) on publish.
CREATE TABLE media (
  id          TEXT PRIMARY KEY,
  r2_key      TEXT NOT NULL UNIQUE,
  public_path TEXT NOT NULL UNIQUE,           -- /images/uploads/<file> once published
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  alt         TEXT,
  blob_sha    TEXT,                           -- git blob sha once uploaded to GitHub
  committed   INTEGER NOT NULL DEFAULT 0,     -- 1 once part of a published commit
  article_id  TEXT,
  uploaded_by TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_media_article ON media(article_id);
CREATE INDEX idx_media_created ON media(created_at DESC);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Daily counters (UTC day) for feature caps and the usage watchdog.
CREATE TABLE usage_daily (
  day    TEXT NOT NULL,
  metric TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

CREATE TABLE deploys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  reason       TEXT NOT NULL,                 -- publish|schedule|manual|unpublish
  status       TEXT NOT NULL,                 -- requested|running|success|failure|skipped
  commit_sha   TEXT,
  run_id       INTEGER,
  requested_by TEXT,
  message      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_deploys_created ON deploys(created_at DESC);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  meta       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- Search: one row per published article plus full-text chunks.
CREATE TABLE search_docs (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  description TEXT,
  category   TEXT,
  tags       TEXT,                            -- JSON array
  author     TEXT,
  score      REAL,
  pub_date   INTEGER,
  thumb      TEXT,
  hash       TEXT NOT NULL,                   -- content hash; skip re-index when unchanged
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX idx_search_docs_pub ON search_docs(pub_date DESC);

CREATE VIRTUAL TABLE search_fts USING fts5(
  slug UNINDEXED,
  idx UNINDEXED,
  title,
  heading,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
