/**
 * Studio API (/api/studio/*). JSON in, JSON out. Every state-changing call
 * must be same-origin (Origin check) — cookies are SameSite=Lax on top.
 */
import type { Env } from "../env";
import {
  acceptInvite,
  consumeLoginLink,
  createInvite,
  createLoginLink,
  endSession,
  findUserByEmail,
  getSessionUser,
  googleConfigured,
  googleFinish,
  googleStart,
  lookupInvite,
  ownerSignIn,
  startSession,
  userCount,
  type Role,
  type SessionUser,
} from "../auth";
import {
  ConflictError,
  can,
  createArticle,
  draftOf,
  fileHash,
  finalise,
  getArticle,
  liveOf,
  markPublished,
  markUnpublished,
  normaliseData,
  referencedImages,
  rowSummary,
  saveDraft,
  setState,
  slugTaken,
  toMarkdown,
  validateForPublish,
  type ArticleData,
  type ArticleRow,
} from "../articles";
import { commitFiles, dispatchDeploy, GitHubError, githubConfigured, listDeployRuns, type TreeEntry } from "../github";
import { DEFAULT_GUARDS, currentLevel, getGuards, saveGuards, withinRate, type GuardSettings } from "../guards";
import { ensureBlob, mediaForPaths, mediaJson, storeUpload, type MediaRow } from "../media";
import { getBuildInfo, isBuilt, recordDeploy } from "../deploys";
import { indexArticle, reindexPending, removeFromIndex } from "../search";
import { runWatchdog } from "../watchdog";
import { audit, clientIp, error, json, now, parseJson, utcDay } from "../util";

interface Ctx {
  env: Env;
  request: Request;
  url: URL;
  user: SessionUser | null;
  waitUntil: (p: Promise<unknown>) => void;
}

type Handler = (c: Ctx, m: RegExpExecArray) => Promise<Response>;
type MinRole = Role | "public";

const RANK: Record<Role, number> = { contributor: 1, editor: 2, chief: 3 };

