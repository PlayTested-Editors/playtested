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
  clearOAuthCookie,
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
  freeGitPath,
  getArticle,
  isOwnArticle,
  liveOf,
  markPublished,
  markUnpublished,
  normaliseData,
  referencedImages,
  rowSummary,
  saveDraft,
  setState,
  SlugTakenError,
  slugTaken,
  SUBMITTABLE,
  toMarkdown,
  toSiteIso,
  validateForPublish,
  type ArticleData,
  type ArticleRow,
} from "../articles";
import { commitFiles, dispatchDeploy, GitHubError, githubConfigured, listDeployRuns, type TreeEntry } from "../github";
import { DEFAULT_GUARDS, currentLevel, getGuards, saveGuards, withinRate, type GuardSettings } from "../guards";
import { ensureBlob, mediaForPaths, mediaJson, stageDelete, storeUpload, type MediaRow } from "../media";
import { getBuildInfo, isBuilt, recordDeploy } from "../deploys";
import { indexArticle, markIndexDirty, reindexPending, removeFromIndex } from "../search";
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
  // The review step behind the current state: the chief's request (shown to the
  // writer) or the submission (to tell the chief if it was edited since). Only
  // looked up in those states; the newest matching revision is a few rows back.
  let review: { kind: string; rev: number; note: string | null; by: string | null; at: number } | null = null;
  if (row.state === "changes_requested" || row.state === "in_review") {
    const r = await env.DB.prepare(
      "SELECT kind, rev, note, user_id, created_at FROM revisions WHERE article_id = ? AND kind IN ('submit', 'request_changes') ORDER BY id DESC LIMIT 1",
    )
      .bind(row.id)
      .first<{ kind: string; rev: number; note: string | null; user_id: string | null; created_at: number }>();
    if (r) review = { kind: r.kind, rev: r.rev, note: r.note, by: r.user_id, at: r.created_at };
  }
  const names = await userNames(env, [row.created_by, row.updated_by, row.locked_by, row.assigned_to, review?.by]);
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
    review: review
      ? {
          kind: review.kind,
          note: review.note,
          by: review.by,
          byName: review.by ? (names[review.by] ?? null) : null,
          at: review.at,
          // The text changed after it was submitted (the hint names who changed it last).
          editedSince: review.kind === "submit" && row.draft_rev > review.rev,
        }
      : null,
    lockedBy: lockActive ? { id: row.locked_by, name: names[row.locked_by!] ?? "Someone" } : null,
    media: media.results.map(mediaJson),
    permissions: {
      edit: can(user!, "edit", row),
      submit: can(user!, "submit", row) && SUBMITTABLE.includes(row.state),
      // The chief, a note's author, or the article's owner resolves notes.
      resolveNotes: user!.role === "chief" || isOwnArticle(user!, row),
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
  return redirect("/studio/", [session, clearOAuthCookie(c.request)]);
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
  // With Google configured the invite must be accepted through Google, which
  // proves the invited email; the link alone is only enough without Google.
  if (googleConfigured(c.env)) return error(400, "Accept this invite with Google, using the invited account.");
  const { token, name } = await body<{ token?: string; name?: string }>(c.request);
  if (!token) return error(400, "Missing invite.");
  const accepted = await acceptInvite(c.env, token, { name: name ? String(name).slice(0, 100) : undefined });
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
    where.push("state IN ('draft', 'in_review', 'changes_requested', 'approved') AND live_json IS NOT NULL");
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
  // Yours = created in the studio by you, or under your byline (imported articles
  // have no creator). Both columns are indexed, so SQLite unions two index scans.
  const byline = c.user!.authorName?.trim();
  const mineSql = byline ? "(created_by = ? OR author = ?)" : "created_by = ?";
  const mineArgs: unknown[] = byline ? [c.user!.id, byline] : [c.user!.id];
  const mine = p.get("mine") === "1";
  if (mine) {
    where.push(mineSql);
    args.push(...mineArgs);
  }
  const sort = { updated: "updated_at DESC", pub: "pub_date DESC", title: "title COLLATE NOCASE ASC", score: "score DESC" }[
    p.get("sort") || "updated"
  ] ?? "updated_at DESC";
  const pageSize = Math.min(Math.max(Number(p.get("pageSize")) || 30, 1), 100);
  const page = Math.max(Number(p.get("page")) || 1, 1);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Every query here reads through an index, so a list view costs roughly
  // the rows it shows, not the whole table (D1 free plan: 5M rows read/day).
  // No total COUNT(*): paging uses pageSize + 1 to know if there's more.
  // The tab counts follow "Mine only" (they read the state / pub_date indexes,
  // i.e. only in-progress or scheduled rows, then filter to yours).
  const and = mine ? ` AND ${mineSql}` : "";
  const cArgs = mine ? mineArgs : [];
  const isChiefUser = c.user!.role === "chief";
  const [rows, counts, scheduled, pending, myChanges] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT * FROM articles ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`).bind(...args, pageSize + 1, (page - 1) * pageSize),
    c.env.DB.prepare(
      `SELECT state, COUNT(*) AS n FROM articles WHERE state IN ('draft', 'in_review', 'changes_requested', 'approved')${and} GROUP BY state`,
    ).bind(...cArgs),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM articles WHERE pub_date > ? AND live_json IS NOT NULL${and}`).bind(now(), ...cArgs),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM articles WHERE state IN ('draft', 'in_review', 'changes_requested', 'approved') AND live_json IS NOT NULL${and}`,
    ).bind(...cArgs),
    // Writers' sidebar badge: their own pieces waiting on changes (state index, then filter).
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM articles WHERE state = 'changes_requested' AND ${isChiefUser ? "0" : mineSql}`).bind(
      ...(isChiefUser ? [] : mineArgs),
    ),
  ]);
  const all = rows.results as ArticleRow[];
  const list = all.slice(0, pageSize).map((row) => ({ ...rowSummary(row), canDelete: can(c.user!, "delete", row) && !row.live_json }));
  const names = await userNames(c.env, list.flatMap((a) => [a.updatedBy, a.createdBy]));
  const stateCounts = Object.fromEntries((counts.results as { state: string; n: number }[]).map((r) => [r.state, r.n]));
  const extra = {
    scheduled: (scheduled.results[0] as { n: number }).n,
    pending: (pending.results[0] as { n: number }).n,
    mine_changes_requested: (myChanges.results[0] as { n: number }).n,
  };
  // A total is only known (cheaply) for the in-progress tabs.
  const total = !q && !p.get("category") && !p.get("author") && state
    ? ((stateCounts as Record<string, number>)[state] ?? (extra as Record<string, number>)[state] ?? null)
    : null;
  return json({
    articles: list,
    names,
    total,
    hasMore: all.length > pageSize,
    page,
    pageSize,
    counts: { ...stateCounts, ...extra },
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

/**
 * Editor heartbeat (every 30s while an article is open). `hold: true` takes or
 * renews the presence lock — sent only once this person has edited, so merely
 * reading an article never shows you as "editing". Every call also reports the
 * article's workflow state, draft rev, who last changed it and the open-note
 * count, so an open editor notices reviews and other people's saves.
 */
route("POST", "/articles/:id/lock", "contributor", async (c, m) => {
  let row = await getArticle(c.env, decodeURIComponent(m[1]));
  if (!row) return error(404, "Article not found.");
  const { hold } = await body<{ hold?: boolean }>(c.request);
  const me = c.user!.id;
  const t = now();
  const canEdit = can(c.user!, "edit", row);
  let ok = false;
  // Only people who can edit take the presence lock (a read-only viewer must
  // not show up as "editing" and block the real author).
  if (hold && canEdit) {
    // Atomic take-or-renew: two people starting to edit at once can't both get it.
    const res = await c.env.DB.prepare(
      "UPDATE articles SET locked_by = ?, locked_at = ? WHERE id = ? AND (locked_by IS NULL OR locked_by = ? OR locked_at IS NULL OR locked_at < ?)",
    )
      .bind(me, t, row.id, me, t - 75_000)
      .run();
    ok = Boolean(res.meta.changes);
    if (!ok) row = (await getArticle(c.env, row.id)) ?? row;
  }
  const holder = !ok && row.locked_by && row.locked_by !== me && row.locked_at && t - row.locked_at < 75_000 ? row.locked_by : null;
  const [names, open] = await Promise.all([
    userNames(c.env, [holder, row.updated_by]),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE article_id = ? AND resolved_at IS NULL").bind(row.id).first<{ n: number }>(),
  ]);
  return json({
    ok,
    readOnly: !canEdit,
    lockedBy: holder ? { id: holder, name: names[holder] ?? "Someone" } : null,
    state: row.state,
    rev: row.draft_rev,
    updatedBy: row.updated_by,
    updatedByName: row.updated_by ? (names[row.updated_by] ?? null) : null,
    updatedAt: row.updated_at,
    openNotes: open?.n ?? 0,
  });
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
  if (!SUBMITTABLE.includes(row.state)) {
    return error(
      400,
      row.state === "published"
        ? "There are no unpublished changes to submit."
        : row.state === "approved"
          ? "This article is already approved."
          : "This article is already waiting for review.",
    );
  }
  const { note } = await body<{ note?: string }>(c.request);
  return json(await articleDetail(c, await setState(c.env, c.user!, row, "in_review", "submit", note?.trim() || null)));
});

route("POST", "/articles/:id/request-changes", "chief", async (c, m) => {
  const row = await loadEditable(c, m[1], "request_changes");
  if (row instanceof Response) return row;
  const { note, rev } = await body<{ note?: string; rev?: number }>(c.request);
  // A verdict on text the reviewer hasn't seen is refused (→ 409, reload first).
  if (rev !== row.draft_rev) throw new ConflictError(row);
  if (!note?.trim()) return error(400, "Say what needs to change.");
  return json(await articleDetail(c, await setState(c.env, c.user!, row, "changes_requested", "request_changes", note.trim())));
});

route("POST", "/articles/:id/approve", "chief", async (c, m) => {
  const row = await loadEditable(c, m[1], "approve");
  if (row instanceof Response) return row;
  const { note, rev } = await body<{ note?: string; rev?: number }>(c.request);
  if (rev !== row.draft_rev) throw new ConflictError(row);
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
  // A first publish is dated now: the draft's date is when it was started, which
  // would bury it under newer posts. A future date (scheduling) is kept.
  if (!row.git_path && !row.live_json && !(Date.parse(data.pubDate) > now())) data.pubDate = toSiteIso(now());
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
  // A live article keeps its file (frontmatter `slug:` handles renames). A first
  // publish (or a re-publish after unpublishing, whose file was deleted) gets a
  // file name no other live article owns — never another article's file.
  const gitPath = row.live_json && row.git_path ? row.git_path : await freeGitPath(c.env, data.slug, row.id);
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

  if (images.length) {
    await c.env.DB.prepare(`UPDATE media SET committed = 1 WHERE id IN (${images.map(() => "?").join(",")})`)
      .bind(...images.map((i) => i.id))
      .run();
  }
  const oldLiveSlug = row.live_json ? (row.live_slug ?? liveOf(row)?.slug ?? null) : null;
  const published = await markPublished(c.env, c.user!, row, data, hash, commit, gitPath);
  await recordDeploy(c.env, "publish", "requested", { commit: commit.sha, userId: c.user!.id, message: data.title });
  c.waitUntil(c.env.CACHE.delete(META_CACHE_KEY));
  c.waitUntil(
    (async () => {
      // A renamed article: its old URL is gone, so drop the old search entry.
      if (oldLiveSlug && oldLiveSlug !== data.slug) await removeFromIndex(c.env, oldLiveSlug);
      await indexArticle(c.env, data, hash);
    })().catch(async (e) => {
      console.error("index failed", e);
      // Let the background job retry (it finds live articles whose index is missing/stale).
      await markIndexDirty(c.env).catch(() => undefined);
    }),
  );
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
  // Uploads are only detached, not deleted: the same image may be used in
  // another draft (inserted from the media library). The uploader or the chief
  // editor can still delete them from the media library.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE media SET article_id = NULL WHERE article_id = ?").bind(row.id),
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
  const row = await getArticle(c.env, note.article_id);
  if (!row) return error(404, "Article not found.");
  // The chief editor, the note's author, or the article's writer (to mark feedback addressed).
  if (c.user!.role !== "chief" && note.user_id !== c.user!.id && !isOwnArticle(c.user!, row)) {
    return error(403, "Only the chief editor, the note's author or the article's writer can resolve it.");
  }
  await c.env.DB.prepare("UPDATE notes SET resolved_at = ? WHERE id = ?").bind(now(), Number(m[1])).run();
  return json(await articleDetail(c, row));
});

const META_CACHE_KEY = "studio:meta:v1";

route("GET", "/meta", "contributor", async (c) => {
  const cached = await c.env.CACHE.get(META_CACHE_KEY);
  if (cached) return json(JSON.parse(cached));
  const [cats, tags, authors] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT category AS v, COUNT(*) AS n FROM articles WHERE category IS NOT NULL GROUP BY category ORDER BY n DESC"),
    c.env.DB.prepare(
      "SELECT j.value AS v, COUNT(*) AS n FROM articles a, json_each(json_extract(a.draft_json, '$.tags')) j GROUP BY j.value ORDER BY n DESC LIMIT 300",
    ),
    c.env.DB.prepare("SELECT author AS v, COUNT(*) AS n FROM articles WHERE author IS NOT NULL GROUP BY author ORDER BY n DESC"),
  ]);
  const pick = (r: D1Result) => (r.results as { v: string; n: number }[]).map((x) => ({ value: x.v, count: x.n }));
  const meta = { categories: pick(cats), tags: pick(tags), authors: pick(authors) };
  await c.env.CACHE.put(META_CACHE_KEY, JSON.stringify(meta), { expirationTtl: 6 * 3600 });
  return json(meta);
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
  const media = await c.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(m[1]).first<MediaRow>();
  if (!media) return error(404, "Image not found.");
  // The uploader, the chief editor, or whoever can edit the article the image
  // belongs to may change it.
  const user = c.user!;
  let allowed = user.role === "chief" || media.uploaded_by === user.id;
  if (!allowed && media.article_id) {
    const owner = await getArticle(c.env, media.article_id);
    allowed = Boolean(owner && can(user, "edit", owner));
  }
  if (!allowed) return error(403, "You can only change your own uploads or images in articles you can edit.");
  let targetId: string | null = null;
  if (articleId !== undefined && articleId !== null) {
    // Attaching to an article: must be one you can edit.
    const target = await getArticle(c.env, String(articleId));
    if (!target) return error(404, "Article not found.");
    if (!can(user, "edit", target)) return error(403, "You can't attach images to that article.");
    targetId = target.id;
  }
  await c.env.DB.prepare("UPDATE media SET alt = COALESCE(?, alt), article_id = COALESCE(?, article_id) WHERE id = ?")
    .bind(typeof alt === "string" ? alt.slice(0, 500) : null, targetId, media.id)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(media.id).first<MediaRow>();
  return row ? json({ media: mediaJson(row) }) : error(404, "Image not found.");
});

