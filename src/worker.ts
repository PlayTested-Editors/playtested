/**
 * Worker entry. Only runs for requests with NO matching built file — every
 * prerendered page, image, script and stylesheet is served by the asset layer
 * before this code is reached (free and unlimited).
 *
 * Order matters: the cheapest checks come first so stray traffic costs as
 * little as possible.
 */
import type { SSRManifest } from "astro";
import { App } from "astro/app";
import { handle } from "@astrojs/cloudflare/handler";
import type { Env } from "./lib/server/env";
import { isJunkPath, pruneRateLimits } from "./lib/server/guards";
import { serveStagedImage } from "./lib/server/media";
import { runWatchdog } from "./lib/server/watchdog";
import { runScheduler } from "./lib/server/deploys";
import { reindexPending } from "./lib/server/search";
import { handleStudio } from "./lib/server/api/studio";
import { publicRoutes } from "./lib/server/api/public";
import { error } from "./lib/server/util";

const ARTICLE_PATH = /^\/article\/([a-z0-9][a-z0-9-]*)\/?$/;

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);

  const fetch = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Scanner junk (wp-admin, .env, .php, …): answer immediately.
    if (isJunkPath(path)) {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=86400" } });
    }

    // 2. JSON APIs (studio + public live features), routed without Astro.
    if (path.startsWith("/api/")) {
      if (path.startsWith("/api/studio/")) return handleStudio(request, env, ctx);
      const r = publicRoutes[path.replace(/\/$/, "")];
      if (!r) return error(404, "Not found.");
      if (request.method !== r.method && !(request.method === "HEAD" && r.method === "GET")) return error(405, "Method not allowed.");
      try {
        return await r.handler(request, env, ctx);
      } catch (e) {
        console.error("api error", path, e);
        return error(500, "Something went wrong. Please try again.");
      }
    }

    // 3. Images uploaded in the studio that no build includes yet.
    if (path.startsWith("/images/uploads/") && (request.method === "GET" || request.method === "HEAD")) {
      const staged = await serveStagedImage(env, path);
      if (staged) return staged;
    }

    // 4. The studio is a single-page app: deep links load its shell.
    if (path === "/studio" || (path.startsWith("/studio/") && !/\.[a-z0-9]+$/i.test(path))) {
      return env.ASSETS.fetch(new Request(new URL("/studio/", url), request));
    }

    // 5. Old CMS address.
    if (path === "/admin" || path.startsWith("/admin/")) {
      return Response.redirect(new URL("/studio/", url).toString(), 302);
    }

    // 6. An article URL with no built page: maybe it was published moments
    //    ago and the build hasn't landed yet. The live route decides.
    const article = ARTICLE_PATH.exec(path);
    if (article && (request.method === "GET" || request.method === "HEAD")) {
      const live = new URL(`/live/article/${article[1]}/${url.search}`, url);
      return handle(manifest, app, new Request(live, request), env, ctx);
    }

    return handle(manifest, app, request, env, ctx);
  };

  const scheduled = async (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      Promise.allSettled([runWatchdog(env), runScheduler(env), reindexPending(env, 8), pruneRateLimits(env)]).then((results) => {
        for (const r of results) if (r.status === "rejected") console.error("cron task failed:", r.reason);
      }),
    );
  };

  return { default: { fetch, scheduled } satisfies ExportedHandler<Env> };
}