const routes: { method: string; re: RegExp; min: MinRole; fn: Handler }[] = [];
const route = (method: string, path: string, min: MinRole, fn: Handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, "([^/]+)")}/?$`), min, fn });

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function withCookie(res: Response, cookie: string): Response {
  const out = new Response(res.body, res);
  out.headers.append("Set-Cookie", cookie);
  return out;
}

async function limitAuth(c: Ctx): Promise<Response | null> {
  const ok = await withinRate(c.env, "RL_AUTH", `auth:${clientIp(c.request)}`);
  return ok ? null : error(429, "Too many sign-in attempts. Wait a minute and try again.");
}

function integrations(env: Env) {
  return {
    github: githubConfigured(env),
    analytics: Boolean(env.CF_ANALYTICS_TOKEN),
    google: googleConfigured(env),
    openrouter: Boolean(env.OPENROUTER_API_KEY),
    rawg: Boolean(env.RAWG_API_KEY),
    alerts: Boolean(env.ALERT_WEBHOOK_URL),
    ownerKey: Boolean(env.STUDIO_OWNER_KEY),
  };
}

async function userNames(env: Env, ids: (string | null | undefined)[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))] as string[];
  if (!unique.length) return {};
  const rows = await env.DB.prepare(`SELECT id, name FROM users WHERE id IN (${unique.map(() => "?").join(",")})`)
    .bind(...unique)
    .all<{ id: string; name: string }>();
  return Object.fromEntries(rows.results.map((r) => [r.id, r.name]));
}

async function articleDetail(c: Ctx, row: ArticleRow) {
  const { env, user } = c;
  const notes = await env.DB.prepare(
    "SELECT n.id, n.body, n.created_at, n.resolved_at, n.user_id, u.name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.article_id = ? ORDER BY n.id",
  )
    .bind(row.id)
    .all<{ id: number; body: string; created_at: number; resolved_at: number | null; user_id: string; name: string | null }>();
  const names = await userNames(env, [row.created_by, row.updated_by, row.locked_by, row.assigned_to]);
  const lockActive = row.locked_by && row.locked_by !== user!.id && row.locked_at && now() - row.locked_at < 75_000;
  const media = await env.DB.prepare("SELECT * FROM media WHERE article_id = ? ORDER BY created_at DESC LIMIT 200")
    .bind(row.id)
    .all<MediaRow>();
  return {
    article: { ...rowSummary(row), rev: row.draft_rev, gitPath: row.git_path, publishCommit: row.publish_commit },
    draft: draftOf(row),
    live: liveOf(row),
    built: await isBuilt(env, row),
    notes: notes.results.map((n) => ({
      id: n.id,
      body: n.body,
      createdAt: n.created_at,
      resolvedAt: n.resolved_at,
      userId: n.user_id,
      userName: n.name,
    })),
    names,
    lockedBy: lockActive ? { id: row.locked_by, name: names[row.locked_by!] ?? "Someone" } : null,
    media: media.results.map(mediaJson),
    permissions: {
      edit: can(user!, "edit", row),
      submit: can(user!, "submit", row),
      review: can(user!, "approve", row),
      publish: can(user!, "publish", row),
      unpublish: can(user!, "unpublish", row) && Boolean(row.live_json),
      delete: can(user!, "delete", row),
    },
  };
}

async function loadEditable(c: Ctx, id: string, action: Parameters<typeof can>[1]): Promise<ArticleRow | Response> {
  const row = await getArticle(c.env, decodeURIComponent(id));
  if (!row) return error(404, "Article not found.");
  if (!can(c.user!, action, row)) return error(403, "You don't have permission to do that.");
  return row;
}

// ---------------------------------------------------------------------------
// Session & sign-in

route("GET", "/me", "public", async (c) => {
  const hasUsers = (await userCount(c.env)) > 0;
  return json({
    user: c.user,
    env: c.env.SITE_ENV,
    setup: { hasUsers, ownerKey: Boolean(c.env.STUDIO_OWNER_KEY), google: googleConfigured(c.env) },
  });
});

route("POST", "/auth/owner", "public", async (c) => {
  const limited = await limitAuth(c);
  if (limited) return limited;
  const b = await body<{ key?: string; email?: string; name?: string }>(c.request);
  const result = await ownerSignIn(c.env, String(b.key || ""), String(b.email || ""), String(b.name || ""));
  if ("error" in result) return error(401, result.error);
  return withCookie(json({ ok: true }), await startSession(c.env, result.userId, c.request));
});

route("GET", "/auth/google/start", "public", async (c) => {
  if (!googleConfigured(c.env)) return redirect("/studio/login/?error=" + encodeURIComponent("Google sign-in isn't set up yet."));
  const { url, cookie } = await googleStart(c.env, c.url.origin, c.url.searchParams.get("invite"));
  return redirect(url, [cookie]);
});

route("GET", "/auth/google/callback", "public", async (c) => {
  const fail = (msg: string) => redirect("/studio/login/?error=" + encodeURIComponent(msg));
  const result = await googleFinish(c.env, c.request, c.url.origin);
  if ("error" in result) return fail(result.error);
  let userId: string | null = null;
  if (result.invite) {
    const accepted = await acceptInvite(c.env, result.invite, { email: result.email, name: result.name, avatar: result.picture });
    if ("error" in accepted) return fail(accepted.error);
    userId = accepted.userId;
  } else {
    const existing = await findUserByEmail(c.env, result.email);
    if (!existing || existing.status !== "active") {
      return fail(`${result.email} isn't on the PlayTested team. Ask the chief editor for an invite.`);
    }
    userId = existing.id;
    await c.env.DB.prepare("UPDATE users SET avatar = COALESCE(avatar, ?) WHERE id = ?").bind(result.picture, userId).run();
  }
  const session = await startSession(c.env, userId, c.request);
  return redirect("/studio/", [session, "pt_oauth=; Path=/api/studio/auth/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"]);
});

route("POST", "/auth/link", "public", async (c) => {
  const limited = await limitAuth(c);
  if (limited) return limited;
  const { token } = await body<{ token?: string }>(c.request);
  const userId = token ? await consumeLoginLink(c.env, token) : null;
  if (!userId) return error(401, "This sign-in link has expired or was already used.");
  return withCookie(json({ ok: true }), await startSession(c.env, userId, c.request));
});

route("GET", "/invite/:token", "public", async (c, m) => {
  const invite = await lookupInvite(c.env, decodeURIComponent(m[1]));
  if (!invite) return error(404, "This invite link has expired or was already used.");
  return json({ email: invite.email, role: invite.role, google: googleConfigured(c.env) });
});

route("POST", "/auth/invite", "public", async (c) => {
  const limited = await limitAuth(c);
  if (limited) return limited;
  const { token, name } = await body<{ token?: string; name?: string }>(c.request);
  if (!token) return error(400, "Missing invite.");
  const accepted = await acceptInvite(c.env, token, { name });
  if ("error" in accepted) return error(400, accepted.error);
  return withCookie(json({ ok: true }), await startSession(c.env, accepted.userId, c.request));
});

