/**
 * Build-time visibility filter for content collection entries.
 *
 * An entry is hidden when it is a draft (`draft: true`) or scheduled for the
 * future (`pubDate` later than the build time). Draft and scheduled posts are
 * excluded from the build entirely — pages, listings, RSS, sitemap and the
 * search/RAG indexes. A rebuild that runs after the `pubDate` publishes them
 * (see .github/workflows/scheduled-publish.yml).
 *
 * Usage: `await getCollection("article", isVisible)`
 */
export function isVisible(entry: { data: { draft?: boolean; pubDate: Date } }): boolean {
  if (entry.data.draft === true) return false;
  return new Date(entry.data.pubDate).getTime() <= Date.now();
}
