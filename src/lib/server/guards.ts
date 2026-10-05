/**
 * Usage guards that keep the site inside Cloudflare's free plan.
 *
 * Built pages never reach the Worker, so these only govern the live parts:
 * AI features, search, and the live fallback for not-yet-built articles.
 *
 * Levels (set by the watchdog in "auto" mode, or forced from the studio):
 *   0 normal    – everything on
 *   1 conserve  – live fallback, recommender and comparator off
 *   2 essential – every public live feature off (static site + studio only)
 */
import type { Env } from "./env";
import { clientIp, json, now, parseJson, utcDay } from "./util";

export type Level = 0 | 1 | 2;
export type DegradeMode = "auto" | "normal" | "conserve" | "essential";
export type Feature = "chat" | "summary" | "search" | "recommend" | "compare" | "askReview" | "comments" | "liveFallback";

export interface UsageSnapshot {
  day: string;
  total: number;
  byScript: Record<string, number>;
  checkedAt: number;
  error?: string;
}

export interface GuardSettings {
  mode: DegradeMode;
  autoLevel: Level;
  dailyLimit: number;
  /** Percent of dailyLimit at which auto mode steps down. */
  thresholds: { conserve: number; essential: number };
  /** How long a freshly published article is rendered live before its build lands. */
  liveFallbackMinutes: number;
  features: Record<Feature, boolean>;
  /** Per-feature calls allowed per UTC day; 0 = unlimited. */
  caps: Record<Feature, number>;
  usage?: UsageSnapshot;
  alerted?: { day: string; level: Level };
}

export const DEFAULT_GUARDS: GuardSettings = {
  mode: "auto",
  autoLevel: 0,
  dailyLimit: 100_000,
  thresholds: { conserve: 60, essential: 85 },
  liveFallbackMinutes: 30,
  features: {
    chat: true,
    summary: true,
    search: true,
    recommend: true,
    compare: true,
    askReview: true,
    comments: true,
    liveFallback: true,
  },
  caps: {
    chat: 600,
    summary: 150,
    search: 3000,
    recommend: 200,
    compare: 200,
    askReview: 400,
    comments: 8000,
    liveFallback: 0,
  },
};

/** The level at which each feature switches off. */
const OFF_AT: Record<Feature, Level> = {
  liveFallback: 1,
  recommend: 1,
  compare: 1,
  chat: 2,
  summary: 2,
  search: 2,
  askReview: 2,
  comments: 2,
};

const LIMITER: Record<Feature, "RL_AI" | "RL_SEARCH" | null> = {
  chat: "RL_AI",
  summary: "RL_AI",
  recommend: "RL_AI",
  compare: "RL_AI",
  askReview: "RL_AI",
  search: "RL_SEARCH",
  comments: "RL_SEARCH",
  liveFallback: null,
};

/** Per-visitor requests allowed per minute. */
const LIMITS: Record<"RL_AI" | "RL_SEARCH" | "RL_AUTH", number> = { RL_AI: 10, RL_SEARCH: 40, RL_AUTH: 10 };