route("POST", "/auth/logout", "public", async (c) => withCookie(json({ ok: true }), await endSession(c.env, c.request)));

// ---------------------------------------------------------------------------
// Articles

route("GET", "/articles", "contributor", async (c) => {
  const p = c.url.searchParams;
  const where: string[] = [];
  const args: unknown[] = [];
  const state = p.get("state");
  if (state === "scheduled") {
    where.push("live_json IS NOT NULL AND pub_date > ?");
    args.push(now());
  } else if (state === "pending") {
    where.push("live_json IS NOT NULL AND state != 'published'");
  } else if (state === "unpublished") {
    where.push("live_json IS NULL");
  } else if (state) {
    where.push("state = ?");
    args.push(state);
  }
  const q = (p.get("q") || "").trim();
  if (q) {
    where.push("(title LIKE ? OR slug LIKE ?)");
    args.push(`%${q}%`, `%${q}%`);
  }
  if (p.get("category")) {
    where.push("category = ?");
    args.push(p.get("category"));
  }
  if (p.get("author")) {
    where.push("author = ?");
    args.push(p.get("author"));
  }
  if (p.get("mine") === "1") {
    where.push("created_by = ?");
    args.push(c.user!.id);
  }
  const sort = { updated: "updated_at DESC", pub: "pub_date DESC", title: "title COLLATE NOCASE ASC", score: "score DESC" }[
    p.get("sort") || "updated"
  ] ?? "updated_at DESC";
  const pageSize = Math.min(Math.max(Number(p.get("pageSize")) || 30, 1), 100);
  const page = Math.max(Number(p.get("page")) || 1, 1);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows, total, counts, scheduled, pending] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT * FROM articles ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`).bind(...args, pageSize, (page - 1) * pageSize),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM articles ${whereSql}`).bind(...args),
    c.env.DB.prepare("SELECT state, COUNT(*) AS n FROM articles GROUP BY state"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM articles WHERE live_json IS NOT NULL AND pub_date > ?").bind(now()),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM articles WHERE live_json IS NOT NULL AND state != 'published'"),
  ]);
  const list = (rows.results as ArticleRow[]).map(rowSummary);
  const names = await userNames(c.env, list.flatMap((a) => [a.updatedBy, a.createdBy]));
  return json({
    articles: list,
    names,
    total: (total.results[0] as { n: number }).n,
    page,
    pageSize,
    counts: {
      ...Object.fromEntries((counts.results as { state: string; n: number }[]).map((r) => [r.state, r.n])),
      scheduled: (scheduled.results[0] as { n: number }).n,
      pending: (pending.results[0] as { n: number }).n,
    },
  });
});

route("POST", "/articles", "contributor", async (c) => {
  const b = await body<{ data?: Partial<ArticleData> }>(c.request);
  const row = await createArticle(c.env, c.user!, b.data ?? {});
  return json(await articleDetail(c, row), { status: 201 });
});

route("GET", "/articles/:id", "contributor", async (c, m) => {
  const row = await getArticle(c.env, decodeURIComponent(m[1]));
  if (!row) return error(404, "Article not found.");
  return json(await articleDetail(c, row));
});

route("PUT", "/articles/:id", "contributor", async (c, m) => {
  const row = await loadEditable(c, m[1], "edit");
  if (row instanceof Response) return row;
  const b = await body<{ data?: Partial<ArticleData>; rev?: number; autosave?: boolean }>(c.request);
  if (!b.data || typeof b.rev !== "number") return error(400, "Missing data or rev.");
  let kind: string | null = b.autosave ? null : "save";
  if (b.autosave) {
    // Keep a history point at least every 15 minutes of autosaving.
    const last = await c.env.DB.prepare("SELECT created_at FROM revisions WHERE article_id = ? ORDER BY id DESC LIMIT 1")
      .bind(row.id)
      .first<{ created_at: number }>();
    if (!last || now() - last.created_at > 15 * 60_000) kind = "autosave";
  }
  const saved = await saveDraft(c.env, c.user!, row, b.data, b.rev, kind);
  return json(await articleDetail(c, saved));
});

