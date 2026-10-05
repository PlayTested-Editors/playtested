/**
 * Build-time export of every article (including scheduled ones) for
 * scripts/sync-d1.mjs, which mirrors git content into the studio database.
 * Using Astro's own collection guarantees slugs match the site's URLs.
 * Excluded from deploys via public/.assetsignore.
 */
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

export const prerender = true;

export const GET: APIRoute = async () => {
  const entries = [...(await getCollection("article")), ...(await getCollection("submissions"))];
  const articles = entries.map((e) => ({
    collection: e.collection,
    id: e.id,
    slug: e.slug,
    gitPath: `src/content/${e.collection}/${e.id}`,
    data: {
      ...e.data,
      pubDate: e.data.pubDate instanceof Date ? e.data.pubDate.toISOString() : e.data.pubDate,
      slug: e.slug,
    },
    body: e.body,
  }));
  return new Response(JSON.stringify({ exportedAt: Date.now(), articles }), {
    headers: { "Content-Type": "application/json" },
  });
};
