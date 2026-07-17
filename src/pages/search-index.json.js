import { getCollection } from "astro:content";
import { isVisible } from "../lib/content";

export async function GET() {
  const articles = await getCollection("article", isVisible);
  const submissions = await getCollection("submissions", isVisible);
  const allPosts = [...articles, ...submissions];

  const searchIndex = allPosts.map((post) => ({
    id: `${post.collection}-${post.slug}`,
    title: post.data.title,
    description: post.data.description ?? "",
    tags: post.data.tags?.join(", ") ?? "",
    body: post.body,
    url: `/${post.collection}/${post.slug}/`,
    pubDate: post.data.pubDate,
  }));

  return new Response(JSON.stringify(searchIndex), {
    headers: {
      "Content-Type": "application/json",
    },
  });
}