route("POST", "/articles/:id/lock", "contributor", async (c, m) => {
  const row = await getArticle(c.env, decodeURIComponent(m[1]));
  if (!row) return error(404, "Article not found.");
  if (row.locked_by && row.locked_by !== c.user!.id && row.locked_at && now() - row.locked_at < 75_000) {
    const names = await userNames(c.env, [row.locked_by]);
    return json({ ok: false, lockedBy: { id: row.locked_by, name: names[row.locked_by] ?? "Someone" } });
  }
  await c.env.DB.prepare("UPDATE articles SET locked_by = ?, locked_at = ? WHERE id = ?").bind(c.user!.id, now(), row.id).run();
  return json({ ok: true, rev: row.draft_rev, updatedBy: row.updated_by });
});

route("POST", "/articles/:id/unlock", "contributor", async (c, m) => {
  await c.env.DB.prepare("UPDATE articles SET locked_by = NULL, locked_at = NULL WHERE (id = ? OR slug = ?) AND locked_by = ?")
    .bind(decodeURIComponent(m[1]), decodeURIComponent(m[1]), c.user!.id)
    .run();
  return json({ ok: true });
});

route("POST", "/articles/:id/submit", "contributor", async (c, m) => {
  const row = await loadEditable(c, m[1], "submit");
  if (row instanceof Response) return row;
  if (row.state === "published") return error(400, "There are no unpublished changes to submit.");
  const { note } = await body<{ note?: string }>(c.request);
  return json(await articleDetail(c, await setState(c.env, c.user!, row, "in_review", "submit", note?.trim() || null)));
});

route("POST", "/articles/:id/request-changes", "chief", async (c, m) => {
  const row = await loadEditable(c, m[1], "request_changes");
  if (row instanceof Response) return row;
  const { note } = await body<{ note?: string }>(c.request);
  if (!note?.trim()) return error(400, "Say what needs to change.");
  return json(await articleDetail(c, await setState(c.env, c.user!, row, "changes_requested", "request_changes", note.trim())));
});

route("POST", "/articles/:id/approve", "chief", async (c, m) => {
  const row = await loadEditable(c, m[1], "approve");
  if (row instanceof Response) return row;
  const { note } = await body<{ note?: string }>(c.request);
  return json(await articleDetail(c, await setState(c.env, c.user!, row, "approved", "approve", note?.trim() || null)));
});

/** Images the article references that still need uploading to GitHub. */
async function pendingBlobs(env: Env, data: ArticleData): Promise<MediaRow[]> {
  const media = await mediaForPaths(env, referencedImages(data));
  return media.filter((m) => !m.committed);
}

route("POST", "/articles/:id/publish", "chief", async (c, m) => {
  const row = await loadEditable(c, m[1], "publish");
  if (row instanceof Response) return row;
  const { rev } = await body<{ rev?: number }>(c.request);
  if (rev !== row.draft_rev) throw new ConflictError(row);
  if (!githubConfigured(c.env)) return error(503, "GitHub isn't connected yet, so publishing can't update the site. Add the GITHUB_TOKEN secret.");

  const data = finalise(draftOf(row));
  const problems = validateForPublish(data);
  if (await slugTaken(c.env, data.slug, row.id)) problems.push(`The slug "${data.slug}" is already used.`);
  if (problems.length) return error(422, "Fix these before publishing.", { problems });

  const images = await pendingBlobs(c.env, data);
  const missing = images.filter((i) => !i.blob_sha);
  if (missing.length) {
    // The studio uploads these one per request (keeps each call small), then retries.
    return json({ error: "Images need uploading first.", code: "needs_blobs", media: missing.map((i) => i.id) }, { status: 409 });
  }

  const markdown = toMarkdown(data);
  const hash = await fileHash(markdown);
  const gitPath = row.git_path || `src/content/article/${data.slug}.md`;
  const entries: TreeEntry[] = [
    { path: gitPath, content: markdown },
    ...images.map((i) => ({ path: `public${i.public_path}`, sha: i.blob_sha! })),
  ];
  const isFuture = Date.parse(data.pubDate) > now();
  const verb = row.live_json ? "update" : isFuture ? "schedule" : "publish";
  const commit = await commitFiles(c.env, `studio: ${verb} “${data.title}”\n\nBy ${c.user!.name} via PlayTested Studio.`, entries, {
    name: c.user!.name,
    email: c.user!.email,
  });

  if (!row.git_path) await c.env.DB.prepare("UPDATE articles SET git_path = ? WHERE id = ?").bind(gitPath, row.id).run();
  if (images.length) {
    await c.env.DB.prepare(`UPDATE media SET committed = 1 WHERE id IN (${images.map(() => "?").join(",")})`)
      .bind(...images.map((i) => i.id))
      .run();
  }
  const published = await markPublished(c.env, c.user!, row, data, hash, commit);
  await recordDeploy(c.env, "publish", "requested", { commit: commit.sha, userId: c.user!.id, message: data.title });
  c.waitUntil(indexArticle(c.env, data, hash).catch((e) => console.error("index failed", e)));
  return json({ ...(await articleDetail(c, published)), commit });
});

