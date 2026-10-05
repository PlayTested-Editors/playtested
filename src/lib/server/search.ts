/**
 * Site search index: full articles split into section-sized chunks.
 *
 *  - Keyword: D1 FTS5 (search_fts), BM25-ranked.
 *  - Semantic: Workers AI embeddings (bge-small, 384-d) in Vectorize.
 *  - Hybrid: reciprocal-rank fusion of both, grouped per article.
 *
 * Indexing happens on publish, and a cron catch-up indexes anything the git
 * sync changed (search_docs.hash != articles.live_hash).
 */
import type { Env } from "./env";
import { liveOf, type ArticleData, type ArticleRow } from "./articles";
import { getGuards } from "./guards";
import { now, parseJson, sha256Hex } from "./util";

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
const TARGET_CHUNK = 1000;
const MAX_CHUNKS = 24;

export interface Chunk {
  idx: number;
  heading: string;
  text: string;
}

/** Markdown/HTML → readable plain text, keeping paragraph breaks. */
export function plainText(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|figure)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkArticle(d: ArticleData): Chunk[] {
  // Split into sections on markdown headings, keeping each heading as context.
  const sections: { heading: string; text: string }[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const text = plainText(buf.join("\n"));
    if (text) sections.push({ heading, text });
    buf = [];
  };
  for (const line of d.body.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      heading = plainText(h[1]);
    } else {
      buf.push(line);
    }
  }
  flush();

  // Pack paragraphs into ~TARGET_CHUNK sized chunks.
  const target = d.body.length > TARGET_CHUNK * MAX_CHUNKS ? Math.ceil(d.body.length / MAX_CHUNKS) : TARGET_CHUNK;
  const chunks: Chunk[] = [];
  for (const s of sections) {
    let current = "";
    const paras = s.text.split(/\n{2,}/).flatMap((p) => (p.length > target * 1.5 ? p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p] : [p]));
    for (const p of paras) {
      if (current && current.length + p.length > target) {
        chunks.push({ idx: chunks.length, heading: s.heading, text: current.trim() });
        current = "";
      }
      current += (current ? "\n\n" : "") + p.trim();
    }
    if (current.trim()) chunks.push({ idx: chunks.length, heading: s.heading, text: current.trim() });
  }
  if (!chunks.length) chunks.push({ idx: 0, heading: "", text: d.description || d.title });
  return chunks.slice(0, MAX_CHUNKS * 2);
}

async function vectorPrefix(slug: string): Promise<string> {
  return (await sha256Hex(slug)).slice(0, 24);
}

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const res = (await env.AI.run(EMBED_MODEL, { text: texts.slice(i, i + 50) })) as { data: number[][] };
    out.push(...res.data);
  }
  return out;
}

// Passages are keyed by rowid = doc_id * ROWS_PER_DOC + chunk index, so an
// article's passages are read and deleted with rowid ranges. (FTS5 columns
// can't be indexed: filtering by slug scanned every passage in the table.)
const ROWS_PER_DOC = 100;
const rowidOf = (docId: number, idx: number) => docId * ROWS_PER_DOC + idx;

async function docIdFor(env: Env, slug: string): Promise<{ docId: number; chunkCount: number }> {
  const row = await env.DB.prepare("SELECT doc_id, chunk_count FROM search_docs WHERE slug = ?")
    .bind(slug)
    .first<{ doc_id: number | null; chunk_count: number }>();
  if (row?.doc_id) return { docId: row.doc_id, chunkCount: row.chunk_count };
  const next = await env.DB.prepare("SELECT COALESCE(MAX(doc_id), 0) + 1 AS id FROM search_docs").first<{ id: number }>();
  return { docId: next?.id ?? 1, chunkCount: row?.chunk_count ?? 0 };
}

/** Flag the background job to look for articles to (re-)index. */
export async function markIndexDirty(env: Env): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('index_dirty', '1', ?) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at",
  )
    .bind(now())
    .run();
}

