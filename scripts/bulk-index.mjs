#!/usr/bin/env node
/**
 * Full search-index rebuild in bulk. Use this instead of the studio's
 * article-by-article indexing whenever many articles need indexing (new
 * database, schema change).
 *
 * Writing FTS5 rows one transaction at a time is read-heavy on D1 (segment
 * merges count as rows read, ~3k per article). Here every passage goes in
 * with ONE SQL import, so the index is built once. Embeddings are made via
 * the Workers AI REST API and upserted to Vectorize from this machine.
 *
 * Usage:
 *   node scripts/bulk-index.mjs [--limit N] [--skip-vectors]
 * Needs wrangler auth with access to the account in wrangler.jsonc.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const args = process.argv.slice(2);
const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 0;
const SKIP_VECTORS = args.includes("--skip-vectors");
const TMP = ".wrangler/tmp";
const WRANGLER = path.resolve("node_modules/wrangler/bin/wrangler.js");
const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
const ROWS_PER_DOC = 100;

const config = fs.readFileSync("wrangler.jsonc", "utf8");
const ACCOUNT_ID = /"account_id":\s*"([0-9a-f]{32})"/.exec(config)?.[1];
const INDEX = /"index_name":\s*"([^"]+)"/.exec(config)?.[1];
if (!ACCOUNT_ID || !INDEX) throw new Error("account_id / vectorize index_name not found in wrangler.jsonc");

const wrangler = (a) =>
  execFileSync(process.execPath, [WRANGLER, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 512 * 1024 * 1024 });
const query = (sql) => {
  const out = wrangler(["d1", "execute", "DB", "--remote", "--json", "--command", sql]);
  return JSON.parse(out.slice(out.indexOf("[")))[0];
};
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// Reuse the Worker's own chunking so the index matches what publishing produces.
fs.mkdirSync(TMP, { recursive: true });
const bundle = path.resolve("scripts", ".search-bundle.mjs");
await build({ entryPoints: ["src/lib/server/search.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, logLevel: "error" });
const { chunkArticle } = await import(pathToFileURL(bundle).href);

const res = query(
  // live_slug: the slug the site serves (a draft may be renaming it).
  `SELECT COALESCE(live_slug, slug) AS slug, live_json, live_hash FROM articles WHERE live_json IS NOT NULL ORDER BY pub_date DESC${LIMIT ? ` LIMIT ${LIMIT}` : ""}`,
);
console.log(`Loaded ${res.results.length} articles (rows read: ${res.meta.rows_read}).`);

const docs = res.results.map((r, i) => ({ docId: i + 1, slug: r.slug, hash: r.live_hash, data: JSON.parse(r.live_json) }));
const stmts = [
  // Recreating the table is far cheaper than deleting FTS5 rows.
  "DROP TABLE IF EXISTS search_fts;",
  "CREATE VIRTUAL TABLE search_fts USING fts5(slug UNINDEXED, idx UNINDEXED, title, heading, body, tokenize = 'porter unicode61 remove_diacritics 2');",
  "DELETE FROM search_docs;",
];
const passages = [];
for (const d of docs) {
  const chunks = chunkArticle(d.data).slice(0, ROWS_PER_DOC);
  const x = d.data;
  stmts.push(
    `INSERT INTO search_docs (slug, doc_id, title, description, category, tags, author, score, pub_date, thumb, hash, chunk_count, indexed_at) VALUES (${[
      d.slug, d.docId, x.title, x.description ?? null, x.category ?? null, JSON.stringify(x.tags ?? []), x.author ?? null,
      typeof x.score === "number" ? x.score : null, Date.parse(x.pubDate), x.thumb ?? null, d.hash ?? "", chunks.length, Date.now(),
    ].map(q).join(", ")});`,
  );
  for (const c of chunks) {
    stmts.push(
      `INSERT INTO search_fts (rowid, slug, idx, title, heading, body) VALUES (${[d.docId * ROWS_PER_DOC + c.idx, d.slug, c.idx, x.title, c.heading, c.text].map(q).join(", ")});`,
    );
    passages.push({ slug: d.slug, idx: c.idx, category: x.category || "", text: `${x.title}${c.heading ? ` — ${c.heading}` : ""}\n${c.text}`.slice(0, 2000) });
  }
}
stmts.push(`INSERT INTO settings (key, value, updated_at) VALUES ('index_dirty', '0', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = excluded.updated_at;`);

const sqlFile = path.join(TMP, "bulk-index.sql");
fs.writeFileSync(sqlFile, stmts.join("\n"));
console.log(`Importing ${docs.length} articles / ${passages.length} passages in one SQL import…`);
wrangler(["d1", "execute", "DB", "--remote", "--file", sqlFile, "--yes"]);
console.log("Text index imported.");

if (SKIP_VECTORS) process.exit(0);

// Embeddings via Workers AI REST, using wrangler's own login token.
const cfg = fs.readFileSync(path.join(process.env.APPDATA || path.join(process.env.HOME, ".config"), "xdg.config/.wrangler/config/default.toml"), "utf8");
const token = process.env.CLOUDFLARE_API_TOKEN || /oauth_token\s*=\s*"([^"]+)"/.exec(cfg)?.[1];
const vecFile = path.join(TMP, "bulk-vectors.ndjson");
fs.writeFileSync(vecFile, "");
const prefixes = new Map();
for (let i = 0; i < passages.length; i += 50) {
  const batch = passages.slice(i, i + 50);
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${EMBED_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: batch.map((p) => p.text) }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(`Workers AI: ${JSON.stringify(j.errors).slice(0, 300)}`);
  const lines = batch.map((p, k) => {
    if (!prefixes.has(p.slug)) prefixes.set(p.slug, crypto.createHash("sha256").update(p.slug).digest("hex").slice(0, 24));
    return JSON.stringify({ id: `${prefixes.get(p.slug)}-${p.idx}`, values: j.result.data[k], metadata: { slug: p.slug, idx: p.idx, category: p.category } });
  });
  fs.appendFileSync(vecFile, lines.join("\n") + "\n");
  process.stdout.write(`\rEmbedded ${Math.min(i + 50, passages.length)}/${passages.length}`);
}
console.log("\nUpserting vectors…");
wrangler(["vectorize", "upsert", INDEX, "--file", vecFile]);
console.log("Done.");
