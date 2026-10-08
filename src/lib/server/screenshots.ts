/**
 * "Find screenshots" for the studio's image picker: official screenshots by
 * game name, from Steam first (1920×1080, no key) and RAWG as the fallback
 * (console exclusives). Results are cached in KV so a search costs at most a
 * few outbound calls once a day. Picked images are fetched through
 * proxyScreenshot() (the CDNs don't allow the browser to read them) and then
 * uploaded like any other image.
 */
import type { Env } from "./env";

export type ShotSource = "steam" | "rawg";
export interface ShotMatch {
  source: ShotSource;
  id: string;
  name: string;
  year?: string;
}
export interface Shot {
  thumb: string;
  full: string;
}

const UA = "PlayTested/1.0 (lyndon@playtested.net)";
const SEARCH_TTL = 24 * 3600;
const SHOTS_TTL = 7 * 24 * 3600;

/** "Marvel’s Spider-Man™ 2" → "marvels spider man 2" */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’'`™®©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|game of the year|goty|edition|remastered|definitive)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function cached<T>(env: Env, key: string, ttl: number, load: () => Promise<T | null>): Promise<T | null> {
  const hit = await env.CACHE.get(key);
  if (hit) return JSON.parse(hit) as T;
  const value = await load();
  // Don't cache failures (an outage would stick for a day).
  if (value !== null) await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
  return value;
}

// --- Steam -----------------------------------------------------------------

async function steamSearch(q: string): Promise<ShotMatch[] | null> {
  const data = await getJson<{ items?: { type?: string; id: number; name: string }[] }>(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&cc=us&l=en`,
  );
  if (!data) return null;
  return (data.items ?? [])
    .filter((i) => !i.type || i.type === "app")
    .slice(0, 6)
    .map((i) => ({ source: "steam" as const, id: String(i.id), name: i.name }));
}

async function steamShots(id: string): Promise<Shot[] | null> {
  const data = await getJson<Record<string, { success: boolean; data?: { screenshots?: { path_thumbnail: string; path_full: string }[] } }>>(
    `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(id)}&cc=us&l=en`,
  );
  const entry = data?.[id];
  if (!entry) return null;
  return (entry.data?.screenshots ?? []).map((s) => ({ thumb: s.path_thumbnail, full: s.path_full }));
}

// --- RAWG ------------------------------------------------------------------

function rawgUrl(env: Env, path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `https://api.rawg.io/api${path}${sep}key=${encodeURIComponent(env.RAWG_API_KEY ?? "")}`;
}

/** RAWG serves resized copies under /media/resize/<w>/-/… */
function rawgThumb(url: string): string {
  return url.replace("https://media.rawg.io/media/", "https://media.rawg.io/media/resize/640/-/");
}

async function rawgSearch(env: Env, q: string): Promise<ShotMatch[] | null> {
  if (!env.RAWG_API_KEY) return [];
  const data = await getJson<{ results?: { id: number; name: string; released?: string | null }[] }>(
    rawgUrl(env, `/games?search=${encodeURIComponent(q)}&page_size=6`),
  );
  if (!data) return null;
  return (data.results ?? []).map((g) => ({
    source: "rawg" as const,
    id: String(g.id),
    name: g.name,
    year: g.released?.slice(0, 4) || undefined,
  }));
}

async function rawgShots(env: Env, id: string): Promise<Shot[] | null> {
  if (!env.RAWG_API_KEY) return [];
  const data = await getJson<{ results?: { image: string; is_deleted?: boolean }[] }>(
    rawgUrl(env, `/games/${encodeURIComponent(id)}/screenshots?page_size=40`),
  );
  if (!data) return null;
  return (data.results ?? []).filter((s) => s.image && !s.is_deleted).map((s) => ({ thumb: rawgThumb(s.image), full: s.image }));
}

// --- Search ----------------------------------------------------------------

/** Steam's search is fuzzy: only trust a result whose name really matches. */
function sameGame(a: string, b: string): boolean {
  const x = normName(a), y = normName(b);
  return !!x && !!y && (x === y || x.startsWith(y + " ") || y.startsWith(x + " "));
}

export async function findScreenshots(
  env: Env,
  q: string,
  pick?: { source: ShotSource; id: string },
): Promise<{ matches: ShotMatch[]; current: ShotMatch | null; shots: Shot[] }> {
  const key = normName(q).slice(0, 80);
  const [steam, rawg] = key
    ? await Promise.all([
        cached(env, `shots:search:steam:${key}`, SEARCH_TTL, () => steamSearch(q)),
        cached(env, `shots:search:rawg:${key}`, SEARCH_TTL, () => rawgSearch(env, q)),
      ])
    : [[], []];
  const matches = [...(steam ?? []), ...(rawg ?? [])];

  let current: ShotMatch | null = null;
  if (pick) current = matches.find((m) => m.source === pick.source && m.id === pick.id) ?? { ...pick, name: q };
  else {
    // Steam first when it has this exact game; otherwise RAWG's match (console
    // exclusives); otherwise the closest of either.
    current =
      (steam ?? []).find((m) => sameGame(m.name, q)) ??
      (rawg ?? []).find((m) => sameGame(m.name, q)) ??
      (rawg ?? [])[0] ??
      (steam ?? [])[0] ??
      null;
  }

  let shots: Shot[] = [];
  if (current) {
    const c = current;
    shots =
      (await cached(env, `shots:${c.source}:${c.id}`, SHOTS_TTL, () => (c.source === "steam" ? steamShots(c.id) : rawgShots(env, c.id)))) ?? [];
    // A Steam page without screenshots: try the same game on RAWG.
    if (!shots.length && c.source === "steam" && !pick) {
      const alt = (rawg ?? []).find((m) => sameGame(m.name, c.name));
      if (alt) {
        const more = await cached(env, `shots:rawg:${alt.id}`, SHOTS_TTL, () => rawgShots(env, alt.id));
        if (more?.length) {
          current = alt;
          shots = more;
        }
      }
    }
  }
  return { matches, current, shots };
}

// --- Image proxy -----------------------------------------------------------

const MAX_BYTES = 15 * 1024 * 1024;

function allowedImageHost(u: URL): boolean {
  const h = u.hostname;
  return u.protocol === "https:" && (h.endsWith(".steamstatic.com") || h === "steamcdn-a.akamaihd.net" || h === "media.rawg.io");
}

/** Fetch a Steam/RAWG image for the browser to re-encode and upload. */
export async function proxyScreenshot(raw: string): Promise<Response> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return new Response("Bad image address.", { status: 400 });
  }
  if (!allowedImageHost(u)) return new Response("Only Steam and RAWG images.", { status: 400 });
  const r = await fetch(u.toString(), { headers: { "User-Agent": UA } });
  const type = (r.headers.get("content-type") || "").split(";")[0].trim();
  if (!r.ok || !type.startsWith("image/")) return new Response("Couldn't fetch that image.", { status: 502 });
  if (Number(r.headers.get("content-length") || 0) > MAX_BYTES) return new Response("Image is too large.", { status: 413 });
  return new Response(r.body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" } });
}
