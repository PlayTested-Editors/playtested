/**
 * Build-time visibility filter for content collection entries.
 *
 * An entry is hidden only when it is scheduled for the future (`pubDate` later
 * than the build time). Drafting is handled by the editorial workflow —
 * unpublished entries are never merged into the build branch, so the live site
 * only ever contains published posts. A *published* post therefore always shows
 * once its pubDate arrives; the frontmatter `draft` flag does NOT hide it (that
 * would only ever hide something you already published). A rebuild after the
 * pubDate publishes a scheduled post (see .github/workflows/scheduled-publish.yml).
 *
 * Usage: `await getCollection("article", isVisible)`
 */
export function isVisible(entry: { data: { pubDate: Date } }): boolean {
  return new Date(entry.data.pubDate).getTime() <= Date.now();
}
