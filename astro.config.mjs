// astro.config.mjs
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import svelte from "@astrojs/svelte";
import cloudflare from "@astrojs/cloudflare";

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
  prefetch: { prefetchAll: false, defaultStrategy: "hover" },
  vite: { plugins: [tailwindcss()] },
});