route("POST", "/articles/:id/unpublish", "chief", async (c, m) => {
  const row = await loadEditable(c, m[1], "unpublish");
  if (row instanceof Response) return row;
  if (!row.live_json || !row.git_path) return error(400, "This article isn't published.");
  if (!githubConfigured(c.env)) return error(503, "GitHub isn't connected yet.");
  const live = liveOf(row)!;
  const commit = await commitFiles(c.env, `studio: unpublish “${live.title}”\n\nBy ${c.user!.name} via PlayTested Studio.`, [
    { path: row.git_path, delete: true },
  ]);
  await markUnpublished(c.env, c.user!, row, commit.sha);
  await recordDeploy(c.env, "unpublish", "requested", { commit: commit.sha, userId: c.user!.id, message: live.title });
  c.waitUntil(removeFromIndex(c.env, live.slug).catch(() => undefined));
  return json(await articleDetail(c, (await getArticle(c.env, row.id))!));
});

route("DELETE", "/articles/:id", "contributor", async (c, m) => {
  const row = await loadEditable(c, m[1], "delete");
  if (row instanceof Response) return row;
  if (row.live_json) return error(400, "Unpublish this article before deleting it.");
  const media = await c.env.DB.prepare("SELECT * FROM media WHERE article_id = ? AND committed = 0").bind(row.id).all<MediaRow>();
  for (const md of media.results) await c.env.MEDIA.delete(md.r2_key);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM media WHERE article_id = ? AND committed = 0").bind(row.id),
    c.env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(row.id),
  ]);
  await audit(c.env.DB, c.user!.id, "article.delete", row.id, { title: row.title });
  return json({ ok: true });
});

route("GET", "/articles/:id/revisions", "contributor", async (c, m) => {
  const row = await getArticle(c.env, decodeURIComponent(m[1]));
  if (!row) return error(404, "Article not found.");
  const revs = await c.env.DB.prepare(
    `SELECT r.id, r.rev, r.kind, r.note, r.created_at, r.user_id, u.name FROM revisions r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.article_id = ? ORDER BY r.id DESC LIMIT 150`,
  )
    .bind(row.id)
    .all<{ id: number; rev: number; kind: string; note: string | null; created_at: number; user_id: string | null; name: string | null }>();
  return json({
    revisions: revs.results.map((r) => ({
      id: r.id,
      rev: r.rev,
      kind: r.kind,
      note: r.note,
      createdAt: r.created_at,
      userId: r.user_id,
      userName: r.name ?? (r.kind === "import" || r.kind === "sync" ? "Git" : null),
    })),
  });
});

route("GET", "/revisions/:id", "contributor", async (c, m) => {
  const r = await c.env.DB.prepare("SELECT id, article_id, rev, kind, data_json, created_at FROM revisions WHERE id = ?")
    .bind(Number(m[1]))
    .first<{ id: number; article_id: string; rev: number; kind: string; data_json: string; created_at: number }>();
  if (!r) return error(404, "Revision not found.");
  return json({ id: r.id, articleId: r.article_id, rev: r.rev, kind: r.kind, createdAt: r.created_at, data: normaliseData(parseJson(r.data_json, {})) });
});

route("POST", "/articles/:id/restore", "contributor", async (c, m) => {
  const row = await loadEditable(c, m[1], "restore");
  if (row instanceof Response) return row;
  const { revisionId, rev } = await body<{ revisionId?: number; rev?: number }>(c.request);
  const r = await c.env.DB.prepare("SELECT data_json FROM revisions WHERE id = ? AND article_id = ?")
    .bind(Number(revisionId), row.id)
    .first<{ data_json: string }>();
  if (!r) return error(404, "Revision not found.");
  const saved = await saveDraft(c.env, c.user!, row, parseJson(r.data_json, {}), Number(rev), "restore", undefined, `Restored #${revisionId}`);
  return json(await articleDetail(c, saved));
});

