/**
 * What's deployed right now, and scheduled-post rebuilds.
 *
 * Every build writes /build-info.json (see src/pages/build-info.json.ts), so
 * the Worker can read the live deployment's build time from its own assets.
 */
import type { Env } from "./env";
import { bump } from "./guards";
import { dispatchDeploy, githubConfigured, listDeployRuns } from "./github";
import { audit, now, utcDay } from "./util";
import { alert } from "./alerts";

export interface BuildInfo {
  builtAt: number;
  commit: string | null;
  commitTime: number | null;
  env: string;
}

let cached: { value: BuildInfo | null; at: number } | null = null;

export async function getBuildInfo(env: Env, maxAgeMs = 60_000): Promise<BuildInfo | null> {
  if (cached && now() - cached.at < maxAgeMs) return cached.value;
  let value: BuildInfo | null = null;
  try {
    const res = await env.ASSETS.fetch(new Request("https://assets.local/build-info.json"));
    if (res.ok) value = (await res.json()) as BuildInfo;
  } catch {
    value = null;
  }
  cached = { value, at: now() };
  return value;
}

/**
 * Does the deployed build include a studio publish? Commits on the branch are
 * linear, so compare commit times (seconds) — robust even when an older run
 * finishes after a newer publish. Content that came from git is always built.
 */
export async function isBuilt(env: Env, row: { publish_commit_time: number | null; published_at: number | null }): Promise<boolean> {
  if (!row.publish_commit_time && !row.published_at) return true;
  const info = await getBuildInfo(env);
  if (!info) return false;
  if (info.commitTime && row.publish_commit_time) {
    return info.commitTime >= Math.floor(row.publish_commit_time / 1000) * 1000;
  }
  return info.builtAt >= (row.published_at ?? 0);
}

export async function recordDeploy(
  env: Env,
  reason: string,
  status: string,
  opts: { commit?: string | null; userId?: string | null; message?: string | null } = {},
): Promise<void> {
  const t = now();
  await env.DB.prepare(
    "INSERT INTO deploys (reason, status, commit_sha, requested_by, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(reason, status, opts.commit ?? null, opts.userId ?? null, opts.message ?? null, t, t)
    .run();
}

const MAX_SCHEDULE_DISPATCHES_PER_DAY = 12;

/**
 * Cron: a scheduled post whose pubDate passed after the live build was made
 * isn't on the site yet — trigger one rebuild for all of them.
 */
export async function runScheduler(env: Env): Promise<void> {
  if (!githubConfigured(env)) return;
  const info = await getBuildInfo(env, 0);
  if (!info) return;
  const t = now();
  const due = await env.DB.prepare(
    "SELECT live_slug AS slug FROM articles WHERE live_json IS NOT NULL AND pub_date > ? AND pub_date <= ? ORDER BY pub_date LIMIT 10",
  )
    .bind(info.builtAt, t)
    .all<{ slug: string }>();
  if (!due.results.length) return;

  // A deploy asked for in the last 20 minutes is probably still running.
  const recent = await env.DB.prepare("SELECT id FROM deploys WHERE created_at > ? LIMIT 1").bind(t - 20 * 60_000).first();
  if (recent) return;

  const sent = await bump(env, "deploy:schedule");
  if (sent > MAX_SCHEDULE_DISPATCHES_PER_DAY) return; // a failing build shouldn't retry forever

  const slugs = due.results.map((r) => r.slug);
  await dispatchDeploy(env, "schedule");
  await recordDeploy(env, "schedule", "requested", { message: slugs.join(", ") });
  await audit(env.DB, null, "deploy.schedule", null, { slugs, day: utcDay() });
  await alert(env, "published", {
    title: `⏰ Scheduled post${slugs.length > 1 ? "s" : ""} going live`,
    description: "Their publish time has passed, so the site is rebuilding (about 2 minutes).",
    url: `/article/${slugs[0]}/`,
    color: "green",
    fields: [{ name: "Articles", value: slugs.map((s) => `/article/${s}/`).join("\n"), inline: false }],
  });
}

/**
 * Cron: tell the team channel when a site build fails (one message per failed
 * run). One GitHub API call every 10 minutes, and only when alerts are set up.
 */
export async function watchBuilds(env: Env): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL || !githubConfigured(env)) return;
  const runs = await listDeployRuns(env, 3);
  for (const r of runs) {
    if (r.status !== "completed" || r.conclusion !== "failure") continue;
    if (Date.now() - Date.parse(r.updated_at) > 6 * 3600_000) continue;
    await alert(
      env,
      "deployFailed",
      {
        title: "🔴 Site build failed",
        description: `${r.display_title}\nThe live site still shows the previous build. Open the run to see what broke.`,
        url: r.html_url,
        color: "red",
        fields: [{ name: "Commit", value: r.head_sha.slice(0, 7) }, { name: "Trigger", value: r.event }],
      },
      `deploy:${r.id}`,
    );
  }
}
