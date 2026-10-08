-- The `slug` column follows the WORKING copy, so renaming a live article's
-- slug in a draft used to change how the public site looked it up before the
-- rename was published. `live_slug` is the slug the site actually serves
-- (NULL while unpublished); public lookups, comments and search use it.
ALTER TABLE articles ADD COLUMN live_slug TEXT;
UPDATE articles SET live_slug = json_extract(live_json, '$.slug') WHERE live_json IS NOT NULL;
-- Not UNIQUE: existing data is not guaranteed clean; the studio enforces it.
CREATE INDEX idx_articles_live_slug ON articles(live_slug);

-- Publishing checks no other live article owns the target markdown file.
CREATE INDEX idx_articles_git_path ON articles(git_path);

-- Studio list filters/sorts that used to scan the whole table.
CREATE INDEX idx_articles_author ON articles(author, updated_at);
CREATE INDEX idx_articles_score ON articles(score);
CREATE INDEX idx_articles_title ON articles(title COLLATE NOCASE);
