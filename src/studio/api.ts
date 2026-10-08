/** Typed fetch wrapper for /api/studio. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, any> = {},
  ) {
    super(message);
  }
}

// Called when a signed-in call comes back 401 (session expired or revoked).
// The session probe (/me) and sign-in endpoints are expected to 401 and skip it.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/studio${path}`, {
    method,
    credentials: "same-origin",
    ...init,
    headers: {
      ...(body !== undefined && !(body instanceof Blob) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (res.status === 401 && path !== "/me" && !path.startsWith("/auth/")) onUnauthorized?.();
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
  upload: <T>(path: string, blob: Blob, headers: Record<string, string>) => request<T>("POST", path, blob, { headers }),
};

// ---------------------------------------------------------------------------
// Shared types (mirror src/lib/server/*)

export type Role = "chief" | "editor" | "contributor";
export type ArticleState = "draft" | "in_review" | "changes_requested" | "approved" | "published";

export interface User {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
  role: Role;
  authorName: string | null;
}

export interface ArticleData {
  title: string;
  description: string;
  pubDate: string;
  category: string;
  tags: string[];
  featured: boolean;
  author: string;
  slug: string;
  thumb?: string;
  large?: string;
  gallery?: string[];
  score?: number | null;
  game?: string;
  body: string;
}

export interface ArticleSummary {
  id: string;
  slug: string;
  collection: string;
  state: ArticleState;
  title: string;
  category: string | null;
  author: string | null;
  score: number | null;
  featured: boolean;
  thumb: string | null;
  isLive: boolean;
  hasPendingChanges: boolean;
  pubDate: number | null;
  publishedAt: number | null;
  updatedAt: number;
  updatedBy: string | null;
  createdBy: string | null;
  lockedBy: string | null;
  lockedAt: number | null;
}

export interface Media {
  id: string;
  url: string;
  filename: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  committed: boolean;
  articleId: string | null;
  createdAt: number;
}

export interface Note {
  id: number;
  body: string;
  createdAt: number;
  resolvedAt: number | null;
  userId: string;
  userName: string | null;
}

export interface ArticleDetail {
  article: ArticleSummary & { rev: number; gitPath: string | null; publishCommit: string | null };
  draft: ArticleData;
  live: ArticleData | null;
  built: boolean;
  notes: Note[];
  names: Record<string, string>;
  lockedBy: { id: string; name: string } | null;
  media: Media[];
  permissions: { edit: boolean; submit: boolean; review: boolean; publish: boolean; unpublish: boolean; delete: boolean };
  commit?: { sha: string; time: number; url: string };
}

export interface Revision {
  id: number;
  rev: number;
  kind: string;
  note: string | null;
  createdAt: number;
  userId: string | null;
  userName: string | null;
}
