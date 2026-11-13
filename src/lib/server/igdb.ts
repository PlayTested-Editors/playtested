/**
 * IGDB, Twitch's game database: the first source of game data (RAWG is the
 * fallback, see games.ts) and a source of official screenshots.
 *
 * Runs only in the Worker. The client secret goes to Twitch's token endpoint in
 * a POST body and nowhere else: never in a URL, a log line, an error message or
 * a response. Results are normalised to the subset of RAWG's game shape the
 * site reads, with ids prefixed "igdb-" so they can't clash with RAWG's.
 */
import type { Env } from "./env";

const API = "https://api.igdb.com/v4";
const IMG = "https://images.igdb.com/igdb/image/upload";
const TOKEN_KEY = "igdb:token";
const TIMEOUT_MS = 6000;

/**
 * IGDB's game_type (it replaced the deprecated `category`): 0 main game,
 * 4 standalone expansion, 8 remake, 9 remaster, 10 expanded game, 11 port.
 * Left out: DLC (1), expansions (2), bundles (3), mods (5), episodes (6),
 * seasons (7), forks (12), packs (13), updates (14).
 */
export const GAME_TYPES = [0, 4, 8, 9, 10, 11];

/**
 * Within one search, originals and remakes come before remasters and ports:
 * IGDB ranks Resident Evil 4's 2011 HD remaster above the 2005 original and
 * the 2023 remake. The order within a rank stays IGDB's.
 */
const TYPE_RANK: Record<number, number> = { 0: 0, 8: 0, 4: 1, 9: 1, 10: 1, 11: 2 };
const rankOf = (g: { game_type?: number }) => TYPE_RANK[g.game_type ?? 0] ?? 1;

/** The subset of RAWG's game shape the site reads, plus where it came from. */
export interface GameResult {
  id: number | string;
  slug: string;
  name: string;
  /** YYYY-MM-DD, or null when unknown. */
  released: string | null;
  background_image: string | null;
  /** Absent means unknown, never "on no platforms". */
  parent_platforms?: { platform: { name: string } }[];
  /** The game's page on its source site. */
  url: string | null;
  source: "igdb" | "rawg";
}

/** Extra detail for one game (the details endpoint). No score: IGDB has no Metacritic. */
export interface GameDetails extends GameResult {
  description_raw: string | null;
  genres: { name: string }[];
  developers: { name: string }[];
  publishers: { name: string }[];
  metacritic: null;
}

export class IgdbError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
  /** Too many requests even after a retry: fall back for this request only. */
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

export const igdbConfigured = (env: Env): boolean => Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);

// ---------------------------------------------------------------------------
// Token: memory first (this isolate), then KV (shared, one write per ~60 days),
// then Twitch. Reused until 5 minutes before it expires.

type Token = { value: string; exp: number };
let memToken: Token | null = null;
const MARGIN_MS = 5 * 60_000;

async function getToken(env: Env, fresh: boolean): Promise<string> {
  const now = Date.now();
  if (!fresh && memToken && memToken.exp - MARGIN_MS > now) return memToken.value;
  if (!fresh) {
    const saved = await env.CACHE.get(TOKEN_KEY).catch(() => null);
    if (saved) {
      try {
        const t = JSON.parse(saved) as Token;
        if (t.value && t.exp - MARGIN_MS > now) return (memToken = t).value;
      } catch {
        /* fetch a new one */
      }
    }
  }
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID!, client_secret: env.TWITCH_CLIENT_SECRET!, grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new IgdbError(`IGDB sign-in failed (${r.status})`, r.status);
  const d = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!d.access_token || !d.expires_in) throw new IgdbError("IGDB sign-in returned no token");
  memToken = { value: d.access_token, exp: now + d.expires_in * 1000 };
  await env.CACHE.put(TOKEN_KEY, JSON.stringify(memToken), { expirationTtl: Math.max(60, d.expires_in - 600) }).catch(() => undefined);
  return memToken.value;
}

