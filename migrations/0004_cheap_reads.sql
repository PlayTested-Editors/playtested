-- Keep D1 row reads proportional to the work done (free plan: 5M rows read/day).
--
-- FTS5 columns can't be indexed, so lookups/deletes by slug scanned every
-- passage (~5.5k rows each). Passages are now keyed by rowid =
-- doc_id * 100 + chunk index, so they're found and deleted by key ranges.

DROP TABLE search_fts;
CREATE VIRTUAL TABLE search_fts USING fts5(
  slug UNINDEXED,
  idx UNINDEXED,
  title,
  heading,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

ALTER TABLE search_docs ADD COLUMN doc_id INTEGER;
UPDATE search_docs SET doc_id = rowid, hash = '';
CREATE UNIQUE INDEX idx_search_docs_doc ON search_docs(doc_id);

-- Index-friendly listing/filtering in the studio and the live fallback.
CREATE INDEX idx_articles_featured ON articles(featured, pub_date);
CREATE INDEX idx_articles_category ON articles(category, updated_at);
CREATE INDEX idx_articles_created_by ON articles(created_by, updated_at);
CREATE INDEX idx_articles_state_pub ON articles(state, pub_date);

-- Background re-indexing only runs when something changed. "text" rebuilds
-- the passages without re-embedding (the vectors are unaffected).
INSERT INTO settings (key, value, updated_at) VALUES ('index_dirty', 'text', 0)
  ON CONFLICT(key) DO UPDATE SET value = 'text';
