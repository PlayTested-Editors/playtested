// Detects scheduled posts that have become due but are not yet live.
//
// The static site only reflects content as of its last build. This script
// compares the posts that SHOULD be visible now (draft:false and pubDate in the
// past) against what is actually live (the deployed sitemap). If a due post is
// missing from the sitemap, a scheduled post's time has arrived and the site
// needs a rebuild. Writes `due=true|false` to $GITHUB_OUTPUT.
//
// Self-correcting: if a cron run is missed, the next run still sees the post
// missing from the sitemap and triggers the rebuild.

import fs from "fs";
import path from "path";

const SITE = (process.env.SITE || "https://playtested.net").replace(/\/+$/, "");
const dirs = ["src/content/article", "src/content/submissions"];

function walk(d) {
  let r = [];
  if (!fs.existsSync(d)) return r;
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) r = r.concat(walk(p));
    else if (f.name.endsWith(".md") || f.name.endsWith(".mdx")) r.push(p);
  }
  return r;
}

function frontmatter(content) {
  const m = content.match(/^---([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = m[1];
  const get = (k) => {
    const mm = fm.match(new RegExp("^\\s*" + k + ":\\s*(.+)$", "mi"));
    return mm ? mm[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { draft: get("draft"), pubDate: get("pubDate"), slug: get("slug") };
}

// 1) Posts that should be visible right now
const now = Date.now();
const dueSlugs = [];
for (const dir of dirs) {
  for (const file of walk(dir)) {
    const d = frontmatter(fs.readFileSync(file, "utf8"));
    if (String(d.draft).toLowerCase() === "true") continue;
    if (!d.pubDate) continue;
    const t = new Date(d.pubDate).getTime();
    if (isNaN(t) || t > now) continue; // future-scheduled → not due yet
    const filename = path.basename(file, path.extname(file));
    dueSlugs.push((d.slug && d.slug.trim()) ? d.slug.trim() : filename);
  }
}

// 2) What is actually live (deployed sitemap)
async function fetchText(u) {
  try {
    const r = await fetch(u);
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  }
}
const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

const index = await fetchText(`${SITE}/sitemap-index.xml`);
let subs = locs(index).filter((u) => /sitemap.*\.xml$/i.test(u));
if (subs.length === 0) subs = [`${SITE}/sitemap-0.xml`];

const liveSlugs = new Set();
for (const s of subs) {
  for (const u of locs(await fetchText(s))) {
    const m = u.replace(/\/+$/, "").match(/\/article\/(.+)$/);
    if (m) liveSlugs.add(m[1]);
  }
}

// 3) Decide. Guard against a failed sitemap fetch (never trigger on empty).
const missing = dueSlugs.filter((s) => !liveSlugs.has(s));
const due = liveSlugs.size > 0 && missing.length > 0;

console.log(
  `due-visible=${dueSlugs.length} live-in-sitemap=${liveSlugs.size} newly-due=${missing.length}`,
);
if (missing.length) console.log("newly-due slugs:", missing.slice(0, 25).join(", "));
console.log(due ? "=> rebuild needed" : "=> no rebuild needed");

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due ? "true" : "false"}\n`);
}