route("POST", "/articles/:id/notes", "contributor", async (c, m) => {
  const row = await getArticle(c.env, decodeURIComponent(m[1]));
  if (!row) return error(404, "Article not found.");
  const { text } = await body<{ text?: string }>(c.request);
  if (!text?.trim()) return error(400, "Write a note first.");
  await c.env.DB.prepare("INSERT INTO notes (article_id, user_id, body, created_at) VALUES (?, ?, ?, ?)")
    .bind(row.id, c.user!.id, text.trim().slice(0, 4000), now())
    .run();
  return json(await articleDetail(c, row));
});

route("POST", "/notes/:id/resolve", "contributor", async (c, m) => {
  const note = await c.env.DB.prepare("SELECT article_id, user_id FROM notes WHERE id = ?").bind(Number(m[1])).first<{ article_id: string; user_id: string }>();
  if (!note) return error(404, "Note not found.");
  if (c.user!.role !== "chief" && note.user_id !== c.user!.id) return error(403, "Only the chief editor or the note's author can resolve it.");
  await c.env.DB.prepare("UPDATE notes SET resolved_at = ? WHERE id = ?").bind(now(), Number(m[1])).run();
  return json(await articleDetail(c, (await getArticle(c.env, note.article_id))!));
});

route("GET", "/meta", "contributor", async (c) => {
  const [cats, tags, authors] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT category AS v, COUNT(*) AS n FROM articles WHERE category IS NOT NULL GROUP BY category ORDER BY n DESC"),
    c.env.DB.prepare(
      "SELECT j.value AS v, COUNT(*) AS n FROM articles a, json_each(json_extract(a.draft_json, '$.tags')) j GROUP BY j.value ORDER BY n DESC LIMIT 300",
    ),
    c.env.DB.prepare("SELECT author AS v, COUNT(*) AS n FROM articles WHERE author IS NOT NULL GROUP BY author ORDER BY n DESC"),
  ]);
  const pick = (r: D1Result) => (r.results as { v: string; n: number }[]).map((x) => ({ value: x.v, count: x.n }));
  return json({ categories: pick(cats), tags: pick(tags), authors: pick(authors) });
});

// ---------------------------------------------------------------------------
// Media

route("POST", "/media", "contributor", async (c) => {
  const h = c.request.headers;
  const mime = (h.get("content-type") || "").split(";")[0].trim();
  const len = Number(h.get("content-length") || 0);
  if (len > 15 * 1024 * 1024) return error(413, "Image is larger than 15 MB.");
  try {
    const row = await storeUpload(c.env, await c.request.arrayBuffer(), {
      mime,
      filename: decodeURIComponent(h.get("x-filename") || "image"),
      width: Number(h.get("x-width")) || undefined,
      height: Number(h.get("x-height")) || undefined,
      alt: h.get("x-alt") ? decodeURIComponent(h.get("x-alt")!) : undefined,
      articleId: h.get("x-article-id") || undefined,
      userId: c.user!.id,
    });
    return json({ media: mediaJson(row) }, { status: 201 });
  } catch (e) {
    return error(400, (e as Error).message);
  }
});

