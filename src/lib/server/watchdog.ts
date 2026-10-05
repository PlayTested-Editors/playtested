/**
 * Usage watchdog (runs from the cron trigger every 10 minutes).
 *
 * Reads today's account-wide usage from the Cloudflare analytics API for every
 * free-plan daily limit the site touches — Worker requests, D1 rows read and
 * written, Workers AI neurons and KV operations. These quotas are shared by
 * every project on the account. The guard level steps down when ANY of them
 * nears its limit, and back up after the 00:00 UTC reset.
 */
import type { Env } from "./env";
import { getGuards, saveGuards, type Level, type UsageMetric, type UsageSnapshot } from "./guards";
import { audit, now, utcDay } from "./util";

/** Workers Free plan daily allowances. Going over means errors, never bills. */
const FREE_LIMITS = {
  d1Read: { label: "D1 rows read", limit: 5_000_000 },
  d1Write: { label: "D1 rows written", limit: 100_000 },
  aiNeurons: { label: "Workers AI neurons", limit: 10_000 },
  kvRead: { label: "KV reads", limit: 100_000 },
  kvWrite: { label: "KV writes", limit: 1_000 },
} as const;

const QUERY = `query ($accountTag: string!, $start: Time!, $end: Time!, $date: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workers: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { requests }
        dimensions { scriptName }
      }
      pages: pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { requests }
        dimensions { scriptName }
      }
      d1: d1AnalyticsAdaptiveGroups(limit: 100, filter: { date_geq: $date }) {
        sum { rowsRead rowsWritten }
      }
      kv: kvOperationsAdaptiveGroups(limit: 100, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { requests }
        dimensions { actionType }
      }
      ai: aiInferenceAdaptiveGroups(limit: 100, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { totalNeurons }
      }
    }
  }
}`;

interface Account {
  workers?: { sum: { requests: number }; dimensions: { scriptName: string } }[];
  pages?: { sum: { requests: number }; dimensions: { scriptName: string } }[];
  d1?: { sum: { rowsRead: number; rowsWritten: number } }[];
  kv?: { sum: { requests: number }; dimensions: { actionType: string } }[];
  ai?: { sum: { totalNeurons: number } }[];
}

export async function fetchUsage(env: Env, dailyRequestLimit: number): Promise<UsageSnapshot> {
  const day = utcDay();
  if (!env.CF_ANALYTICS_TOKEN) {
    return { day, total: 0, byScript: {}, checkedAt: now(), error: "CF_ANALYTICS_TOKEN is not set" };
  }
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        accountTag: env.CF_ACCOUNT_ID,
        start: `${day}T00:00:00Z`,
        end: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        date: day,
      },
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: { viewer?: { accounts?: Account[] } };
    errors?: { message: string }[] | null;
  } | null;
  if (!res.ok || !body || body.errors?.length) {
    const message = body?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    return { day, total: 0, byScript: {}, checkedAt: now(), error: message };
  }
  const a = body.data?.viewer?.accounts?.[0] ?? {};
  const byScript: Record<string, number> = {};
  for (const row of [...(a.workers ?? []), ...(a.pages ?? [])]) {
    const name = row.dimensions.scriptName || "unknown";
    byScript[name] = (byScript[name] ?? 0) + (row.sum.requests ?? 0);
  }
  const total = Object.values(byScript).reduce((x, y) => x + y, 0);
  const sum = <T>(rows: T[] | undefined, f: (r: T) => number) => (rows ?? []).reduce((acc, r) => acc + (f(r) || 0), 0);
  const kvBy = (type: string) => sum(a.kv?.filter((r) => r.dimensions.actionType === type), (r) => r.sum.requests);

  const used: Record<keyof typeof FREE_LIMITS, number> = {
    d1Read: sum(a.d1, (r) => r.sum.rowsRead),
    d1Write: sum(a.d1, (r) => r.sum.rowsWritten),
    aiNeurons: Math.round(sum(a.ai, (r) => r.sum.totalNeurons)),
    kvRead: kvBy("read"),
    kvWrite: kvBy("write") + kvBy("delete") + kvBy("list"),
  };
  const metrics: Record<string, UsageMetric> = {
    requests: { label: "Worker requests", used: total, limit: dailyRequestLimit },
  };
  for (const [key, { label, limit }] of Object.entries(FREE_LIMITS)) {
    metrics[key] = { label, used: used[key as keyof typeof FREE_LIMITS], limit };
  }
  return { day, total, byScript, metrics, checkedAt: now() };
}

export async function runWatchdog(env: Env): Promise<void> {
  const g = await getGuards(env, 0);
  const usage = await fetchUsage(env, g.dailyLimit);
  if (usage.error) {
    // Keep the last good level; just record why the check failed.
    await saveGuards(env, { usage: { ...(g.usage ?? usage), error: usage.error, checkedAt: usage.checkedAt } }, null);
    return;
  }

  // The tightest quota decides the level.
  let worst = { key: "requests", pct: 0 };
  for (const [key, m] of Object.entries(usage.metrics ?? {})) {
    const pct = m.limit ? (m.used / m.limit) * 100 : 0;
    if (pct > worst.pct) worst = { key, pct };
  }
  const autoLevel: Level = worst.pct >= g.thresholds.essential ? 2 : worst.pct >= g.thresholds.conserve ? 1 : 0;
  const alertedToday = g.alerted?.day === usage.day ? g.alerted.level : 0;
  const patch: Parameters<typeof saveGuards>[1] = { autoLevel, usage: { ...usage, worst } };

  if (autoLevel > alertedToday) {
    patch.alerted = { day: usage.day, level: autoLevel };
    const m = usage.metrics![worst.key];
    const label = autoLevel === 2 ? "essential-only" : "conserve";
    const message =
      `PlayTested (${env.SITE_ENV}): ${m.label} at ${worst.pct.toFixed(0)}% of the free daily limit ` +
      `(${m.used.toLocaleString()} / ${m.limit.toLocaleString()}). ` +
      `Switched to ${label} mode${g.mode === "auto" ? "" : " (auto mode is overridden in the studio, so nothing changed)"}. ` +
      `Resets at 00:00 UTC (8 AM PH).`;
    await audit(env.DB, null, "watchdog.level", String(autoLevel), { metric: worst.key, pct: worst.pct, used: m.used });
    if (env.ALERT_WEBHOOK_URL) {
      // Works with Discord ("content") and Slack ("text") incoming webhooks.
      await fetch(env.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message, text: message }),
      }).catch(() => undefined);
    }
  }
  await saveGuards(env, patch, null);
}
