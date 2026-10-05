/**
 * Usage watchdog (runs from the cron trigger every 10 minutes).
 *
 * Reads today's account-wide Worker + Pages Functions request count from the
 * Cloudflare analytics API — the free 100k/day quota is shared by every
 * Worker on the account — and steps the guard level down as it approaches
 * the limit. It steps back up automatically after the 00:00 UTC reset.
 */
import type { Env } from "./env";
import { getGuards, saveGuards, type Level, type UsageSnapshot } from "./guards";
import { audit, now, utcDay } from "./util";

const QUERY = `query ($accountTag: string!, $start: Time!, $end: Time!) {
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
    }
  }
}`;

interface Row {
  sum: { requests: number };
  dimensions: { scriptName: string };
}

export async function fetchUsage(env: Env): Promise<UsageSnapshot> {
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
      },
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: { viewer?: { accounts?: { workers?: Row[]; pages?: Row[] }[] } };
    errors?: { message: string }[] | null;
  } | null;
  if (!res.ok || !body || body.errors?.length) {
    const message = body?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    return { day, total: 0, byScript: {}, checkedAt: now(), error: message };
  }
  const account = body.data?.viewer?.accounts?.[0];
  const byScript: Record<string, number> = {};
  for (const row of [...(account?.workers ?? []), ...(account?.pages ?? [])]) {
    const name = row.dimensions.scriptName || "unknown";
    byScript[name] = (byScript[name] ?? 0) + (row.sum.requests ?? 0);
  }
  const total = Object.values(byScript).reduce((a, b) => a + b, 0);
  return { day, total, byScript, checkedAt: now() };
}

export async function runWatchdog(env: Env): Promise<void> {
  const g = await getGuards(env, 0);
  const usage = await fetchUsage(env);
  if (usage.error) {
    // Keep the last good level; just record why the check failed.
    await saveGuards(env, { usage: { ...(g.usage ?? usage), error: usage.error, checkedAt: usage.checkedAt } }, null);
    return;
  }

  const pct = (usage.total / g.dailyLimit) * 100;
  const autoLevel: Level = pct >= g.thresholds.essential ? 2 : pct >= g.thresholds.conserve ? 1 : 0;
  const alertedToday = g.alerted?.day === usage.day ? g.alerted.level : 0;
  const patch: Parameters<typeof saveGuards>[1] = { autoLevel, usage };

  if (autoLevel > alertedToday) {
    patch.alerted = { day: usage.day, level: autoLevel };
    const label = autoLevel === 2 ? "essential-only" : "conserve";
    const message =
      `PlayTested (${env.SITE_ENV}): Cloudflare usage is at ${pct.toFixed(0)}% of the free daily limit ` +
      `(${usage.total.toLocaleString()} / ${g.dailyLimit.toLocaleString()}). ` +
      `Switched to ${label} mode${g.mode === "auto" ? "" : " (auto mode is overridden in the studio, so nothing changed)"}. ` +
      `Resets at 00:00 UTC (8 AM PH).`;
    await audit(env.DB, null, "watchdog.level", String(autoLevel), { pct, total: usage.total });
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