route("GET", "/media", "contributor", async (c) => {
  const p = c.url.searchParams;
  const pageSize = Math.min(Number(p.get("pageSize")) || 60, 200);
  const page = Math.max(Number(p.get("page")) || 1, 1);
  const where = p.get("article") ? "WHERE article_id = ?" : "";
  const args = p.get("article") ? [p.get("article")] : [];
  const rows = await c.env.DB.prepare(`SELECT * FROM media ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...args, pageSize, (page - 1) * pageSize)
    .all<MediaRow>();
  return json({ media: rows.results.map(mediaJson), page, pageSize });
});

route("PATCH", "/media/:id", "contributor", async (c, m) => {
  const { alt, articleId } = await body<{ alt?: string; articleId?: string }>(c.request);
  await c.env.DB.prepare("UPDATE media SET alt = COALESCE(?, alt), article_id = COALESCE(?, article_id) WHERE id = ?")
    .bind(alt ?? null, articleId ?? null, m[1])
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(m[1]).first<MediaRow>();
  return row ? json({ media: mediaJson(row) }) : error(404, "Image not found.");
});

route("DELETE", "/media/:id", "contributor", async (c, m) => {
  const row = await c.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(m[1]).first<MediaRow>();
  if (!row) return error(404, "Image not found.");
  if (row.committed) return error(400, "This image is already published on the site; remove it from the article instead.");
  if (c.user!.role !== "chief" && row.uploaded_by !== c.user!.id) return error(403, "You can only delete your own uploads.");
  await c.env.MEDIA.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM media WHERE id = ?").bind(row.id).run();
  return json({ ok: true });
});

route("POST", "/media/:id/blob", "chief", async (c, m) => {
  const row = await c.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(m[1]).first<MediaRow>();
  if (!row) return error(404, "Image not found.");
  return json({ id: row.id, sha: await ensureBlob(c.env, row) });
});

// ---------------------------------------------------------------------------
// Team

route("GET", "/users", "editor", async (c) => {
  const [users, invites] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id, email, name, avatar, author_name, role, status, created_at, last_login_at FROM users ORDER BY role, name"),
    c.env.DB.prepare("SELECT id, email, role, author_name, created_at, expires_at FROM invites WHERE accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC").bind(now()),
  ]);
  return json({ users: users.results, invites: c.user!.role === "chief" ? invites.results : [] });
});

route("PATCH", "/users/:id", "chief", async (c, m) => {
  const b = await body<{ role?: Role; status?: "active" | "disabled"; name?: string; authorName?: string }>(c.request);
  const target = m[1];
  if (target === c.user!.id && ((b.role && b.role !== "chief") || b.status === "disabled")) {
    const chiefs = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'chief' AND status = 'active'").first<{ n: number }>();
    if ((chiefs?.n ?? 0) <= 1) return error(400, "You're the only chief editor — promote someone else first.");
  }
  if (b.role && !(b.role in RANK)) return error(400, "Unknown role.");
  await c.env.DB.prepare(
    "UPDATE users SET role = COALESCE(?, role), status = COALESCE(?, status), name = COALESCE(?, name), author_name = COALESCE(?, author_name) WHERE id = ?",
  )
    .bind(b.role ?? null, b.status ?? null, b.name ?? null, b.authorName ?? null, target)
    .run();
  if (b.status === "disabled") await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target).run();
  await audit(c.env.DB, c.user!.id, "user.update", target, b);
  return json({ ok: true });
});

route("POST", "/users/:id/login-link", "chief", async (c, m) => {
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").bind(m[1]).first();
  if (!exists) return error(404, "User not found.");
  const token = await createLoginLink(c.env, c.user!, m[1]);
  return json({ url: `${c.url.origin}/studio/login/?link=${encodeURIComponent(token)}`, expiresInHours: 24 });
});

route("POST", "/invites", "chief", async (c) => {
  const b = await body<{ email?: string; role?: Role; authorName?: string }>(c.request);
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return error(400, "Enter a valid email address.");
  const role = b.role && b.role in RANK ? b.role : "contributor";
  const existing = await findUserByEmail(c.env, email);
  if (existing && existing.status === "active") return error(400, "That person is already on the team.");
  const { token } = await createInvite(c.env, c.user!, email, role, b.authorName?.trim() || null);
  return json({ url: `${c.url.origin}/studio/invite/?token=${encodeURIComponent(token)}`, expiresInDays: 14 }, { status: 201 });
});

route("DELETE", "/invites/:id", "chief", async (c, m) => {
  await c.env.DB.prepare("DELETE FROM invites WHERE id = ? AND accepted_at IS NULL").bind(m[1]).run();
  await audit(c.env.DB, c.user!.id, "invite.revoke", m[1]);
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Guards, deploys, activity, search index

async function guardsPayload(c: Ctx, g: GuardSettings) {
  const counts = await c.env.DB.prepare("SELECT metric, count FROM usage_daily WHERE day = ?").bind(utcDay()).all<{ metric: string; count: number }>();
  return {
    settings: g,
    defaults: DEFAULT_GUARDS,
    level: currentLevel(g),
    today: Object.fromEntries(counts.results.map((r) => [r.metric, r.count])),
    integrations: integrations(c.env),
    env: c.env.SITE_ENV,
  };
}

route("GET", "/guards", "editor", async (c) => json(await guardsPayload(c, await getGuards(c.env, 0))));

route("PUT", "/guards", "chief", async (c) => {
  const b = await body<Partial<GuardSettings>>(c.request);
  const patch: Partial<GuardSettings> = {};
  if (b.mode && ["auto", "normal", "conserve", "essential"].includes(b.mode)) patch.mode = b.mode;
  const clamp = (v: unknown, lo: number, hi: number) => Math.min(Math.max(Math.round(Number(v)), lo), hi);
  if (b.dailyLimit !== undefined) patch.dailyLimit = clamp(b.dailyLimit, 1000, 10_000_000);
  if (b.liveFallbackMinutes !== undefined) patch.liveFallbackMinutes = clamp(b.liveFallbackMinutes, 0, 1440);
  if (b.thresholds) {
    patch.thresholds = {
      conserve: clamp(b.thresholds.conserve ?? 60, 5, 99),
      essential: clamp(b.thresholds.essential ?? 85, 6, 100),
    };
  }
  if (b.features) patch.features = Object.fromEntries(Object.entries(b.features).map(([k, v]) => [k, Boolean(v)])) as GuardSettings["features"];
  if (b.caps) patch.caps = Object.fromEntries(Object.entries(b.caps).map(([k, v]) => [k, clamp(v, 0, 1_000_000)])) as GuardSettings["caps"];
  const next = await saveGuards(c.env, patch, c.user!.id);
  await audit(c.env.DB, c.user!.id, "guards.update", null, patch);
  return json(await guardsPayload(c, next));
});

route("POST", "/guards/check", "chief", async (c) => {
  await runWatchdog(c.env);
  return json(await guardsPayload(c, await getGuards(c.env, 0)));
});

route("GET", "/deploys", "contributor", async (c) => {
  const [info, recent] = await Promise.all([
    getBuildInfo(c.env, 5_000),
    c.env.DB.prepare(
      "SELECT d.*, u.name AS user_name FROM deploys d LEFT JOIN users u ON u.id = d.requested_by ORDER BY d.id DESC LIMIT 15",
    ).all(),
  ]);
  let runs: unknown[] = [];
  let runsError: string | null = null;
  if (githubConfigured(c.env)) {
    try {
      runs = await listDeployRuns(c.env, 8);
    } catch (e) {
      runsError = (e as Error).message;
    }
  }
  return json({ build: info, recent: recent.results, runs, runsError, github: githubConfigured(c.env) });
});

route("POST", "/deploys", "chief", async (c) => {
  if (!githubConfigured(c.env)) return error(503, "GitHub isn't connected yet.");
  await dispatchDeploy(c.env, "manual");
  await recordDeploy(c.env, "manual", "requested", { userId: c.user!.id });
  await audit(c.env.DB, c.user!.id, "deploy.manual");
  return json({ ok: true });
});

route("GET", "/activity", "editor", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.action, l.target, l.meta, l.created_at, l.user_id, u.name, a.title AS article_title
     FROM audit_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN articles a ON a.id = l.target
     ORDER BY l.id DESC LIMIT ?`,
  )
    .bind(Math.min(Number(c.url.searchParams.get("limit")) || 60, 200))
    .all();
  return json({ activity: rows.results });
});

