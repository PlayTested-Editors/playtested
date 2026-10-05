#!/usr/bin/env node
/**
 * Site build. Usage: node scripts/build.mjs [--env dev|production]
 *
 * Writes per-environment files into public/ (gitignored), then builds the
 * search index and the Astro site into dist/.
 *  - public/build-info.json  which commit/time this deployment was built from
 *    (the Worker reads it to know whether a studio publish is live yet)
 *  - public/robots.txt       dev is never indexed
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const argIdx = process.argv.indexOf("--env");
const siteEnv = (argIdx > -1 ? process.argv[argIdx + 1] : process.env.SITE_ENV) || "production";
process.env.SITE_ENV = siteEnv;
process.env.PUBLIC_SITE_ENV = siteEnv;

const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

let commit = process.env.GITHUB_SHA || null;
let commitTime = null;
try {
  commit ||= sh("git rev-parse HEAD");
  commitTime = Number(sh(`git log -1 --format=%ct ${commit}`)) * 1000;
} catch {
  // Not a git checkout (e.g. a tarball build) — the Worker falls back to builtAt.
}

const builtAt = Date.now();
fs.writeFileSync("public/build-info.json", JSON.stringify({ builtAt, commit, commitTime, env: siteEnv }));
fs.writeFileSync(
  "public/robots.txt",
  siteEnv === "production"
    ? "User-agent: *\nAllow: /\nSitemap: https://playtested.net/sitemap-index.xml\n"
    : "User-agent: *\nDisallow: /\n",
);

console.log(`Building PlayTested (${siteEnv}) at ${commit ? commit.slice(0, 7) : "unknown commit"}…`);
execSync("node scripts/build-search-index.mjs", { stdio: "inherit" });
execSync("npx astro build", { stdio: "inherit", env: process.env });
