/** Deploy status shared by the sidebar pill, editor and settings. */
import { api, ApiError } from "./api";

export interface BuildInfo {
  builtAt: number;
  commit: string | null;
  commitTime: number | null;
  env: string;
}

export interface Run {
  id: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  event: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  display_title: string;
}

export const deploys = $state<{
  loaded: boolean;
  build: BuildInfo | null;
  runs: Run[];
  github: boolean;
  runsError: string | null;
  watching: string | null; // commit sha we're waiting to see deployed
}>({ loaded: false, build: null, runs: [], github: false, runsError: null, watching: null });

let timer: ReturnType<typeof setTimeout> | null = null;
// Bumped by stopDeploys() so a request already in flight doesn't re-arm the poll.
let generation = 0;
// What we know about the commit being watched (see watchCommit).
let watch: { sha: string; time: number | null; startedAt: number } | null = null;
// Give up waiting after this long; the pill falls back to the run/build status.
const WATCH_TIMEOUT_MS = 15 * 60_000;

/** Has the watched commit reached the live site (or will it never)? */
function watchSettled(build: BuildInfo | null, runs: Run[]): boolean {
  if (!watch) return true;
  if (Date.now() - watch.startedAt > WATCH_TIMEOUT_MS) return true;
  if (build?.commit === watch.sha) return true;
  // Commits on the branch are linear: a live build from a commit at least as
  // new as ours includes it (the same rule the server's isBuilt() uses).
  if (build?.commitTime && watch.time && build.commitTime >= Math.floor(watch.time / 1000) * 1000) return true;
  // Without the commit time, a build that *started* after the publish includes it.
  if (!watch.time && build && build.builtAt > watch.startedAt) return true;
  // Its own run failed or was cancelled: it's not coming; show the run's status instead.
  const own = runs.find((r) => r.head_sha === watch!.sha);
  if (own && own.status === "completed" && own.conclusion !== "success") return true;
  return false;
}

export async function refreshDeploys() {
  const gen = generation;
  try {
    const d = await api.get<{ build: BuildInfo | null; runs: Run[]; github: boolean; runsError: string | null }>("/deploys");
    if (gen !== generation) return;
    deploys.build = d.build;
    deploys.runs = d.runs;
    deploys.github = d.github;
    deploys.runsError = d.runsError;
    deploys.loaded = true;
    if (deploys.watching && watchSettled(d.build, d.runs)) {
      deploys.watching = null;
      watch = null;
    }
  } catch (e) {
    // Signed out: stop polling until the shell mounts again.
    if (e instanceof ApiError && e.status === 401) return;
    /* otherwise transient; next tick retries */
  }
  if (gen !== generation) return;
  schedule();
}

function schedule() {
  if (timer) clearTimeout(timer);
  const building = deploys.runs.some((r) => r.status !== "completed");
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  timer = setTimeout(refreshDeploys, deploys.watching || building ? 8000 : hidden ? 180_000 : 45000);
}

/**
 * After publishing: poll quickly until the new commit is the live build.
 * `time` is the commit's time in ms (ArticleDetail.commit.time) when known.
 */
export function watchCommit(sha: string, time?: number) {
  watch = { sha, time: time ?? null, startedAt: Date.now() };
  deploys.watching = sha;
  setTimeout(refreshDeploys, 4000);
}

/** Stop polling (sign-out / shell unmount). refreshDeploys() starts it again. */
export function stopDeploys() {
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  watch = null;
  deploys.watching = null;
}

export function latestRun(): Run | null {
  return deploys.runs[0] ?? null;
}
