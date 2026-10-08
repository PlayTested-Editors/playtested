/**
 * Articles: data shape, markdown serialisation, review workflow and
 * permissions. Git holds the published markdown the static build reads; D1
 * holds working copies, revisions and the review state.
 */
import YAML from "yaml";
import { sanitizeHtml } from "../sanitize";
import type { Env } from "./env";
import { audit, now, parseJson, sha256Hex, uid } from "./util";
import type { SessionUser } from "./auth";

export interface ArticleData {
  title: string;
  description: string;
  /** ISO 8601 with offset, e.g. 2026-07-24T18:14:00.000+08:00 */
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

export type ArticleState = "draft" | "in_review" | "changes_requested" | "approved" | "published";

export interface ArticleRow {
  id: string;
  /** The working copy's slug (what the editor shows). */
  slug: string;
  /** The slug the site serves; NULL while unpublished. Public lookups use this. */
  live_slug: string | null;
  collection: string;
  git_path: string | null;
  draft_json: string;
  draft_rev: number;
  state: ArticleState;
  live_json: string | null;
  live_hash: string | null;
  pub_date: number | null;
  published_at: number | null;
  publish_commit: string | null;
  publish_commit_time: number | null;
  title: string;
  category: string | null;
  author: string | null;
  score: number | null;
  featured: number;
  thumb: string | null;
  created_by: string | null;
  updated_by: string | null;
  assigned_to: string | null;
  created_at: number;
  updated_at: number;
  locked_by: string | null;
  locked_at: number | null;
}

/** The site publishes in Philippine time; keep new files consistent with old ones. */
const SITE_OFFSET = "+08:00";
const SITE_OFFSET_MS = 8 * 60 * 60 * 1000;

export function toSiteIso(ms: number): string {
  return new Date(ms + SITE_OFFSET_MS).toISOString().replace("Z", SITE_OFFSET);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

/**
 * Coerce a draft into shape. Strings are kept as typed (no trimming) so an
 * autosave never eats the space someone just typed; finalise() trims at publish.
 */
export function normaliseData(input: Partial<ArticleData>): ArticleData {
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const gallery = Array.isArray(input.gallery) ? input.gallery.map((g) => String(g).trim()).filter(Boolean) : [];
  const score = input.score === null || input.score === undefined || (input.score as unknown) === "" ? null : Number(input.score);
  return {
    title: String(input.title ?? ""),
    description: String(input.description ?? ""),
    pubDate: String(input.pubDate ?? toSiteIso(now())),
    category: String(input.category ?? ""),
    tags: [...new Set(tags)],
    featured: Boolean(input.featured),
    author: String(input.author ?? ""),
    slug: slugify(String(input.slug || input.title || "")),
    thumb: input.thumb ? String(input.thumb).trim() : undefined,
    large: input.large ? String(input.large).trim() : undefined,
    gallery,
    score: score === null || Number.isNaN(score) ? null : score,
    game: input.game ? String(input.game) : undefined,
    body: String(input.body ?? "").replace(/\r\n/g, "\n"),
  };
}

/** Tidy a draft for publishing: trim text fields, round the score. */
export function finalise(d: ArticleData): ArticleData {
  return {
    ...d,
    title: d.title.trim(),
    description: d.description.trim(),
    category: d.category.trim(),
    author: d.author.trim(),
    game: d.game?.trim() || undefined,
    score: d.score === null || d.score === undefined ? null : Math.round(d.score * 10) / 10,
    body: sanitizeHtml(d.body).html.replace(/\s+$/, ""),
  };
}

/** Problems that would break the static build or the article page. */
export function validateForPublish(d: ArticleData): string[] {
  const errors: string[] = [];
  if (!d.title) errors.push("Title is required.");
  if (!d.slug) errors.push("Slug is required.");
  if (!d.description) errors.push("Description is required.");
  if (!d.category) errors.push("Category is required.");
  if (Number.isNaN(Date.parse(d.pubDate))) errors.push("Publish date is invalid.");
  if (!d.body.trim()) errors.push("The article body is empty.");
  if (d.score !== null && d.score !== undefined && (d.score < 0 || d.score > 10)) errors.push("Score must be between 0 and 10.");
  return errors;
}

/** Serialise to the frontmatter + markdown format the content collection reads. */
export function toMarkdown(d: ArticleData): string {
  const fm: Record<string, unknown> = {
    title: d.title,
    pubDate: d.pubDate,
    draft: false,
    description: d.description,
    category: d.category,
    tags: d.tags,
    featured: d.featured,
  };
  if (d.thumb) fm.thumb = d.thumb;
  fm.author = d.author;
  fm.slug = d.slug;
  if (d.gallery?.length) fm.gallery = d.gallery;
  if (d.large) fm.large = d.large;
  if (d.score !== null && d.score !== undefined) fm.score = d.score;
  if (d.game) fm.game = d.game;
  const yaml = YAML.stringify(fm, { lineWidth: 0 });
  return `---\n${yaml}---\n\n${d.body.trim()}\n`;
}

/** Same normalisation as scripts/sync-d1.mjs so studio commits don't look "changed". */
export function fileHash(markdown: string): Promise<string> {
  return sha256Hex(markdown.replace(/\r\n/g, "\n"));
}

/** Every /images/uploads/... path the article references. */
export function referencedImages(d: ArticleData): string[] {
  const found = new Set<string>();
  const add = (p?: string) => {
    if (p && p.startsWith("/images/uploads/")) found.add(p.split(/[?#]/)[0]);
  };
  add(d.thumb);
  add(d.large);
  d.gallery?.forEach(add);
  for (const m of d.body.matchAll(/\/images\/uploads\/[^\s"'()<>]+/g)) add(m[0]);
  return [...found];
}

// ---------------------------------------------------------------------------
// Permissions

export type Action =
  | "edit"
  | "submit"
  | "request_changes"
  | "approve"
  | "publish"
  | "unpublish"
  | "delete"
  | "restore";

/**
 * Chief editor has the final say: only they publish, unpublish, approve or
 * request changes. Editors edit anything and submit; contributors work on
 * their own pieces.
 */
/** Yours if you created it in the studio, or it carries your byline (bylines are set by the chief editor). */
export function isOwnArticle(user: SessionUser, a: Pick<ArticleRow, "created_by" | "author">): boolean {
  if (a.created_by === user.id) return true;
  const byline = user.authorName?.trim().toLowerCase();
  return Boolean(byline && a.author?.trim().toLowerCase() === byline);
}

export function can(user: SessionUser, action: Action, a?: Pick<ArticleRow, "created_by" | "author" | "live_json" | "state">): boolean {
  if (user.role === "chief") return true;
  const own = !a || isOwnArticle(user, a);
  switch (action) {
    case "edit":
    case "restore":
      return user.role === "editor" || own;
    case "submit":
      return user.role === "editor" || own;
    case "delete":
      // Only never-published drafts, and only your own (editors: any draft).
      return Boolean(a && !a.live_json && (user.role === "editor" || own));
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Persistence

export function rowSummary(row: ArticleRow) {
  return {
    id: row.id,
    slug: row.slug,
    /** Where the site serves it now (differs from `slug` while a rename is unpublished). */
    liveSlug: row.live_slug ?? null,
    collection: row.collection,
    state: row.state,
    title: row.title,
    category: row.category,
    author: row.author,
    score: row.score,
    featured: Boolean(row.featured),
    thumb: row.thumb,
    isLive: Boolean(row.live_json),
    hasPendingChanges: Boolean(row.live_json) && row.state !== "published",
    pubDate: row.pub_date,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    createdBy: row.created_by,
    assignedTo: row.assigned_to,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
  };
}

export async function getArticle(env: Env, idOrSlug: string): Promise<ArticleRow | null> {
  return env.DB.prepare("SELECT * FROM articles WHERE id = ? OR slug = ? LIMIT 1").bind(idOrSlug, idOrSlug).first<ArticleRow>();
}

export function draftOf(row: ArticleRow): ArticleData {
  return normaliseData(parseJson<Partial<ArticleData>>(row.draft_json, {}));
}

export function liveOf(row: ArticleRow): ArticleData | null {
  return row.live_json ? normaliseData(parseJson<Partial<ArticleData>>(row.live_json, {})) : null;
}

async function addRevision(
  env: Env,
  articleId: string,
  rev: number,
  data: ArticleData,
  kind: string,
  userId: string | null,
  note?: string | null,
) {
  await env.DB.prepare(
    "INSERT INTO revisions (article_id, rev, data_json, kind, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(articleId, rev, JSON.stringify(data), kind, note ?? null, userId, now())
    .run();
}

/**
 * Is this slug used by another article — as its working slug OR as the slug a
 * live article is still served at (a renamed draft keeps its old URL live)?
 * Two index lookups (slug, live_slug).
 */
export async function slugTaken(env: Env, slug: string, exceptId?: string): Promise<boolean> {
  const except = exceptId ?? "";
  const row = await env.DB.prepare(
    `SELECT id FROM articles WHERE slug = ? AND id != ?
     UNION ALL SELECT id FROM articles WHERE live_slug = ? AND id != ? LIMIT 1`,
  )
    .bind(slug, except, slug, except)
    .first();
  return Boolean(row);
}

/** Thrown when a save would give an article another article's slug (→ 409 slug_taken). */
export class SlugTakenError extends Error {
  constructor(public slug: string) {
    super(`The slug "${slug}" is already used by another article. Choose a different one.`);
  }
}

/**
 * The markdown file a first publish writes. The frontmatter `slug:` decides the
 * URL, so the file name only has to be unique among LIVE articles (their files
 * exist in git); a suffix is added when another article already owns it.
 */
export async function freeGitPath(env: Env, slug: string, exceptId: string): Promise<string> {
  for (let i = 1; i < 50; i++) {
    const path = `src/content/article/${slug}${i === 1 ? "" : `-${i}`}.md`;
    const owner = await env.DB.prepare("SELECT id FROM articles WHERE git_path = ? AND live_json IS NOT NULL AND id != ? LIMIT 1")
      .bind(path, exceptId)
      .first();
    if (!owner) return path;
  }
  throw new SlugTakenError(slug);
}

export async function createArticle(env: Env, user: SessionUser, input: Partial<ArticleData>): Promise<ArticleRow> {
  const data = normaliseData({ author: user.authorName || user.name, ...input });
  if (!data.slug) data.slug = `untitled-${uid(4).toLowerCase()}`;
  let slug = data.slug;
  for (let i = 2; await slugTaken(env, slug); i++) slug = `${data.slug}-${i}`;
  data.slug = slug;

  const id = crypto.randomUUID();
  const t = now();
  // git_path stays NULL until the first publish picks a free file name from
  // the final slug (the slug usually changes while drafting).
  await env.DB.prepare(
    `INSERT INTO articles (id, slug, collection, git_path, draft_json, draft_rev, state, title, category, author, score, featured, thumb,
       created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, 'article', NULL, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      slug,
      JSON.stringify(data),
      data.title,
      data.category || null,
      data.author || null,
      data.score ?? null,
      data.featured ? 1 : 0,
      data.thumb ?? null,
      user.id,
      user.id,
      t,
      t,
    )
    .run();
  await addRevision(env, id, 1, data, "save", user.id, "Created");
  await audit(env.DB, user.id, "article.create", id, { slug });
  return (await getArticle(env, id))!;
}

export class ConflictError extends Error {
  constructor(public current: ArticleRow) {
    super("Someone else saved this article since you opened it.");
  }
}

/**
 * Save the working copy. `baseRev` must match the stored draft_rev (optimistic
 * lock). `revisionKind` records a history entry; autosaves pass null.
 */
export async function saveDraft(
  env: Env,
  user: SessionUser,
  row: ArticleRow,
  input: Partial<ArticleData>,
  baseRev: number,
  revisionKind: string | null,
  nextState?: ArticleState,
  note?: string | null,
): Promise<ArticleRow> {
  if (row.draft_rev !== baseRev) throw new ConflictError(row);
  const data = normaliseData(input);
  // The byline decides ownership (isOwnArticle), so only the chief editor changes it.
  data.author = user.role === "chief" ? data.author.trim() : (row.author ?? data.author);
  if (!data.slug) data.slug = row.slug;
  if (data.slug !== row.slug && (await slugTaken(env, data.slug, row.id))) throw new SlugTakenError(data.slug);

  let state: ArticleState = nextState ?? row.state;
  if (!nextState && row.live_json) {
    // Edited a live article -> draft; saved it back to exactly the live version
    // (e.g. "Discard my changes") -> published again, with nothing pending.
    const live = liveOf(row);
    const unchanged = live && JSON.stringify(live) === JSON.stringify(data);
    if (unchanged) state = "published";
    else if (row.state === "published") state = "draft";
  }
  if (!nextState && row.state === "approved" && state !== "published") state = "draft"; // edits after approval need a fresh look

  const rev = row.draft_rev + 1;
  const res = await env.DB.prepare(
    `UPDATE articles SET draft_json = ?, draft_rev = ?, state = ?, slug = ?, title = ?, category = ?, author = ?, score = ?,
       featured = ?, thumb = ?, updated_by = ?, updated_at = ?, locked_by = ?, locked_at = ?
     WHERE id = ? AND draft_rev = ?`,
  )
    .bind(
      JSON.stringify(data),
      rev,
      state,
      data.slug,
      data.title,
      data.category || null,
      data.author || null,
      data.score ?? null,
      data.featured ? 1 : 0,
      data.thumb ?? null,
      user.id,
      now(),
      user.id,
      now(),
      row.id,
      baseRev,
    )
    .run();
  if (!res.meta.changes) throw new ConflictError((await getArticle(env, row.id))!);
  if (revisionKind) await addRevision(env, row.id, rev, data, revisionKind, user.id, note);
  return (await getArticle(env, row.id))!;
}

export async function setState(
  env: Env,
  user: SessionUser,
  row: ArticleRow,
  state: ArticleState,
  kind: string,
  note?: string | null,
): Promise<ArticleRow> {
  await env.DB.prepare("UPDATE articles SET state = ?, updated_by = ?, updated_at = ? WHERE id = ?")
    .bind(state, user.id, now(), row.id)
    .run();
  await addRevision(env, row.id, row.draft_rev, draftOf(row), kind, user.id, note);
  if (note) {
    await env.DB.prepare("INSERT INTO notes (article_id, user_id, body, created_at) VALUES (?, ?, ?, ?)")
      .bind(row.id, user.id, note, now())
      .run();
  }
  await audit(env.DB, user.id, `article.${kind}`, row.id, note ? { note } : undefined);
  return (await getArticle(env, row.id))!;
}

/**
 * Record a successful publish (after the git commit landed). If someone saved
 * the draft while the commit was being made, their newer working copy is kept
 * (only the live copy is updated) instead of being replaced by what was published.
 */
export async function markPublished(
  env: Env,
  user: SessionUser,
  row: ArticleRow,
  data: ArticleData,
  hash: string,
  commit: { sha: string; time: number },
  gitPath: string,
): Promise<ArticleRow> {
  const t = now();
  const json = JSON.stringify(data);
  const live = [json, hash, data.slug, gitPath, Date.parse(data.pubDate), t, commit.sha, commit.time] as const;
  const res = await env.DB.prepare(
    `UPDATE articles SET live_json = ?, live_hash = ?, live_slug = ?, git_path = ?, pub_date = ?, published_at = ?, publish_commit = ?,
       publish_commit_time = ?, state = 'published', draft_json = ?, slug = ?, updated_by = ?, updated_at = ?, locked_by = NULL, locked_at = NULL
     WHERE id = ? AND draft_rev = ?`,
  )
    .bind(...live, json, data.slug, user.id, t, row.id, row.draft_rev)
    .run();
  if (!res.meta.changes) {
    await env.DB.prepare(
      `UPDATE articles SET live_json = ?, live_hash = ?, live_slug = ?, git_path = ?, pub_date = ?, published_at = ?, publish_commit = ?,
         publish_commit_time = ?, state = CASE WHEN state = 'published' THEN 'draft' ELSE state END WHERE id = ?`,
    )
      .bind(...live, row.id)
      .run();
  }
  await addRevision(env, row.id, row.draft_rev, data, "publish", user.id, commit.sha.slice(0, 7));
  await audit(env.DB, user.id, "article.publish", row.id, { commit: commit.sha, slug: data.slug });
  return (await getArticle(env, row.id))!;
}

export async function markUnpublished(env: Env, user: SessionUser, row: ArticleRow, commitSha: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE articles SET live_json = NULL, live_hash = NULL, live_slug = NULL, published_at = NULL, publish_commit = ?, state = 'draft',
       updated_by = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(commitSha, user.id, now(), row.id)
    .run();
  await addRevision(env, row.id, row.draft_rev, draftOf(row), "unpublish", user.id, commitSha.slice(0, 7));
  await audit(env.DB, user.id, "article.unpublish", row.id, { commit: commitSha });
}
