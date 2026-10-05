import { getCollection } from "astro:content";
import { isVisible } from "../lib/content";

/**
 * Static index behind the search page's instant, as-you-type results
 * (MiniSearch in the browser — free, no Worker call). Metadata only, with the
 * same field names as /api/search results; full-text search is /api/search.
 * Prerendered every build, so it always matches the built articles and slugs.
 */
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s || "");

export async function GET() {
  const articles = await getCollection("article", isVisible);
  const submissions = await getCollection("submissions", isVisible);

  const index = [...articles, ...submissions]
    .map((post) => ({
      slug: post.slug,
      title: post.data.title,
      description: clip(post.data.description, 160),
      game: post.data.game ?? "",
      category: post.data.category ?? "",
      tags: post.data.tags ?? [],
      score: typeof post.data.score === "number" ? post.data.score : null,
      thumb: post.data.thumb || post.data.large || null,
      pubDate: new Date(post.data.pubDate).getTime(),
    }))
    .sort((a, b) => b.pubDate - a.pubDate);

  return new Response(JSON.stringify(index), {
    headers: { "Content-Type": "application/json" },
  });
}
