/**
 * Public API (site visitors). Every live feature goes through gate() first:
 * feature switch + watchdog level, per-visitor rate limit, then daily cap.
 */
import type { Env } from "../env";
import { gate } from "../guards";
import { complete, completeStream, type ChatMessage } from "../openrouter";
import { chunkArticle, hybridSearch, type SearchDoc } from "../search";
import { hasIntent, matchesIntent, parseIntent, plainIntent, sortByIntent } from "../../search-intent";
import { error, json } from "../util";
import { liveOf, type ArticleRow } from "../articles";
import { shortTitle } from "../../titles";
import { UNAVAILABLE, findGame, gameDetails, searchGames } from "../games";

type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;

// ---------------------------------------------------------------------------
// Streaming answers
//
// AI answers stream OpenRouter's SSE straight through, prefixed with
// `<!--REFS:{...}:REFS-->` — the citation map the client uses to turn [n]
// markers into links (see src/lib/ai-client.ts).

const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" };

function streamWithRefs(upstream: Response, refs: Record<string, unknown>): Response {
  const reader = upstream.body!.getReader();
  let prefix: Uint8Array | null = new TextEncoder().encode(`<!--REFS:${JSON.stringify(refs)}:REFS-->\n`);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefix) {
        controller.enqueue(prefix);
        prefix = null;
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    // The visitor pressed "stop" or left: stop generating (and paying for) tokens.
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** A fixed reply in the same stream format, for answers that need no AI call. */
function cannedStream(text: string): Response {
  const body = `<!--REFS:{}:REFS-->\ndata: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { headers: SSE_HEADERS });
}

// ---------------------------------------------------------------------------
// Search

/** Lowercase words worth highlighting/locating in a passage. */
function queryTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].slice(0, 8);
}

/** A short window of a passage, starting near the first query term it contains. */
function excerpt(text: string, terms: string[], size = 260): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= size) return flat;
  const lower = flat.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  const start = at > size / 3 ? flat.indexOf(" ", at - Math.floor(size / 3)) + 1 : 0;
  const cut = flat.slice(start, start + size);
  const end = cut.lastIndexOf(" ");
  return `${start > 0 ? "…" : ""}${end > size * 0.7 ? cut.slice(0, end) : cut}…`;
}

const search: Handler = async (request, env, ctx) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
  if (q.length < 2) return json({ q, results: [] });
  const blocked = await gate(env, request, "search");
  if (blocked) return blocked;

  // Repeat queries come from this location's edge cache (a no-op on workers.dev).
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 12, 1), 30);
  const cacheKey = new Request(`${url.origin}/api/search?q=${encodeURIComponent(q.toLowerCase())}&limit=${limit}${url.searchParams.has("exact") ? "&exact=1" : ""}`);
  const edge = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
  const hit = await edge?.match(cacheKey).catch(() => undefined);
  if (hit) return hit;

  // Only what the results page shows: each article's best passages as short
  // snippets (keyword hits carry <mark> highlights), not the full chunk text.
  // "quick reviews", "best RPGs 9+", "first impressions 2024": the intent words
  // become filters and ordering, and only what's left is searched. A query that
  // is all intent ("full reviews") has no text to search: the page lists those
  // from its static index instead, so it costs no D1 reads.
  const intent = url.searchParams.has("exact") ? plainIntent(q) : parseIntent(q);
  const wantsIntent = hasIntent(intent);
  if (wantsIntent && !intent.text) return json({ q, intent: intent.label, results: [] }, { headers: { "Cache-Control": "public, max-age=300" } });
  const terms = queryTerms(intent.text);
  // Over-fetch when filtering: some of the best matches won't be the kind asked for.
  const ranked = await hybridSearch(env, intent.text, { limit: wantsIntent ? Math.min(limit * 3, 60) : limit });
  const docs = wantsIntent ? sortByIntent(ranked.filter((d) => matchesIntent(d, intent)), intent).slice(0, limit) : ranked;
  const results = docs.map(({ chunks, description, ...d }) => ({
    ...d,
    description: description && description.length > 300 ? `${description.slice(0, 300)}…` : description,
    chunks: chunks.map((c) => ({ idx: c.idx, heading: c.heading, snippet: c.snippet || excerpt(c.text, terms) })),
  }));
  const res = json({ q, results, ...(wantsIntent ? { intent: intent.label } : {}) }, { headers: { "Cache-Control": "public, max-age=300" } });
  if (edge) ctx.waitUntil(edge.put(cacheKey, res.clone()).catch(() => undefined));
  return res;
};

// ---------------------------------------------------------------------------
// Chat (site-wide, RAG over full articles) and the search page's answer box

const SITE_FACTS = `PlayTested.net is a gaming and tech review site run by lyndonguitar (Lyndon), with reviews of PC, console and mobile games scored out of 10.`;

const CITE_RULE = `HOW TO CITE: each review below has a number like [1]. Every time you mention a reviewed game, write its number in place of its name — the number renders as the game's name, linked to our review. GOOD: "You should try [1]." BAD: "You should try Elden Ring [1]." BAD: "You should try Elden Ring."`;

type Ref = { url: string; title: string; label: string; score: number | null };

function buildContext(docs: SearchDoc[]) {
  const refs: Record<string, Ref> = {};
  const blocks = docs.map((d, i) => {
    const n = i + 1;
    refs[`[${n}]`] = { url: d.url, title: d.title, label: shortTitle(d.title), score: d.score };
    const passages = d.chunks.map((c) => `${c.heading ? `(${c.heading}) ` : ""}${c.text.slice(0, 900)}`).join("\n…\n");
    const score = d.score !== null && d.score !== undefined ? ` | Score: ${d.score}/10` : "";
    const date = d.pubDate ? new Date(d.pubDate).toISOString().slice(0, 10) : "N/A";
    return `[${n}] "${d.title}" by ${d.author || "lyndonguitar"} | ${date}${score}\n${passages}`;
  });
  return { refs, text: blocks.join("\n\n") };
}

// Retrieval only finds a handful of articles, so "what's your highest-rated
// game?" also gets the site-wide extremes. Read through idx_articles_score
// (the working-copy score, so over-fetch and use the live values), cached 1h.

type Ranked = { title: string; score: number; url: string; pubDate: number };
const RANKED_KEY = "chat:ranked:v1";
const RANKING_RE = /\b(best|top|highest|lowest|worst|greatest|rated|ratings?|scores?|scored|rank\w*|favou?rites?|must[- ]play|recommend\w*)\b/i;

async function rankedReviews(env: Env): Promise<{ top: Ranked[]; bottom: Ranked[] }> {
  const cached = await env.CACHE.get<{ top: Ranked[]; bottom: Ranked[] }>(RANKED_KEY, "json").catch(() => null);
  if (cached) return cached;
  const now = Date.now();
  const pick = async (dir: "DESC" | "ASC") => {
    const rows = await env.DB.prepare(
      `SELECT live_json, live_slug FROM articles WHERE score >= 0 AND live_json IS NOT NULL ORDER BY score ${dir} LIMIT 40`,
    ).all<ArticleRow>();
    return rows.results
      .flatMap((row) => {
        const live = liveOf(row);
        const t = live ? Date.parse(live.pubDate) : NaN;
        // Scheduled posts stay hidden until their date.
        if (!live || !row.live_slug || typeof live.score !== "number" || !(t <= now)) return [];
        return [{ title: live.title, score: live.score, url: `/article/${row.live_slug}/`, pubDate: t }];
      })
      .sort((a, b) => (dir === "DESC" ? b.score - a.score : a.score - b.score) || b.pubDate - a.pubDate);
  };
  const [top, bottom] = await Promise.all([pick("DESC"), pick("ASC")]);
  const ranked = { top: top.slice(0, 15), bottom: bottom.slice(0, 8) };
  await env.CACHE.put(RANKED_KEY, JSON.stringify(ranked), { expirationTtl: 3600 }).catch(() => undefined);
  return ranked;
}

/** Numbers the ranked reviews after the retrieved ones (reusing a number when it's the same review). */
function rankedContext(ranked: { top: Ranked[]; bottom: Ranked[] }, refs: Record<string, Ref>): string {
  const byUrl = new Map(Object.entries(refs).map(([k, r]) => [r.url, k]));
  const line = (r: Ranked) => {
    let key = byUrl.get(r.url);
    if (!key) {
      key = `[${byUrl.size + 1}]`;
      refs[key] = { url: r.url, title: r.title, label: shortTitle(r.title), score: r.score };
      byUrl.set(r.url, key);
    }
    return `${key} ${shortTitle(r.title)} — ${r.score}/10 (reviewed ${new Date(r.pubDate).toISOString().slice(0, 10)})`;
  };
  if (!ranked.top.length) return "";
  return `HIGHEST-SCORED REVIEWS ON THE WHOLE SITE (cite these by number too):\n${ranked.top.map(line).join("\n")}\n\nLOWEST-SCORED REVIEWS ON THE WHOLE SITE (cite these by number too):\n${ranked.bottom.map(line).join("\n")}`;
}

const chat: Handler = async (request, env) => {
  const body = await readJson<{ messages?: ChatMessage[]; page?: { title?: string } }>(request);
  const messages = (body?.messages ?? [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-8);
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !last.content?.trim()) return error(400, "No question provided.");
  const blocked = await gate(env, request, "chat");
  if (blocked) return blocked;

  // Retrieve with the latest question plus a little conversational context.
  // "Is this worth it?" asked on an article page is about that article.
  const pageTitle = String(body?.page?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const prevUser = messages.filter((m) => m.role === "user").slice(-2, -1)[0]?.content ?? "";
  const aboutPage = pageTitle && /\b(this|it|its|it's|here|the game|the review)\b/i.test(last.content);
  const query = `${aboutPage ? `${shortTitle(pageTitle)} ` : ""}${last.content} ${prevUser}`.slice(0, 400);
  const wantsRanking = RANKING_RE.test(`${last.content} ${prevUser}`);
  const [docs, ranked] = await Promise.all([
    hybridSearch(env, query, { limit: 6 }),
    wantsRanking ? rankedReviews(env).catch(() => null) : null,
  ]);
  const { refs, text } = buildContext(docs);
  const rankedText = ranked ? rankedContext(ranked, refs) : "";

  const system: ChatMessage = {
    role: "system",
    content: `You are the friendly AI guide for PlayTested.net, speaking for the site. ${SITE_FACTS}${pageTitle ? `\nThe visitor is currently reading: "${pageTitle}".` : ""}

${CITE_RULE}

RULES:
- Answer from the material below: matching ARTICLES${rankedText ? ", plus the site-wide highest- and lowest-scored lists for questions about the best, top or worst games" : ""}.
- Talk as the site: "our review", "we scored it 9/10". The visitor can't see this material, so never mention "the articles", "the context", "the information provided" or what you were "given".
- If nothing below covers the question, say PlayTested hasn't reviewed that yet and suggest a related game we did review, or searching the site. You may add general gaming knowledge if you say it isn't from a PlayTested review. Never invent scores.
- Quote scores and verdicts accurately when you mention them.
- Keep it conversational and short: 2–4 sentences, or a tight list when comparing several games. Markdown bold and lists are fine; no headings.

ARTICLES:
${text || "(no matching articles)"}${rankedText ? `\n\n${rankedText}` : ""}`,
  };

  const upstream = await completeStream(
    env,
    "Chatbot",
    [system, ...messages.map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))],
    { maxTokens: 700 },
  );
  if (!upstream.ok || !upstream.body) {
    return error(502, "The AI service is unavailable right now.", { details: (await upstream.text()).slice(0, 300) });
  }
  return streamWithRefs(upstream, refs);
};

/** The "Ask AI" card on /search/: one short, cited answer to the query. */
const answer: Handler = async (request, env) => {
  const body = await readJson<{ q?: string }>(request);
  const q = String(body?.q ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (q.length < 3) return error(400, "Type a slightly longer question.");
  const blocked = await gate(env, request, "chat");
  if (blocked) return blocked;

  const [docs, ranked] = await Promise.all([
    hybridSearch(env, q, { limit: 5, chunks: 2 }),
    RANKING_RE.test(q) ? rankedReviews(env).catch(() => null) : null,
  ]);
  if (!docs.length && !ranked?.top.length) {
    return cannedStream("PlayTested hasn't covered anything that matches that yet. Try a game's name, a genre, or a platform.");
  }
  const { refs, text } = buildContext(docs);
  const rankedText = ranked ? rankedContext(ranked, refs) : "";
  const upstream = await completeStream(
    env,
    "Search Answer",
    [
      {
        role: "system",
        content: `You write the short answer box shown above PlayTested.net's search results. ${SITE_FACTS}

${CITE_RULE}

RULES:
- Answer the visitor's search directly in 2–4 sentences (under 90 words). If several games fit, use a short bulleted list (at most 5), each written like "[1] — 9/10".
- Use ONLY the material below${rankedText ? " (matching ARTICLES, plus site-wide highest- and lowest-scored lists for best/top/worst questions)" : ""}. If it doesn't answer the search, say in one sentence that PlayTested hasn't covered that — don't guess.
- No preamble ("Based on the articles…") and no headings. Never mention "the articles" or "the information provided"; speak as the site ("our review").

ARTICLES:
${text || "(no matching articles)"}${rankedText ? `\n\n${rankedText}` : ""}`,
      },
      { role: "user", content: q },
    ],
    { maxTokens: 350 },
  );
  if (!upstream.ok || !upstream.body) return error(502, "The AI service is unavailable right now.");
  return streamWithRefs(upstream, refs);
};

// ---------------------------------------------------------------------------
// Ask this review (Q&A grounded in one article)

const askReview: Handler = async (request, env) => {
  const body = await readJson<{ slug?: string; question?: string }>(request);
  const slug = String(body?.slug ?? "");
  const question = String(body?.question ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!SLUG_RE.test(slug)) return error(400, "Missing article.");
  if (question.length < 3) return error(400, "Type a slightly longer question.");
  const blocked = await gate(env, request, "askReview");
  if (blocked) return blocked;

  // This review's best passages for the question. If the index has little to
  // offer (vague question, article not indexed yet), add its intro and verdict.
  const [doc] = await hybridSearch(env, question, { slug, limit: 1, chunks: 4 });
  let title = doc?.title ?? "";
  let score = doc?.score ?? null;
  const passages = (doc?.chunks ?? []).map((c) => ({ idx: c.idx, heading: c.heading, text: c.text }));
  if (passages.length < 2) {
    const row = await env.DB.prepare("SELECT * FROM articles WHERE live_slug = ? AND live_json IS NOT NULL").bind(slug).first<ArticleRow>();
    const live = row ? liveOf(row) : null;
    if (live && Date.parse(live.pubDate) <= Date.now()) {
      title ||= live.title;
      score ??= live.score ?? null;
      const chunks = chunkArticle(live);
      for (const c of [chunks[0], chunks[chunks.length - 1], chunks[1]]) {
        if (c && passages.length < 4 && !passages.some((p) => p.idx === c.idx)) passages.push(c);
      }
    }
  }
  if (!passages.length) return error(404, "We couldn't find this review's text. Try again in a little while.");

  const refs: Record<string, { heading: string }> = {};
  const excerpts = passages.map((p, i) => {
    refs[`[${i + 1}]`] = { heading: p.heading };
    return `[${i + 1}]${p.heading ? ` (${p.heading})` : ""} ${p.text.slice(0, 1200)}`;
  });
  const upstream = await completeStream(
    env,
    "Ask Review",
    [
      {
        role: "system",
        content: `You answer visitors' questions about one PlayTested.net review: "${title}"${score !== null ? ` (scored ${score}/10)` : ""}.

RULES:
- Use ONLY the REVIEW EXCERPTS below — never facts from anywhere else.
- If the excerpts don't cover the question, say "The review doesn't cover that." and, if useful, mention what it does discuss.
- 1–3 sentences, under 70 words. Talk about "the review" (e.g. "The review praises…"). No citation markers, no headings.

REVIEW EXCERPTS:
${excerpts.join("\n\n")}`,
      },
      { role: "user", content: question },
    ],
    { maxTokens: 250 },
  );
  if (!upstream.ok || !upstream.body) return error(502, "The AI service is unavailable right now.");
  return streamWithRefs(upstream, refs);
};

// ---------------------------------------------------------------------------
// Summary (body read server-side from D1 — pages no longer embed the text)

const summary: Handler = async (request, env) => {
  const body = await readJson<{ slug?: string }>(request);
  const slug = String(body?.slug || "").slice(0, 200);
  if (!slug) return error(400, "Missing article.");
  const row = await env.DB.prepare("SELECT * FROM articles WHERE live_slug = ? AND live_json IS NOT NULL").bind(slug).first<ArticleRow>();
  const live = row && liveOf(row);
  // Scheduled posts stay private until their date (same 404 as a missing one).
  if (!row || !live || !(Date.parse(live.pubDate) <= Date.now())) return error(404, "Article not found.");

  const cacheKey = `summary:${slug}:${row.live_hash}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json({ summary: cached, cached: true });

  const blocked = await gate(env, request, "summary");
  if (blocked) return blocked;
  const text = await complete(
    env,
    "AI Summary",
    [
      {
        role: "system",
        content: "You summarize game reviews and articles. Be concise, objective, and don't mention the author's name.",
      },
      {
        role: "user",
        content: `Summarize this ${live.category || "article"} in at most 3 sentences. Capture the overall verdict and the key pros and cons.\n\nTitle: ${live.title}\n${live.score !== null && live.score !== undefined ? `Score: ${live.score}/10\n` : ""}\n${live.body.slice(0, 7000)}`,
      },
    ],
    { maxTokens: 250 },
  );
  if (!text) return error(502, "Couldn't generate a summary right now.");
  await env.CACHE.put(cacheKey, text, { expirationTtl: 60 * 60 * 24 * 60 });
  return json({ summary: text, cached: false });
};

// ---------------------------------------------------------------------------
// Recommender / comparator. Game data: IGDB first, RAWG as the fallback (games.ts).

// Edge-cached (shared per location, a no-op on workers.dev) so the 4 requests a
// second IGDB allows the whole site go a long way.
const GAME_CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
const edgeCache = (): Cache | undefined => (typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined);

/** Answer from the edge cache, or build the response and cache it if it worked. */
async function edgeCached(key: string, ctx: ExecutionContext, build: () => Promise<Response>): Promise<Response> {
  const cacheKey = new Request(key);
  const edge = edgeCache();
  const hit = await edge?.match(cacheKey).catch(() => undefined);
  if (hit) return hit;
  const res = await build();
  if (res.ok && edge) ctx.waitUntil(edge.put(cacheKey, res.clone()).catch(() => undefined));
  return res;
}

const unavailable = () => error(503, UNAVAILABLE, { code: "game_data_unavailable" });

/** Search results in RAWG's list shape ({ results }), whichever source answered. */
const gameSearch: Handler = async (request, env, ctx) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get("query") || "").trim().toLowerCase().slice(0, 100);
  if (!q) return error(400, "Missing search term");
  const blocked = await gate(env, request, "search");
  if (blocked) return blocked;
  return edgeCached(`${url.origin}/api/game-search?v=2&query=${encodeURIComponent(q)}`, ctx, async () => {
    const found = await searchGames(env, q, url.origin, ctx);
    if (!found) return unavailable();
    return json({ results: found.results, source: found.source }, { headers: { "Cache-Control": GAME_CACHE } });
  });
};

/** One game: ?slug=igdb-123 (IGDB) or a RAWG id/slug. */
const gameDetailsRoute: Handler = async (request, env, ctx) => {
  const url = new URL(request.url);
  const id = (url.searchParams.get("slug") || url.searchParams.get("id") || "").trim().toLowerCase().slice(0, 120);
  if (!id) return error(400, "Missing slug");
  const blocked = await gate(env, request, "search");
  if (blocked) return blocked;
  return edgeCached(`${url.origin}/api/game-details?v=2&id=${encodeURIComponent(id)}`, ctx, async () => {
    const g = await gameDetails(env, id, url.origin, ctx);
    if (g === null) return unavailable();
    if (g === undefined) return error(404, "We couldn't find that game.", { code: "game_not_found" });
    return json(g, { headers: { "Cache-Control": GAME_CACHE } });
  });
};

/** Reviews on this site that match a game title, best first. */
async function siteReviewsFor(env: Env, title: string, limit = 2) {
  const docs = await hybridSearch(env, title, { limit, semantic: false });
  return docs.filter((d) => d.title.toLowerCase().includes(title.toLowerCase().split(":")[0].slice(0, 20)));
}

const recommend: Handler = async (request, env, ctx) => {
  const body = await readJson<{ gameNames?: string[] }>(request);
  const games = (body?.gameNames ?? []).map((g) => String(g).slice(0, 100)).filter(Boolean).slice(0, 5);
  if (!games.length) return error(400, "No games provided.");
  const blocked = await gate(env, request, "recommend");
  if (blocked) return blocked;

  const titleLine = await complete(
    env,
    "Recommender",
    [
      { role: "system", content: "You are a game recommendation expert. Respond with ONLY a comma-separated list of exactly 3 game titles." },
      { role: "user", content: `The user enjoys: ${games.join(", ")}. Recommend exactly 3 modern games they might love.` },
    ],
    { maxTokens: 120 },
  );
  const titles = titleLine
    .split(",")
    .map((t) => t.trim().replace(/^\d+\.?\s*/, "").replace(/[.!?]$/, ""))
    .filter(Boolean)
    .slice(0, 3);
  if (titles.length < 3) return error(500, "Unable to generate sufficient recommendations.", { rawResponse: titleLine });

  const origin = new URL(request.url).origin;
  const enriched = await Promise.all(
    titles.map(async (title) => {
      const [g, reviews] = await Promise.all([findGame(env, title, origin, ctx).catch(() => null), siteReviewsFor(env, title, 1).catch(() => [])]);
      const review = reviews[0];
      return {
        title,
        name: g?.name || title,
        released: g?.released || "Unknown",
        image: g?.background_image || review?.thumb || null,
        slug: g?.slug || null,
        url: g?.url || null,
        source: g?.source ?? null,
        review: review ? { title: review.title, url: review.url, score: review.score } : null,
      };
    }),
  );

  const explanation = await complete(
    env,
    "Recommender",
    [
      { role: "system", content: "You are a helpful game recommendation analyst." },
      {
        role: "user",
        content: `The user enjoys: ${games.join(", ")}. You recommended: ${titles.join(", ")}.\nExplain in 3 short paragraphs — one per game — why they'd enjoy each one. Mention gameplay, story, style, or similarities. No bullet points or markdown.`,
      },
    ],
    { maxTokens: 700 },
  );
  return json({ recommended: enriched, explanation });
};