export async function indexArticle(env: Env, d: ArticleData, hash: string, opts: { vectors?: boolean } = {}): Promise<number> {
  const chunks = chunkArticle(d).slice(0, ROWS_PER_DOC);
  const { docId, chunkCount: prevCount } = await docIdFor(env, d.slug);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM search_fts WHERE rowid >= ? AND rowid < ?").bind(rowidOf(docId, 0), rowidOf(docId + 1, 0)),
    ...chunks.map((c) =>
      env.DB.prepare("INSERT INTO search_fts (rowid, slug, idx, title, heading, body) VALUES (?, ?, ?, ?, ?, ?)").bind(
        rowidOf(docId, c.idx),
        d.slug,
        c.idx,
        d.title,
        c.heading,
        c.text,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO search_docs (slug, doc_id, title, description, category, tags, author, score, pub_date, thumb, hash, chunk_count, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET doc_id = excluded.doc_id, title = excluded.title, description = excluded.description,
         category = excluded.category, tags = excluded.tags, author = excluded.author, score = excluded.score,
         pub_date = excluded.pub_date, thumb = excluded.thumb, hash = excluded.hash, chunk_count = excluded.chunk_count,
         indexed_at = excluded.indexed_at`,
    ).bind(
      d.slug,
      docId,
      d.title,
      d.description,
      d.category,
      JSON.stringify(d.tags),
      d.author,
      d.score ?? null,
      Date.parse(d.pubDate),
      d.thumb ?? null,
      hash,
      chunks.length,
      now(),
    ),
  ]);

  // Vectors are keyed by slug + chunk index; a text-only rebuild (same
  // chunking) can skip re-embedding.
  if (opts.vectors !== false) {
    const prefix = await vectorPrefix(d.slug);
    const vectors = await embed(
      env,
      chunks.map((c) => `${d.title}${c.heading ? ` — ${c.heading}` : ""}\n${c.text}`.slice(0, 2000)),
    );
    await env.VECTORS.upsert(
      chunks.map((c, i) => ({
        id: `${prefix}-${c.idx}`,
        values: vectors[i],
        metadata: { slug: d.slug, idx: c.idx, category: d.category || "" },
      })),
    );
    if (prevCount > chunks.length) {
      const stale = Array.from({ length: prevCount - chunks.length }, (_, i) => `${prefix}-${chunks.length + i}`);
      await env.VECTORS.deleteByIds(stale);
    }
  }
  return chunks.length;
}

export async function removeFromIndex(env: Env, slug: string): Promise<void> {
  const row = await env.DB.prepare("SELECT doc_id, chunk_count FROM search_docs WHERE slug = ?")
    .bind(slug)
    .first<{ doc_id: number | null; chunk_count: number }>();
  if (!row) return;
  await env.DB.batch([
    ...(row.doc_id
      ? [env.DB.prepare("DELETE FROM search_fts WHERE rowid >= ? AND rowid < ?").bind(rowidOf(row.doc_id, 0), rowidOf(row.doc_id + 1, 0))]
      : []),
    env.DB.prepare("DELETE FROM search_docs WHERE slug = ?").bind(slug),
  ]);
  if (row.chunk_count) {
    const prefix = await vectorPrefix(slug);
    await env.VECTORS.deleteByIds(Array.from({ length: row.chunk_count }, (_, i) => `${prefix}-${i}`));
  }
}

/**
 * Index whatever is out of date: published articles whose content hash
 * differs from the indexed one, and index rows for articles no longer live.
 * Only does real work when the index_dirty flag is set (by the git sync or a
 * migration) — an idle run costs one row read.
 */
export async function reindexPending(
  env: Env,
  limit = 8,
  opts: { force?: boolean; vectors?: boolean } = {},
): Promise<{ indexed: string[]; removed: string[]; remaining: number }> {
  // Flag values: "0" idle, "1" changed content (re-embed), "text" passages
  // only (e.g. after a schema change; the vectors are still valid).
  const flag = await env.DB.prepare("SELECT value FROM settings WHERE key = 'index_dirty'").first<{ value: string }>();
  if (!opts.force && flag?.value !== "1" && flag?.value !== "text") return { indexed: [], removed: [], remaining: 0 };
  // Writing FTS5 rows is read-heavy on D1 (the index merges segments, which
  // counts as rows read — roughly 3k per article). Background indexing waits
  // whenever today's D1 reads are past half the free allowance.
  if (!opts.force) {
    const d1 = (await getGuards(env)).usage?.metrics?.d1Read;
    if (d1 && d1.used / d1.limit > 0.5) return { indexed: [], removed: [], remaining: 1 };
  }
  const vectors = opts.vectors ?? flag?.value !== "text";
  // Ordered by pub_date with a LIMIT: while many articles are pending this
  // stops after ~limit rows instead of scanning everything.
  const pending = await env.DB.prepare(
    `SELECT a.* FROM articles a LEFT JOIN search_docs s ON s.slug = a.slug
     WHERE a.live_json IS NOT NULL AND (s.slug IS NULL OR s.hash != a.live_hash)
     ORDER BY a.pub_date DESC LIMIT ?`,
  )
    .bind(limit)
    .all<ArticleRow>();
  const indexed: string[] = [];
  for (const row of pending.results) {
    const live = liveOf(row);
    if (!live) continue;
    await indexArticle(env, live, row.live_hash || "", { vectors });
    indexed.push(row.slug);
  }
  if (pending.results.length >= limit) return { indexed, removed: [], remaining: 1 };

  // Caught up: drop index rows for articles no longer live, then clear the flag.
  const orphans = await env.DB.prepare(
    `SELECT s.slug FROM search_docs s LEFT JOIN articles a ON a.slug = s.slug AND a.live_json IS NOT NULL
     WHERE a.id IS NULL LIMIT 50`,
  ).all<{ slug: string }>();
  for (const o of orphans.results) await removeFromIndex(env, o.slug);
  await env.DB.prepare("UPDATE settings SET value = '0', updated_at = ? WHERE key = 'index_dirty'").bind(now()).run();
  return { indexed, removed: orphans.results.map((o) => o.slug), remaining: 0 };
}

// ---------------------------------------------------------------------------
// Querying

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have i in is it its of on or that the this to was were what when where which who why will with you your me my about does do did how can should game games".split(
    " ",
  ),
);

export function ftsQuery(q: string): string | null {
  const terms = (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t)).slice(0, 8);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

export interface ChunkHit {
  slug: string;
  idx: number;
  heading: string;
  text: string;
  snippet?: string;
}

export async function keywordSearch(env: Env, q: string, limit = 30, slug?: string): Promise<ChunkHit[]> {
  const match = ftsQuery(q);
  if (!match) return [];
  // Scope to one article with its rowid range (slug is unindexed in FTS5).
  let range: [number, number] | null = null;
  if (slug) {
    const doc = await env.DB.prepare("SELECT doc_id FROM search_docs WHERE slug = ?").bind(slug).first<{ doc_id: number | null }>();
    if (!doc?.doc_id) return [];
    range = [rowidOf(doc.doc_id, 0), rowidOf(doc.doc_id + 1, 0)];
  }
  const sql = `SELECT slug, idx, heading, body AS text,
      snippet(search_fts, 4, '<mark>', '</mark>', '…', 28) AS snippet
    FROM search_fts WHERE search_fts MATCH ? ${range ? "AND rowid >= ? AND rowid < ?" : ""}
    ORDER BY bm25(search_fts, 0.0, 0.0, 8.0, 3.0, 1.0) LIMIT ?`;
  const stmt = range ? env.DB.prepare(sql).bind(match, range[0], range[1], limit) : env.DB.prepare(sql).bind(match, limit);
  try {
    return (await stmt.all<ChunkHit>()).results;
  } catch {
    return [];
  }
}

export async function semanticSearch(env: Env, q: string, topK = 20, slug?: string): Promise<ChunkHit[]> {
  const [vector] = await embed(env, [q.slice(0, 500)]);
  const res = await env.VECTORS.query(vector, {
    topK,
    returnMetadata: "all",
    ...(slug ? { filter: { slug } } : {}),
  });
  const keys = res.matches
    .map((m) => ({ slug: String(m.metadata?.slug ?? ""), idx: Number(m.metadata?.idx ?? -1), score: m.score }))
    .filter((k) => k.slug && k.idx >= 0 && k.score > 0.55);
  if (!keys.length) return [];
  // Passages are fetched by rowid (key lookups), never by scanning.
  const slugs = [...new Set(keys.map((k) => k.slug))];
  const docs = await env.DB.prepare(`SELECT slug, doc_id FROM search_docs WHERE slug IN (${slugs.map(() => "?").join(",")})`)
    .bind(...slugs)
    .all<{ slug: string; doc_id: number | null }>();
  const docIds = new Map(docs.results.filter((d) => d.doc_id).map((d) => [d.slug, d.doc_id as number]));
  const rowids = keys.filter((k) => docIds.has(k.slug)).map((k) => rowidOf(docIds.get(k.slug)!, k.idx));
  if (!rowids.length) return [];
  const rows = await env.DB.prepare(`SELECT slug, idx, heading, body AS text FROM search_fts WHERE rowid IN (${rowids.map(() => "?").join(",")})`)
    .bind(...rowids)
    .all<ChunkHit>();
  const byKey = new Map(rows.results.map((r) => [`${r.slug}#${r.idx}`, r]));
  return keys.map((k) => byKey.get(`${k.slug}#${k.idx}`)).filter(Boolean) as ChunkHit[];
}

export interface SearchDoc {
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[];
  author: string | null;
  score: number | null;
  pubDate: number | null;
  thumb: string | null;
  url: string;
  relevance: number;
  chunks: ChunkHit[];
}

/**
 * Reciprocal-rank fusion of keyword + semantic hits, grouped per article.
 * `chunks` is how many of each article's best passages to return (default 3).
 */
export async function hybridSearch(
  env: Env,
  q: string,
  opts: { limit?: number; slug?: string; semantic?: boolean; chunks?: number } = {},
): Promise<SearchDoc[]> {
  const limit = opts.limit ?? 10;
  const [kw, sem] = await Promise.all([
    keywordSearch(env, q, 30, opts.slug),
    opts.semantic === false ? Promise.resolve([] as ChunkHit[]) : semanticSearch(env, q, 20, opts.slug).catch(() => [] as ChunkHit[]),
  ]);
  const K = 60;
  const chunkScore = new Map<string, { hit: ChunkHit; score: number }>();
  const addList = (list: ChunkHit[], weight: number) =>
    list.forEach((hit, rank) => {
      const key = `${hit.slug}#${hit.idx}`;
      const cur = chunkScore.get(key);
      const s = weight / (K + rank + 1);
      if (cur) {
        cur.score += s;
        if (hit.snippet && !cur.hit.snippet) cur.hit.snippet = hit.snippet;
      } else chunkScore.set(key, { hit: { ...hit }, score: s });
    });
  addList(kw, 1);
  addList(sem, 1.2);

  const perDoc = new Map<string, { score: number; chunks: { hit: ChunkHit; score: number }[] }>();
  for (const c of chunkScore.values()) {
    const d = perDoc.get(c.hit.slug) ?? { score: 0, chunks: [] };
    d.chunks.push(c);
    perDoc.set(c.hit.slug, d);
  }
  for (const d of perDoc.values()) {
    d.chunks.sort((a, b) => b.score - a.score);
    // Best chunk dominates; extra matching chunks add a little.
    d.score = d.chunks[0].score + d.chunks.slice(1, 4).reduce((s, c) => s + c.score * 0.3, 0);
  }
  const ranked = [...perDoc.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  if (!ranked.length) return [];

  const slugs = ranked.map(([s]) => s);
  const docs = await env.DB.prepare(`SELECT * FROM search_docs WHERE slug IN (${slugs.map(() => "?").join(",")})`)
    .bind(...slugs)
    .all<{
      slug: string;
      title: string;
      description: string | null;
      category: string | null;
      tags: string | null;
      author: string | null;
      score: number | null;
      pub_date: number | null;
      thumb: string | null;
    }>();
  const meta = new Map(docs.results.map((d) => [d.slug, d]));
  const t = now();
  return ranked
    .map(([slug, d]) => {
      const m = meta.get(slug);
      // Scheduled posts are indexed ahead of time but stay hidden until their date.
      if (!m || (m.pub_date && m.pub_date > t)) return null;
      return {
        slug,
        title: m.title,
        description: m.description,
        category: m.category,
        tags: parseJson<string[]>(m.tags, []),
        author: m.author,
        score: m.score,
        pubDate: m.pub_date,
        thumb: m.thumb,
        url: `/article/${slug}/`,
        relevance: Math.round(d.score * 10000) / 10000,
        chunks: d.chunks.slice(0, opts.chunks ?? 3).map((c) => c.hit),
      } satisfies SearchDoc;
    })
    .filter(Boolean) as SearchDoc[];
}
