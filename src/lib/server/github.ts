/**
 * Minimal GitHub REST client for the studio.
 *
 * Publishing writes the article markdown (and any new images, uploaded as
 * blobs beforehand) to the content branch in ONE commit via the Git Data API.
 * That push is what triggers the deploy workflow.
 */
import type { Env } from "./env";

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function githubConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO);
}

async function gh<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.GITHUB_TOKEN) throw new GitHubError(503, "GitHub is not connected (GITHUB_TOKEN secret missing)");
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "playtested-studio",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).message ?? text;
    } catch {
      /* keep raw text */
    }
    throw new GitHubError(res.status, `GitHub ${res.status}: ${message}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Upload binary content (already base64) as a git blob; returns its sha. */
export async function createBlob(env: Env, base64: string): Promise<string> {
  const blob = await gh<{ sha: string }>(env, "/git/blobs", {
    method: "POST",
    body: JSON.stringify({ content: base64, encoding: "base64" }),
  });
  return blob.sha;
}

export type TreeEntry =
  | { path: string; content: string } // text file, written inline
  | { path: string; sha: string } // existing blob (e.g. an uploaded image)
  | { path: string; delete: true };

export interface CommitResult {
  sha: string;
  time: number;
  url: string;
}

/**
 * Commit a set of file changes on top of the branch head. Retries if someone
 * else pushed in between (non-fast-forward).
 */
export async function commitFiles(
  env: Env,
  message: string,
  entries: TreeEntry[],
  author?: { name: string; email: string },
): Promise<CommitResult> {
  const branch = env.GITHUB_BRANCH;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh<{ object: { sha: string } }>(env, `/git/ref/heads/${branch}`);
    const head = ref.object.sha;
    const headCommit = await gh<{ tree: { sha: string } }>(env, `/git/commits/${head}`);

    const tree = await gh<{ sha: string }>(env, "/git/trees", {
      method: "POST",
      body: JSON.stringify({
        base_tree: headCommit.tree.sha,
        tree: entries.map((e) =>
          "content" in e
            ? { path: e.path, mode: "100644", type: "blob", content: e.content }
            : "sha" in e
              ? { path: e.path, mode: "100644", type: "blob", sha: e.sha }
              : { path: e.path, mode: "100644", type: "blob", sha: null },
        ),
      }),
    });

    const date = new Date().toISOString();
    const commit = await gh<{ sha: string; html_url: string }>(env, "/git/commits", {
      method: "POST",
      body: JSON.stringify({
        message,
        tree: tree.sha,
        parents: [head],
        ...(author ? { author: { ...author, date } } : {}),
      }),
    });

    try {
      await gh(env, `/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      return { sha: commit.sha, time: Date.parse(date), url: commit.html_url };
    } catch (e) {
      // 422 = branch moved under us; rebuild the tree on the new head.
      if (e instanceof GitHubError && e.status === 422 && attempt < 2) continue;
      throw e;
    }
  }
  throw new GitHubError(409, "Could not commit: the branch kept changing. Try again.");
}

/** Ask GitHub Actions to run the deploy workflow (used for scheduled posts). */
export async function dispatchDeploy(env: Env, reason: string): Promise<void> {
  await gh(env, `/actions/workflows/${env.GITHUB_DEPLOY_WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: env.GITHUB_BRANCH, inputs: { reason } }),
  });
}

export interface WorkflowRun {
  id: number;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | …
  head_sha: string;
  event: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  display_title: string;
}

export async function listDeployRuns(env: Env, perPage = 8): Promise<WorkflowRun[]> {
  const data = await gh<{ workflow_runs: WorkflowRun[] }>(
    env,
    `/actions/workflows/${env.GITHUB_DEPLOY_WORKFLOW}/runs?branch=${encodeURIComponent(env.GITHUB_BRANCH)}&per_page=${perPage}`,
  );
  return data.workflow_runs ?? [];
}