route("DELETE", "/media/:id", "contributor", async (c, m) => {
  const row = await c.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(m[1]).first<MediaRow>();
  if (!row) return error(404, "Image not found.");
  if (row.committed) return error(400, "This image is already published on the site; remove it from the article instead.");
  if (c.user!.role !== "chief" && row.uploaded_by !== c.user!.id) return error(403, "You can only delete your own uploads.");
  await stageDelete(c.env, row.r2_key);
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

/** Bylines decide who owns imported articles, so each belongs to one person. */
async function bylineTaken(env: Env, byline: string, exceptUserId: string | null): Promise<boolean> {
  const clash = await env.DB.prepare("SELECT id FROM users WHERE author_name = ? COLLATE NOCASE AND id != ? LIMIT 1")
    .bind(byline, exceptUserId ?? "")
    .first();
  return Boolean(clash);
}

route("PATCH", "/users/:id", "chief", async (c, m) => {
  const b = await body<{ role?: Role; status?: "active" | "disabled"; name?: string; authorName?: string }>(c.request);
  const target = m[1];
  if (target === c.user!.id && ((b.role && b.role !== "chief") || b.status === "disabled")) {
    const chiefs = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'chief' AND status = 'active'").first<{ n: number }>();
    if ((chiefs?.n ?? 0) <= 1) return error(400, "You're the only chief editor — promote someone else first.");
  }
  if (b.role && !Object.hasOwn(RANK, b.role)) return error(400, "Unknown role.");
  if (b.status && b.status !== "active" && b.status !== "disabled") return error(400, "Unknown status.");
  if (b.authorName !== undefined) b.authorName = b.authorName.trim();
  if (b.authorName && (await bylineTaken(c.env, b.authorName, target))) {
    return error(409, `Another team member already uses the byline "${b.authorName}".`);
  }
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
  const role = b.role && Object.hasOwn(RANK, b.role) ? b.role : "contributor";
  const existing = await findUserByEmail(c.env, email);
  if (existing && existing.status === "active") return error(400, "That person is already on the team.");
  const byline = b.authorName?.trim() || null;
  if (byline && (await bylineTaken(c.env, byline, existing?.id ?? null))) {
    return error(409, `Another team member already uses the byline "${byline}".`);
  }
  const { token } = await createInvite(c.env, c.user!, email, role, byline);
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

route("GET", "/comments", "editor", async (c) => {
  const p = c.url.searchParams;
  const status = p.get("status");
  const where = status ? "WHERE m.status = ?" : "WHERE m.status != 'deleted'";
  const args = status ? [status] : [];
  const page = Math.max(Number(p.get("page")) || 1, 1);
  const [rows, counts] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT m.id, m.slug, m.parent_id, m.body, m.status, m.created_at, m.edited_at, m.commenter_id,
         c.name, c.email, c.avatar, c.status AS commenter_status, a.title AS article_title
       FROM comments m JOIN commenters c ON c.id = m.commenter_id LEFT JOIN articles a ON a.live_slug = m.slug
       ${where} ORDER BY m.created_at DESC LIMIT 50 OFFSET ?`,
    ).bind(...args, (page - 1) * 50),
    c.env.DB.prepare("SELECT 'pending' AS status, COUNT(*) AS n FROM comments WHERE status = 'pending'"),
  ]);
  return json({
    comments: rows.results,
    counts: Object.fromEntries((counts.results as { status: string; n: number }[]).map((r) => [r.status, r.n])),
    page,
  });
});

route("PATCH", "/comments/:id", "editor", async (c, m) => {
  const { status } = await body<{ status?: string }>(c.request);
  if (!status || !["visible", "hidden", "deleted"].includes(status)) return error(400, "Unknown status.");
  await c.env.DB.prepare("UPDATE comments SET status = ?, moderated_by = ?, moderated_at = ? WHERE id = ?")
    .bind(status, c.user!.id, now(), m[1])
    .run();
  await audit(c.env.DB, c.user!.id, "comment.moderate", m[1], { status });
  return json({ ok: true });
});

route("PATCH", "/commenters/:id", "chief", async (c, m) => {
  const { status } = await body<{ status?: string }>(c.request);
  if (status !== "banned" && status !== "active") return error(400, "Unknown status.");
  await c.env.DB.prepare("UPDATE commenters SET status = ? WHERE id = ?").bind(status, m[1]).run();
  if (status === "banned") {
    // Hide everything they've posted and sign them out.
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE comments SET status = 'hidden', moderated_by = ?, moderated_at = ? WHERE commenter_id = ? AND status IN ('visible', 'pending')").bind(c.user!.id, now(), m[1]),
      c.env.DB.prepare("DELETE FROM reader_sessions WHERE commenter_id = ?").bind(m[1]),
    ]);
  }
  await audit(c.env.DB, c.user!.id, `commenter.${status === "banned" ? "ban" : "unban"}`, m[1]);
  return json({ ok: true });
});

route("GET", "/index", "editor", async (c) => {
  const [docs, flag] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(chunk_count), 0) AS chunks, MAX(indexed_at) AS last FROM search_docs"),
    c.env.DB.prepare("SELECT value FROM settings WHERE key = 'index_dirty'"),
  ]);
  const d = docs.results[0] as { n: number; chunks: number; last: number | null };
  const dirty = (flag.results[0] as { value: string } | undefined)?.value === "1";
  return json({ indexed: d.n, chunks: d.chunks, lastIndexedAt: d.last, pending: dirty ? 1 : 0 });
});

route("POST", "/index/run", "chief", async (c) => {
  // FTS5 writes cost ~3k D1 rows read per article, and the 5M/day allowance is
  // shared account-wide. Past half of it, indexing needs an explicit override.
  const { override } = await body<{ override?: boolean }>(c.request);
  if (override !== true) {
    const d1 = (await getGuards(c.env)).usage?.metrics?.d1Read;
    if (d1 && d1.limit && d1.used / d1.limit > 0.5) {
      return error(
        429,
        `Today's D1 reads are at ${Math.round((d1.used / d1.limit) * 100)}% of the free daily allowance, so indexing is paused until the 00:00 UTC reset (8 AM PH). Override only if it can't wait.`,
        { code: "d1_budget", used: d1.used, limit: d1.limit },
      );
    }
  }
  const vectors = c.url.searchParams.get("vectors") === "0" ? false : undefined;
  return json(await reindexPending(c.env, vectors === false ? 12 : 6, { force: true, vectors }));
});

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
    try {
      const user = await getSessionUser(env, request);
      if (r.min !== "public") {
        if (!user) return error(401, "Please sign in.");
        if (RANK[user.role] < RANK[r.min]) return error(403, "You don't have permission to do that.");
      }
      const c: Ctx = { env, request, url, user, waitUntil: (p) => ctx.waitUntil(p) };
      return await r.fn(c, m);
    } catch (e) {
      if (e instanceof SlugTakenError) return error(409, e.message, { code: "slug_taken", slug: e.slug });
      if (e instanceof URIError) return error(400, "Malformed address or header.");
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
