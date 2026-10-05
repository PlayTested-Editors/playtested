/**
 * Public API (site visitors). Every live feature goes through gate() first:
 * feature switch + watchdog level, per-visitor rate limit, then daily cap.
 */
import type { Env } from "../env";
import { gate } from "../guards";
import { complete, completeStream, type ChatMessage } from "../openrouter";
import { hybridSearch } from "../search";
import { error, json } from "../util";
import { liveOf, type ArticleRow } from "../articles";

type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search

const search: Handler = async (request, env) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
  if (q.length < 2) return json({ results: [] });
  const blocked = await gate(env, request, "search");
  if (blocked) return blocked;
  const results = await hybridSearch(env, q, { limit: Math.min(Number(url.searchParams.get("limit")) || 12, 30) });
  return json({ q, results }, { headers: { "Cache-Control": "public, max-age=300" } });
};

// ---------------------------------------------------------------------------
// Chat (site-wide, RAG over full articles)

const SITE_FACTS = `PlayTested.net is a gaming and tech review site run by lyndonguitar (Lyndon), with reviews of PC, console and mobile games scored out of 10.`;

function buildContext(docs: Awaited<ReturnType<typeof hybridSearch>>) {
  const refs: Record<string, string> = {};
  const blocks = docs.map((d, i) => {
    const n = i + 1;
    refs[`[${n}]`] = `https://playtested.net${d.url}::${d.title}`;
    const passages = d.chunks.map((c) => `${c.heading ? `(${c.heading}) ` : ""}${c.text.slice(0, 900)}`).join("\n…\n");
    const score = d.score !== null && d.score !== undefined ? ` | Score: ${d.score}/10` : "";
    const date = d.pubDate ? new Date(d.pubDate).toISOString().slice(0, 10) : "N/A";
    return `[${n}] "${d.title}" by ${d.author || "lyndonguitar"} | ${date}${score}\n${passages}`;
  });
  return { refs, text: blocks.join("\n\n") };
}

const chat: Handler = async (request, env) => {
  const body = await readJson<{ messages?: ChatMessage[] }>(request);
  const messages = (body?.messages ?? []).filter((m) => m && (m.role === "user" || m.role === "assistant")).slice(-8);
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !last.content?.trim()) return error(400, "No question provided.");
  const blocked = await gate(env, request, "chat");
  if (blocked) return blocked;

  // Retrieve with the latest question plus a little conversational context.
  const prevUser = messages.filter((m) => m.role === "user").slice(-2, -1)[0]?.content ?? "";
  const query = `${last.content} ${prevUser}`.slice(0, 400);
  const docs = await hybridSearch(env, query, { limit: 6 });
  const { refs, text } = buildContext(docs);

  const system: ChatMessage = {
    role: "system",
    content: `You are the friendly AI guide for PlayTested.net. ${SITE_FACTS}

HOW TO CITE: each article below has a number like [1]. Write the number in place of the game's title — it renders as a clickable title. GOOD: "You should try [1]." BAD: "You should try Elden Ring [1]."

RULES:
- Answer from the ARTICLES below. If they don't cover the question, say so briefly and answer generally, suggesting what to search on the site.
- Quote scores and verdicts accurately when you mention them.
- Keep it conversational and short: 2–4 sentences, or a tight list when comparing several games.

ARTICLES:
${text || "(no matching articles)"}`,
  };

  const upstream = await completeStream(env, "Chatbot", [system, ...messages.map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))]);
  if (!upstream.ok || !upstream.body) {
    return error(502, "The AI service is unavailable right now.", { details: (await upstream.text()).slice(0, 300) });
  }
  const prefix = new TextEncoder().encode(`<!--REFS:${JSON.stringify(refs)}:REFS-->\n`);
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(prefix);
      const reader = upstream.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
};

// ---------------------------------------------------------------------------
// Summary (body read server-side from D1 — pages no longer embed the text)

const summary: Handler = async (request, env) => {
  const body = await readJson<{ slug?: string }>(request);
  const slug = String(body?.slug || "").slice(0, 200);
  if (!slug) return error(400, "Missing article.");
  const row = await env.DB.prepare("SELECT * FROM articles WHERE slug = ? AND live_json IS NOT NULL").bind(slug).first<ArticleRow>();
  const live = row && liveOf(row);
  if (!row || !live) return error(404, "Article not found.");

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
// Recommender / comparator (ported; RAWG for game data)

async function rawgFetch(env: Env, path: string): Promise<Response> {
  if (!env.RAWG_API_KEY) return error(500, "RAWG_API_KEY is missing on this environment");
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`https://api.rawg.io/api${path}${sep}key=${encodeURIComponent(env.RAWG_API_KEY)}`, {
    headers: { "User-Agent": "PlayTested/1.0 (lyndon@playtested.net)", Accept: "application/json" },
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: { "Content-Type": "application/json", "Cache-Control": r.ok ? "public, max-age=86400" : "no-store" },
  });
}

const rawgSearch: Handler = async (request, env) => {
  const q = new URL(request.url).searchParams.get("query");
  if (!q) return error(400, "Missing search term");
  const blocked = await gate(env, request, "search");
  if (blocked) return blocked;
  return rawgFetch(env, `/games?search=${encodeURIComponent(q.slice(0, 100))}&page_size=10`);
};

const rawgDetails: Handler = async (request, env) => {
  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug) return error(400, "Missing slug");
  return rawgFetch(env, `/games/${encodeURIComponent(slug.slice(0, 120))}`);
};

/** Reviews on this site that match a game title, best first. */
async function siteReviewsFor(env: Env, title: string, limit = 2) {
  const docs = await hybridSearch(env, title, { limit, semantic: false });
  return docs.filter((d) => d.title.toLowerCase().includes(title.toLowerCase().split(":")[0].slice(0, 20)));
}

const recommend: Handler = async (request, env) => {
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

  const enriched = await Promise.all(
    titles.map(async (title) => {
      const [rawg, reviews] = await Promise.all([
        env.RAWG_API_KEY
          ? fetch(`https://api.rawg.io/api/games?key=${env.RAWG_API_KEY}&search=${encodeURIComponent(title)}&page_size=1`)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          : Promise.resolve(null),
        siteReviewsFor(env, title, 1).catch(() => []),
      ]);
      const g = (rawg as { results?: { name: string; released: string; background_image: string; slug: string }[] } | null)?.results?.[0];
      const review = reviews[0];
      return {
        title,
        name: g?.name || title,
        released: g?.released || "Unknown",
        image: g?.background_image || review?.thumb || null,
        slug: g?.slug || null,
        url: g?.slug ? `https://rawg.io/games/${g.slug}` : null,
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
  "/api/summary": { method: "POST", handler: summary },
  "/api/recommend": { method: "POST", handler: recommend },
  "/api/compare": { method: "POST", handler: compare },
  "/api/rawg-search": { method: "GET", handler: rawgSearch },
  "/api/query": { method: "GET", handler: rawgSearch },
  "/api/rawg-game-details": { method: "GET", handler: rawgDetails },
};
