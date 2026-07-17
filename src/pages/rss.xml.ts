import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { isVisible } from "../lib/content";

export const GET = async ({ site }) => {
  const posts = await getCollection('article', isVisible);
  const items = posts
    .sort((a, b) => +b.data.pubDate - +a.data.pubDate)
    .map((p) => ({
      link: `/article/${p.slug}`,
      title: p.data.title,
      pubDate: p.data.pubDate,
      description: p.data.description,
    }));

  return rss({
    title: 'PlayTested.Net',
    description: 'Video Game Reviews, Tech Blog, and AI-powered insights for PC, Console, and Mobile. No-nonsense game reviews that cut through the noise.',
    site: site?.toString() ?? 'https://playtested.net',
    items
  });
};
