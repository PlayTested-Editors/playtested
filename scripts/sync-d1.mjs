#!/usr/bin/env node
/**
 * Mirror git content into the studio database (D1).
 *
 * Runs after `astro build` (reads dist/studio-export.json, which uses Astro's
 * own collection so slugs match the site) and before deploy:
 *  - new files in git        → imported as published articles
 *  - files changed in git    → live copy updated (and the working copy too,
 *                              unless an editor has unpublished changes)
 *  - files deleted from git  → marked unpublished
 * Studio publishes newer than the commit being built are left alone.
 *
 * Usage: node scripts/sync-d1.mjs [--local] [--dry-run]
 * Needs wrangler auth (CLOUDFLARE_API_TOKEN in CI).
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCAL = process.argv.includes("--local");
const DRY = process.argv.includes("--dry-run");
const EXPORT = "dist/studio-export.json";
const SITE_OFFSET_MS = 8 * 3600_000;

// Run wrangler's JS entry with node directly: no shell, so SQL arguments with
// spaces and quotes pass through intact on every platform.
const WRANGLER = path.resolve("node_modules/wrangler/bin/wrangler.js");
const wrangler = (args) =>
  execFileSync(process.execPath, [WRANGLER, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  });

const target = LOCAL ? "--local" : "--remote";

function query(sql) {
  const out = wrangler(["d1", "execute", "DB", target, "--json", "--command", sql]);
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[0]?.results ?? [];
}

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const toSiteIso = (ms) => new Date(ms + SITE_OFFSET_MS).toISOString().replace("Z", "+08:00");
const fileHash = (p) => crypto.createHash("sha256").update(fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex");

if (!fs.existsSync(EXPORT)) {
  console.error(`${EXPORT} not found — run the build first.`);
  process.exit(1);
}
const { articles } = JSON.parse(fs.readFileSync(EXPORT, "utf8"));
const info = fs.existsSync("public/build-info.json") ? JSON.parse(fs.readFileSync("public/build-info.json", "utf8")) : {};
const buildCommitTime = info.commitTime ?? Date.now();

const existing = query("SELECT id, slug, git_path, live_hash, state, draft_rev, live_json IS NOT NULL AS is_live, publish_commit_time FROM articles");
const byPath = new Map(existing.filter((r) => r.git_path).map((r) => [r.git_path, r]));
const bySlug = new Map(existing.map((r) => [r.slug, r]));

const now = Date.now();
const stmts = [];
const seenIds = new Set();
let added = 0;
let updated = 0;
let removed = 0;

for (const a of articles) {
  const file = a.gitPath.split("/").join(path.sep);
  if (!fs.existsSync(file)) continue;
  const hash = fileHash(file);
  const d = a.data;
  const pubMs = Date.parse(d.pubDate);
  const data = {
    title: d.title ?? "",
    description: d.description ?? "",
    pubDate: toSiteIso(pubMs),
    category: d.category ?? "",
    tags: Array.isArray(d.tags) ? d.tags : [],
    featured: Boolean(d.featured),
    author: d.author ?? "",
    slug: a.slug,
    ...(d.thumb ? { thumb: d.thumb } : {}),
    ...(d.large ? { large: d.large } : {}),
    gallery: Array.isArray(d.gallery) ? d.gallery : [],
    score: typeof d.score === "number" ? d.score : null,
    ...(d.game ? { game: d.game } : {}),
    body: (a.body ?? "").replace(/\r\n/g, "\n").trim(),
  };
  const json = JSON.stringify(data);
  const row = byPath.get(a.gitPath) ?? bySlug.get(a.slug);

  if (!row) {
    const id = crypto.randomUUID();
    stmts.push(
      `INSERT INTO articles (id, slug, collection, git_path, draft_json, draft_rev, state, live_json, live_hash, pub_date, title, category, author, score, featured, thumb, created_at, updated_at) VALUES (${[
        id, a.slug, a.collection, a.gitPath, json, 1, "published", json, hash, pubMs, data.title, data.category || null, data.author || null,
        data.score, data.featured ? 1 : 0, data.thumb ?? null, Number.isNaN(pubMs) ? now : pubMs, now,
      ].map(q).join(", ")});`,
      `INSERT INTO revisions (article_id, rev, data_json, kind, note, created_at) VALUES (${[id, 1, json, "import", "Imported from git", now].map(q).join(", ")});`,
    );
    added++;
    continue;
  }
  seenIds.add(row.id);
  if (row.live_hash === hash) continue;
  if ((row.publish_commit_time ?? 0) > buildCommitTime) continue; // the studio has something newer

  const editorHasChanges = row.state !== "published" && row.is_live;
  const sets = [
    `live_json = ${q(json)}`,
    `live_hash = ${q(hash)}`,
    `pub_date = ${q(pubMs)}`,
    `git_path = ${q(a.gitPath)}`,
    `collection = ${q(a.collection)}`,
    `updated_at = ${q(now)}`,
  ];
  if (!editorHasChanges) {
    sets.push(
      `draft_json = ${q(json)}`,
      `draft_rev = draft_rev + 1`,
      `state = 'published'`,
      `slug = ${q(a.slug)}`,
      `title = ${q(data.title)}`,
      `category = ${q(data.category || null)}`,
      `author = ${q(data.author || null)}`,
      `score = ${q(data.score)}`,
      `featured = ${data.featured ? 1 : 0}`,
      `thumb = ${q(data.thumb ?? null)}`,
    );
  }
  stmts.push(
    `UPDATE articles SET ${sets.join(", ")} WHERE id = ${q(row.id)};`,
    `INSERT INTO revisions (article_id, rev, data_json, kind, note, created_at) VALUES (${[row.id, row.draft_rev + 1, json, "sync", "Changed in git", now].map(q).join(", ")});`,
  );
  updated++;
}

for (const row of existing) {
  if (!row.is_live || seenIds.has(row.id) || !row.git_path) continue;
  if ((row.publish_commit_time ?? 0) > buildCommitTime) continue; // published after this commit
  stmts.push(
    `UPDATE articles SET live_json = NULL, live_hash = NULL, state = 'draft', updated_at = ${now} WHERE id = ${q(row.id)};`,
    `INSERT INTO revisions (article_id, rev, data_json, kind, note, created_at) SELECT id, draft_rev, draft_json, 'sync', 'Removed from git', ${now} FROM articles WHERE id = ${q(row.id)};`,
  );
  removed++;
}

console.log(`D1 sync: ${added} new, ${updated} changed, ${removed} removed (of ${articles.length} in git).`);
if (stmts.length) {
  // Something changed: let the Worker's background job re-index search.
  stmts.push(
    `INSERT INTO settings (key, value, updated_at) VALUES ('index_dirty', '1', ${now}) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at;`,
  );
}
if (stmts.length && !DRY) {
  fs.mkdirSync(".wrangler/tmp", { recursive: true });
  const sqlFile = ".wrangler/tmp/sync-d1.sql";
  fs.writeFileSync(sqlFile, stmts.join("\n"));
  wrangler(["d1", "execute", "DB", target, "--file", sqlFile, "--yes"]);
  console.log("D1 sync applied.");
}
fs.rmSync(EXPORT, { force: true });