route("GET", "/index", "editor", async (c) => {
  const [docs, pending] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(chunk_count), 0) AS chunks, MAX(indexed_at) AS last FROM search_docs"),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM articles a LEFT JOIN search_docs s ON s.slug = a.slug
       WHERE a.live_json IS NOT NULL AND (s.slug IS NULL OR s.hash != a.live_hash)`,
    ),
  ]);
  const d = docs.results[0] as { n: number; chunks: number; last: number | null };
  return json({ indexed: d.n, chunks: d.chunks, lastIndexedAt: d.last, pending: (pending.results[0] as { n: number }).n });
});

route("POST", "/index/run", "chief", async (c) => json(await reindexPending(c.env, 6)));

// ---------------------------------------------------------------------------

export async function handleStudio(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.replace(/^\/api\/studio/, "") || "/";

  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin !== url.origin) return error(403, "Cross-site request blocked.");
  }

  for (const r of routes) {
    if (r.method !== request.method && !(r.method === "GET" && request.method === "HEAD")) continue;
    const m = r.re.exec(sub);
    if (!m) continue;
    const user = await getSessionUser(env, request);
    if (r.min !== "public") {
      if (!user) return error(401, "Please sign in.");
      if (RANK[user.role] < RANK[r.min]) return error(403, "You don't have permission to do that.");
    }
    const c: Ctx = { env, request, url, user, waitUntil: (p) => ctx.waitUntil(p) };
    try {
      return await r.fn(c, m);
    } catch (e) {
      if (e instanceof ConflictError) {
        const names = await userNames(env, [e.current.updated_by]);
        return error(409, e.message, {
          code: "conflict",
          rev: e.current.draft_rev,
          updatedBy: names[e.current.updated_by ?? ""] ?? null,
          updatedAt: e.current.updated_at,
        });
      }
      if (e instanceof GitHubError) return error(e.status >= 500 ? 502 : e.status, e.message, { code: "github" });
      console.error("studio error", sub, e);
      return error(500, (e as Error).message || "Something went wrong.");
    }
  }
  return error(404, "Not found.");
}
