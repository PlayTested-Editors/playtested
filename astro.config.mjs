// astro.config.mjs
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import svelte from "@astrojs/svelte";
import cloudflare from "@astrojs/cloudflare";

/**
 * Article-body images sit below the title and gallery, so let the browser defer
 * them. Bodies mostly use raw `<img>` HTML, which is still a `raw` node when
 * user rehype plugins run (rehype-raw comes later), so both forms are handled.
 */
function rehypeLazyImages() {
  const lazyRaw = (html) =>
    html.replace(/<img\b[^>]*>/gi, (tag) => {
      if (!/\sloading=/i.test(tag)) tag = tag.replace(/^<img\b/i, '<img loading="lazy"');
      if (!/\sdecoding=/i.test(tag)) tag = tag.replace(/^<img\b/i, '<img decoding="async"');
      return tag;
    });
  const visit = (node) => {
    if (node.type === "raw") node.value = lazyRaw(node.value);
    else if (node.type === "element" && node.tagName === "img") {
      node.properties ??= {};
      node.properties.loading ??= "lazy";
      node.properties.decoding ??= "async";
    }
    node.children?.forEach(visit);
  };
  return (tree) => visit(tree);
}

export default defineConfig({
  site: "https://playtested.net",
  // Pages are prerendered to /dist (served free as static assets). Routes that
  // opt out with `export const prerender = false` run in the Worker.
  output: "static",
  adapter: cloudflare({
    workerEntryPoint: { path: "src/worker.ts" },
    imageService: "compile",
    sessionKVBindingName: "CACHE",
  }),
  trailingSlash: "always", // or "never" - choose one and be consistent
  integrations: [
    sitemap({ filter: (page) => !/\/(studio|live)\//.test(page) }),
    svelte(),
  ],
  // Prefetch every same-origin link on hover/focus intent. Pages are static
  // assets (no Worker invocation, no cost), only the HTML is fetched, once per
  // URL, and Astro skips it on Save-Data / 2G connections.
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  markdown: { rehypePlugins: [rehypeLazyImages] },
  vite: { plugins: [tailwindcss()] },
});