const compare: Handler = async (request, env) => {
  const body = await readJson<{ gameNames?: string[] }>(request);
  const games = (body?.gameNames ?? []).map((g) => String(g).slice(0, 100)).filter(Boolean).slice(0, 4);
  if (games.length < 2) return error(400, "Please provide at least two games to compare.");
  const blocked = await gate(env, request, "compare");
  if (blocked) return blocked;

  const reviews = await Promise.all(games.map((g) => siteReviewsFor(env, g, 1).catch(() => [])));
  const reviewContext = reviews
    .map((r, i) => (r[0] ? `PlayTested review of ${games[i]}: "${r[0].title}"${r[0].score ? ` (${r[0].score}/10)` : ""} — ${r[0].description ?? ""}` : ""))
    .filter(Boolean)
    .join("\n");
  const result = await complete(
    env,
    "Comparator",
    [
      { role: "system", content: "You are a concise gaming expert. Give brief, helpful comparisons in 1-2 paragraphs." },
      {
        role: "user",
        content: `Compare these games: ${games.join(", ")}. Focus on key differences in gameplay, story, and vibe.${reviewContext ? `\nUse these PlayTested verdicts where relevant:\n${reviewContext}` : ""}`,
      },
    ],
    { maxTokens: 450 },
  );
  return json({
    result: result || "No response.",
    reviews: reviews.map((r) => (r[0] ? { title: r[0].title, url: r[0].url, score: r[0].score } : null)),
  });
};

export const publicRoutes: Record<string, { method: string; handler: Handler }> = {
  "/api/search": { method: "GET", handler: search },
  "/api/chat": { method: "POST", handler: chat },
  "/api/answer": { method: "POST", handler: answer },
  "/api/ask-review": { method: "POST", handler: askReview },
  "/api/summary": { method: "POST", handler: summary },
  "/api/recommend": { method: "POST", handler: recommend },
  "/api/compare": { method: "POST", handler: compare },
  // The old RAWG-named paths stay as aliases (cached pages and bookmarks).
  "/api/game-search": { method: "GET", handler: gameSearch },
  "/api/rawg-search": { method: "GET", handler: gameSearch },
  "/api/query": { method: "GET", handler: gameSearch },
  "/api/game-details": { method: "GET", handler: gameDetailsRoute },
  "/api/rawg-game-details": { method: "GET", handler: gameDetailsRoute },
};
