-- Don't store the same image twice in one article: uploads remember their
-- content hash and, for "Find screenshots" imports, the screenshot they came
-- from. Lookups go through idx_media_article (an article has few uploads).
ALTER TABLE media ADD COLUMN sha256 TEXT;
ALTER TABLE media ADD COLUMN source_url TEXT;
