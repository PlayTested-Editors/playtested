-- Studio article list, default order: drafts (not live) first, newest edit on
-- top, then everything else by publish date, newest first. The expression has
-- to match the ORDER BY in api/studio.ts exactly for SQLite to use the index.
CREATE INDEX idx_articles_list ON articles((live_json IS NULL) DESC, pub_date DESC, updated_at DESC);