async function dropToken(env: Env): Promise<void> {
  memToken = null;
  await env.CACHE.delete(TOKEN_KEY).catch(() => undefined);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One IGDB query (Apicalypse text). On a 401 the token is replaced once; on a
 * 429 (4 requests a second for the whole app) it waits 400 ms and retries once.
 */
export async function igdbQuery<T>(env: Env, endpoint: string, body: string): Promise<T> {
  if (!igdbConfigured(env)) throw new IgdbError("IGDB is not configured");
  let renewed = false;
  let waited = false;
  for (;;) {
    const token = await getToken(env, false);
    const r = await fetch(`${API}/${endpoint}`, {
      method: "POST",
      headers: { "Client-ID": env.TWITCH_CLIENT_ID!, Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "text/plain" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status === 401 && !renewed) {
      renewed = true;
      await dropToken(env);
      continue;
    }
    if (r.status === 429 && !waited) {
      waited = true;
      await sleep(400);
      continue;
    }
    if (!r.ok) throw new IgdbError(`IGDB ${endpoint} failed (${r.status})`, r.status);
    return (await r.json()) as T;
  }
}

// ---------------------------------------------------------------------------
// Normalising

type ImageRef = { image_id?: string };
interface IgdbGame {
  id: number;
  name: string;
  slug?: string;
  url?: string;
  first_release_date?: number;
  game_type?: number;
  summary?: string;
  genres?: { name?: string }[];
  platforms?: { name?: string }[];
  cover?: ImageRef;
  artworks?: ImageRef[];
  screenshots?: ImageRef[];
  involved_companies?: { company?: { name?: string }; developer?: boolean; publisher?: boolean }[];
}

/** "hades ii" stays as typed; quotes and backslashes can't break out of the query. */
const quote = (s: string) => `"${s.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;

export const imageUrl = (id: string, size: string) => `${IMG}/t_${size}/${id}.jpg`;

/** Unix seconds (UTC) → YYYY-MM-DD. */
export function isoDate(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * IGDB platform → the platform family the site shows (RAWG's parent platform
 * names: "PC", "PlayStation", "Xbox", "Nintendo", …). Null when the site has no
 * family for it (VR headsets, arcade…).
 */
export function platformFamily(name: string): string | null {
  const n = name.trim();
  if (/windows|^dos$/i.test(n)) return "PC"; // not "PC Engine" (an NEC console)
  if (/playstation|^psp$|ps ?vita/i.test(n)) return "PlayStation";
  if (/xbox/i.test(n)) return "Xbox";
  if (/nintendo|wii|game ?boy|switch|famicom|gamecube|virtual boy|^(super )?nes$|\b3?ds\b/i.test(n)) return "Nintendo";
  if (/^mac$|mac ?os/i.test(n)) return "Apple Macintosh";
  if (/^ios$/i.test(n)) return "iOS";
  if (/^android$/i.test(n)) return "Android";
  if (/^linux$/i.test(n)) return "Linux";
  if (/web browser/i.test(n)) return "Web";
  if (/sega|dreamcast|genesis|mega drive|saturn|game gear|master system/i.test(n)) return "SEGA";
  if (/atari/i.test(n)) return "Atari";
  if (/amiga|commodore/i.test(n)) return "Commodore / Amiga";
  if (/neo ?geo/i.test(n)) return "Neo Geo";
  if (/\b3do\b/i.test(n)) return "3DO";
  return null;
}

const FAMILY_ORDER = ["PC", "PlayStation", "Xbox", "Nintendo", "Apple Macintosh", "Linux", "iOS", "Android", "Web", "SEGA", "Atari", "Commodore / Amiga", "Neo Geo", "3DO"];

/** Families in the site's usual order; undefined (unknown) when IGDB lists none we can show. */
export function platformFamilies(platforms: { name?: string }[] | undefined): { platform: { name: string } }[] | undefined {
  const found = new Set((platforms ?? []).map((p) => (p.name ? platformFamily(p.name) : null)).filter((f): f is string => Boolean(f)));
  if (!found.size) return undefined;
  return FAMILY_ORDER.filter((f) => found.has(f)).map((name) => ({ platform: { name } }));
}

/** A wide picture for cards (artwork, else a screenshot), else the portrait cover. */
function pictureOf(g: IgdbGame): string | null {
  const wide = g.artworks?.find((a) => a.image_id)?.image_id ?? g.screenshots?.find((s) => s.image_id)?.image_id;
  if (wide) return imageUrl(wide, "screenshot_big");
  return g.cover?.image_id ? imageUrl(g.cover.image_id, "cover_big") : null;
}

export function normaliseGame(g: IgdbGame): GameResult {
  return {
    id: `igdb-${g.id}`,
    slug: g.slug ?? String(g.id),
    name: g.name,
    released: isoDate(g.first_release_date),
    background_image: pictureOf(g),
    parent_platforms: platformFamilies(g.platforms),
    url: g.url ?? (g.slug ? `https://www.igdb.com/games/${g.slug}` : null),
    source: "igdb",
  };
}

const LIST_FIELDS = "fields name,slug,url,first_release_date,game_type,platforms.name,cover.image_id,artworks.image_id,screenshots.image_id;";
const DETAIL_FIELDS =
  "fields name,slug,url,first_release_date,summary,genres.name,platforms.name,cover.image_id,artworks.image_id,screenshots.image_id," +
  "involved_companies.company.name,involved_companies.publisher,involved_companies.developer;";
const MAIN_GAMES = `where version_parent = null & game_type = (${GAME_TYPES.join(",")});`;

export async function igdbSearch(env: Env, q: string, limit = 10): Promise<GameResult[]> {
  const rows = await igdbQuery<IgdbGame[]>(env, "games", `search ${quote(q)}; ${LIST_FIELDS} ${MAIN_GAMES} limit ${limit};`);
  return rows
    .filter((g) => g.name)
    .map((g, i) => ({ g, i }))
    .sort((a, b) => rankOf(a.g) - rankOf(b.g) || a.i - b.i)
    .map(({ g }) => normaliseGame(g));
}

/** One game by IGDB id (the number after "igdb-"), or null if IGDB has no such game. */
export async function igdbGame(env: Env, id: number): Promise<GameDetails | null> {
  const [g] = await igdbQuery<IgdbGame[]>(env, "games", `${DETAIL_FIELDS} where id = ${Math.trunc(id)}; limit 1;`);
  if (!g) return null;
  const companies = g.involved_companies ?? [];
  const names = (pick: (c: (typeof companies)[number]) => boolean | undefined) =>
    companies.filter(pick).map((c) => c.company?.name).filter((n): n is string => Boolean(n)).map((name) => ({ name }));
  return {
    ...normaliseGame(g),
    description_raw: g.summary ?? null,
    genres: (g.genres ?? []).map((x) => x.name).filter((n): n is string => Boolean(n)).map((name) => ({ name })),
    developers: names((c) => c.developer),
    publishers: names((c) => c.publisher),
    metacritic: null,
  };
}

// ---------------------------------------------------------------------------
// Screenshots (the studio's Find screenshots)

export async function igdbShotSearch(env: Env, q: string): Promise<{ id: string; name: string; year?: string }[]> {
  const rows = await igdbQuery<IgdbGame[]>(env, "games", `search ${quote(q)}; fields name,first_release_date; ${MAIN_GAMES} limit 6;`);
  return rows.filter((g) => g.name).map((g) => ({ id: String(g.id), name: g.name, year: isoDate(g.first_release_date)?.slice(0, 4) }));
}

export async function igdbShots(env: Env, id: string): Promise<{ thumb: string; full: string }[]> {
  if (!/^\d{1,12}$/.test(id)) return [];
  const [g] = await igdbQuery<IgdbGame[]>(env, "games", `fields screenshots.image_id; where id = ${id}; limit 1;`);
  return (g?.screenshots ?? [])
    .map((s) => s.image_id)
    .filter((x): x is string => Boolean(x))
    .map((x) => ({ thumb: imageUrl(x, "screenshot_med"), full: imageUrl(x, "1080p") }));
}