// Rate limits are counted in D1 (one row per visitor+feature, fixed one-minute
// windows). The Workers rate-limit binding didn't enforce anything on the free
// plan in testing, and in-memory counters don't work because consecutive
// requests land on different machines. D1 is shared, so the limit holds.
function rateStatement(env: Env, key: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window = excluded.window THEN rate_limits.count + 1 ELSE 1 END,
       window = excluded.window
     RETURNING count`,
  ).bind(key, Math.floor(now() / 60_000));
}

/** True when this visitor is still within the per-minute limit. */
export async function withinRate(env: Env, name: "RL_AI" | "RL_SEARCH" | "RL_AUTH", key: string): Promise<boolean> {
  try {
    const row = await rateStatement(env, `${name}:${key}`).first<{ count: number }>();
    return (row?.count ?? 0) <= LIMITS[name];
  } catch {
    return true; // never block real visitors because the counter failed
  }
}

/** Cron: drop rate-limit rows from finished windows. */
export async function pruneRateLimits(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE window < ?").bind(Math.floor(now() / 60_000) - 2).run();
}

let cached: { value: GuardSettings; at: number } | null = null;

function merge(base: GuardSettings, over: Partial<GuardSettings>): GuardSettings {
  return {
    ...base,
    ...over,
    thresholds: { ...base.thresholds, ...(over.thresholds ?? {}) },
    features: { ...base.features, ...(over.features ?? {}) },
    caps: { ...base.caps, ...(over.caps ?? {}) },
  };
}

/** Settings are cached per isolate for 30s so guards cost ~nothing per request. */
export async function getGuards(env: Env, maxAgeMs = 30_000): Promise<GuardSettings> {
  if (cached && now() - cached.at < maxAgeMs) return cached.value;
  let stored: Partial<GuardSettings> = {};
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'guards'").first<{ value: string }>();
    stored = parseJson(row?.value, {});
  } catch {
    // D1 unavailable: fall back to defaults rather than failing the request.
  }
  const value = merge(DEFAULT_GUARDS, stored);
  cached = { value, at: now() };
  return value;
}

export async function saveGuards(env: Env, patch: Partial<GuardSettings>, userId: string | null): Promise<GuardSettings> {
  const current = await getGuards(env, 0);
  const next = merge(current, patch);
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('guards', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(JSON.stringify(next), now(), userId)
    .run();
  cached = { value: next, at: now() };
  return next;
}

export function currentLevel(g: GuardSettings): Level {
  switch (g.mode) {
    case "normal":
      return 0;
    case "conserve":
      return 1;
    case "essential":
      return 2;
    default:
      return g.autoLevel;
  }
}

export function featureOn(g: GuardSettings, feature: Feature): boolean {
  return g.features[feature] !== false && currentLevel(g) < OFF_AT[feature];
}

/** Increment a daily counter and return the new value. */
export async function bump(env: Env, metric: string, by = 1): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO usage_daily (day, metric, count) VALUES (?, ?, ?)
     ON CONFLICT(day, metric) DO UPDATE SET count = count + excluded.count
     RETURNING count`,
  )
    .bind(utcDay(), metric, by)
    .first<{ count: number }>();
  return row?.count ?? by;
}

/**
 * Check a live feature before doing any work. Returns a ready error Response
 * when the call should be refused, or null to proceed.
 */
export async function gate(env: Env, request: Request, feature: Feature): Promise<Response | null> {
  const g = await getGuards(env);
  if (!featureOn(g, feature)) {
    return json(
      {
        error: "This feature is paused for today to keep PlayTested free to run. It'll be back soon.",
        code: "feature_paused",
      },
      { status: 503, headers: { "Retry-After": "3600" } },
    );
  }

  // Rate limit and daily cap are checked in one D1 round trip.
  const limiterName = LIMITER[feature];
  const cap = g.caps[feature] ?? 0;
  const statements: D1PreparedStatement[] = [];
  if (limiterName) statements.push(rateStatement(env, `${limiterName}:${feature}:${clientIp(request)}`));
  if (cap > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO usage_daily (day, metric, count) VALUES (?, ?, 1)
         ON CONFLICT(day, metric) DO UPDATE SET count = count + 1
         RETURNING count`,
      ).bind(utcDay(), `feature:${feature}`),
    );
  }
  if (!statements.length) return null;

  let counts: number[];
  try {
    const results = await env.DB.batch<{ count: number }>(statements);
    counts = results.map((r) => r.results[0]?.count ?? 0);
  } catch {
    return null; // counters unavailable: don't punish visitors
  }
  if (limiterName && counts[0] > LIMITS[limiterName]) {
    return json(
      { error: "You're going a bit fast — give it a minute and try again.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  if (cap > 0 && counts[counts.length - 1] > cap) {
    return json(
      { error: "This feature hit its daily limit. It resets at 8 AM (Philippine time).", code: "daily_cap" },
      { status: 429, headers: { "Retry-After": "3600" } },
    );
  }
  return null;
}

// Paths only vulnerability scanners ask for. Answered before any routing,
// database or rendering work happens.
const JUNK_PATTERNS = [
  /\.(php\d?|aspx?|jsp|cgi|pl|env|ini|log|bak|old|orig|sql|sqlite3?|db|ya?ml|toml|conf|swp|ds_store)$/i,
  /^\/(wp-|wordpress|xmlrpc|cgi-bin|phpmyadmin|pma|vendor\/|\.git|\.svn|\.hg|\.env|\.aws|\.ssh|\.vscode|boaform|actuator|hnap1|owa\/|ecp\/|autodiscover|remote\/login|solr|druid|telescope|_ignition|server-status)/i,
];

export function isJunkPath(pathname: string): boolean {
  return JUNK_PATTERNS.some((re) => re.test(pathname));
}
