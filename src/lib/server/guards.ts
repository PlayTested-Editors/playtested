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
export type Feature = "chat" | "summary" | "search" | "recommend" | "compare" | "askReview" | "liveFallback";

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
    liveFallback: true,
  },
  caps: {
    chat: 600,
    summary: 150,
    search: 3000,
    recommend: 200,
    compare: 200,
    askReview: 400,
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
};

const LIMITER: Record<Feature, "RL_AI" | "RL_SEARCH" | null> = {
  chat: "RL_AI",
  summary: "RL_AI",
  recommend: "RL_AI",
  compare: "RL_AI",
  askReview: "RL_AI",
  search: "RL_SEARCH",
  liveFallback: null,
};

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

  const limiterName = LIMITER[feature];
  const limiter = limiterName ? env[limiterName] : undefined;
  if (limiter) {
    const { success } = await limiter.limit({ key: `${feature}:${clientIp(request)}` });
    if (!success) {
      return json(
        { error: "You're going a bit fast — give it a minute and try again.", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }
  }

  const cap = g.caps[feature] ?? 0;
  if (cap > 0) {
    const count = await bump(env, `feature:${feature}`);
    if (count > cap) {
      return json(
        { error: "This feature hit its daily limit. It resets at 8 AM (Philippine time).", code: "daily_cap" },
        { status: 429, headers: { "Retry-After": "3600" } },
      );
    }
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
