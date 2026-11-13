/**
 * Game data for the AI pages (search, recommendations, details): IGDB first,
 * RAWG as the fallback. A source that fails is skipped for a few minutes
 * (a "down" flag in this isolate and in the edge cache), so visitors don't all
 * wait on a dead API. Same shape from both: see GameResult in igdb.ts.
 */
import type { Env } from "./env";
import { igdbConfigured, igdbGame, igdbSearch, type GameDetails, type GameResult } from "./igdb";
import { normName } from "./screenshots";

export type Source = "igdb" | "rawg";

const RAWG_TIMEOUT_MS = 7000;
const DOWN_MS = 5 * 60_000;
const UA = "PlayTested/1.0 (lyndon@playtested.net)";

/** Shown when no source could answer. */
export const UNAVAILABLE = "We couldn't load this game's details just now. Please try again in a moment.";

// ---------------------------------------------------------------------------
// "Down" flags

const downUntil = new Map<Source, number>();

const edgeCache = (): Cache | undefined => (typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined);
const flagKey = (origin: string, s: Source) => new Request(`${origin}/__source-down/${s}`);

export async function isDown(s: Source, origin: string): Promise<boolean> {
  if ((downUntil.get(s) ?? 0) > Date.now()) return true;
  const hit = await edgeCache()
    ?.match(flagKey(origin, s))
    .catch(() => undefined);
  if (!hit) return false;
  downUntil.set(s, Date.now() + 60_000); // trust the shared flag for a minute here
  return true;
}

export function markDown(s: Source, origin: string, ctx: ExecutionContext): void {
  downUntil.set(s, Date.now() + DOWN_MS);
  const edge = edgeCache();
  if (edge) ctx.waitUntil(edge.put(flagKey(origin, s), new Response("down", { headers: { "Cache-Control": `max-age=${DOWN_MS / 1000}` } })).catch(() => undefined));
}

// ---------------------------------------------------------------------------
// RAWG

async function rawgJson<T>(env: Env, path: string): Promise<T> {
  if (!env.RAWG_API_KEY) throw new Error("RAWG is not configured");
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`https://api.rawg.io/api${path}${sep}key=${encodeURIComponent(env.RAWG_API_KEY)}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(RAWG_TIMEOUT_MS),
  });
  if (r.status === 404) throw Object.assign(new Error("RAWG: not found"), { notFound: true });
  if (!r.ok) throw new Error(`RAWG failed (${r.status})`);
  return (await r.json()) as T;
}

interface RawgGame {
  id: number;
  slug: string;
  name: string;
  released?: string | null;
  background_image?: string | null;
  parent_platforms?: { platform: { name: string } }[] | null;
}

function fromRawg(g: RawgGame): GameResult {
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    released: g.released ?? null,
    background_image: g.background_image ?? null,
    // RAWG sometimes sends an empty list for "not listed yet": treat as unknown.
    parent_platforms: g.parent_platforms?.length ? g.parent_platforms : undefined,
    url: g.slug ? `https://rawg.io/games/${g.slug}` : null,
    source: "rawg",
  };
}

async function rawgSearch(env: Env, q: string, limit: number): Promise<GameResult[]> {
  const data = await rawgJson<{ results?: RawgGame[] }>(env, `/games?search=${encodeURIComponent(q)}&page_size=${limit}`);
  return (data.results ?? []).filter((g) => g.name).map(fromRawg);
}

// ---------------------------------------------------------------------------
// Public API

const notFound = (e: unknown) => Boolean((e as { notFound?: boolean })?.notFound);

/**
 * Games matching `q`: IGDB, else RAWG. IGDB finding nothing also asks RAWG
 * (it knows some small titles IGDB doesn't). Null only when every source failed.
 */
export async function searchGames(env: Env, q: string, origin: string, ctx: ExecutionContext, limit = 10): Promise<{ results: GameResult[]; source: Source } | null> {
  let answered = false;
  if (igdbConfigured(env) && !(await isDown("igdb", origin))) {
    try {
      const results = await igdbSearch(env, q, limit);
      if (results.length) return { results, source: "igdb" };
      answered = true;
    } catch (e) {
      // A 429 after the retry is momentary: fall back for this request only.
      if ((e as { status?: number }).status !== 429) markDown("igdb", origin, ctx);
    }
  }
  if (env.RAWG_API_KEY && !(await isDown("rawg", origin))) {
    try {
      return { results: await rawgSearch(env, q, limit), source: "rawg" };
    } catch {
      markDown("rawg", origin, ctx);
    }
  }
  return answered ? { results: [], source: "igdb" } : null;
}

/** Best single match for a title (exact name first), from whichever source answers. */
export async function findGame(env: Env, title: string, origin: string, ctx: ExecutionContext): Promise<GameResult | null> {
  const found = await searchGames(env, title, origin, ctx, 5);
  if (!found?.results.length) return null;
  const want = normName(title);
  return found.results.find((g) => normName(g.name) === want) ?? found.results[0];
}

/**
 * One game by id: "igdb-123" from IGDB, anything else (a RAWG id or slug) from
 * RAWG. Undefined = no such game; null = the source couldn't be reached.
 */
export async function gameDetails(env: Env, id: string, origin: string, ctx: ExecutionContext): Promise<GameDetails | Record<string, unknown> | null | undefined> {
  const igdb = /^igdb-(\d{1,12})$/.exec(id);
  if (igdb) {
    if (!igdbConfigured(env) || (await isDown("igdb", origin))) return null;
    try {
      return (await igdbGame(env, Number(igdb[1]))) ?? undefined;
    } catch (e) {
      if ((e as { status?: number }).status !== 429) markDown("igdb", origin, ctx);
      return null;
    }
  }
  if (!env.RAWG_API_KEY || (await isDown("rawg", origin))) return null;
  try {
    const g = await rawgJson<RawgGame & Record<string, unknown>>(env, `/games/${encodeURIComponent(id)}`);
    return { ...g, ...fromRawg(g), metacritic: g.metacritic ?? null };
  } catch (e) {
    if (notFound(e)) return undefined;
    markDown("rawg", origin, ctx);
    return null;
  }
}
