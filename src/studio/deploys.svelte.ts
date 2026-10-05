/** Deploy status shared by the sidebar pill, editor and settings. */
import { api } from "./api";

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

export async function refreshDeploys() {
  try {
    const d = await api.get<{ build: BuildInfo | null; runs: Run[]; github: boolean; runsError: string | null }>("/deploys");
    deploys.build = d.build;
    deploys.runs = d.runs;
    deploys.github = d.github;
    deploys.runsError = d.runsError;
    deploys.loaded = true;
    if (deploys.watching && d.build?.commit === deploys.watching) deploys.watching = null;
  } catch {
    /* transient; next tick retries */
  }
  schedule();
}

function schedule() {
  if (timer) clearTimeout(timer);
  const building = deploys.runs.some((r) => r.status !== "completed");
  timer = setTimeout(refreshDeploys, deploys.watching || building ? 8000 : 45000);
}

/** After publishing: poll quickly until the new commit is the live build. */
export function watchCommit(sha: string) {
  deploys.watching = sha;
  setTimeout(refreshDeploys, 4000);
}

export function latestRun(): Run | null {
  return deploys.runs[0] ?? null;
}
