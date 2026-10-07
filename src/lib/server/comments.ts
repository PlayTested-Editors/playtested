/**
 * Reader comments (/api/comments/*). Readers sign in with Google; their
 * sessions are separate from studio sessions and grant nothing in the studio.
 *
 * Free-plan friendly: the article page only loads comments when the reader
 * scrolls to them, and every call goes through the usage guards.
 */
import type { Env } from "./env";
import { clearOAuthCookie, cookie, getCookie, googleConfigured, googleFinish, googleStart, type GoogleFlow } from "./auth";
import { bump, featureOn, gate, getGuards, withinRate } from "./guards";
import { clientIp, error, json, now, sha256Hex, uid } from "./util";

const READER_COOKIE = "pt_reader";
const READER_DAYS = 90;
const READER_GOOGLE: GoogleFlow = { callbackPath: "/api/comments/auth/google/callback", cookiePath: "/api/comments/auth/" };
const MAX_LEN = 3000;
const PER_DAY = 30;
const EDIT_WINDOW_MS = 30 * 60_000;

interface Reader {
  id: string;
  name: string;
  avatar: string | null;
  status: string;
}

interface CommentRow {
  id: string;
  slug: string;
  parent_id: string | null;
  commenter_id: string;
  body: string;
  status: string;
  created_at: number;
  edited_at: number | null;
  name: string;
  avatar: string | null;
}

async function getReader(env: Env, request: Request): Promise<Reader | null> {
  const token = getCookie(request, READER_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT c.id, c.name, c.avatar, c.status FROM reader_sessions s JOIN commenters c ON c.id = s.commenter_id
     WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256Hex(token), now())
    .first<Reader>();
}

function shape(r: CommentRow, me: Reader | null) {
  const deleted = r.status === "deleted";
  return {
    id: r.id,
    parentId: r.parent_id,
    body: deleted ? "" : r.body,
    status: r.status,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    author: deleted ? { name: "[deleted]", avatar: null } : { name: r.name, avatar: r.avatar },
    mine: Boolean(me && r.commenter_id === me.id),
  };
}

function safeReturn(raw: string | null): string {
  return raw && /^\/article\/[a-z0-9-]+\/$/.test(raw) ? raw : "/";
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

async function list(request: Request, env: Env): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("slug") || "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return error(400, "Missing article.");
  const blocked = await gate(env, request, "comments");
  if (blocked) return blocked;
  const me = await getReader(env, request);
  const rows = await env.DB.prepare(
    `SELECT m.*, c.name, c.avatar FROM comments m JOIN commenters c ON c.id = m.commenter_id
     WHERE m.slug = ? AND (m.status IN ('visible', 'deleted') OR (m.status = 'pending' AND m.commenter_id = ?))
     ORDER BY m.created_at ASC LIMIT 500`,
  )
    .bind(slug, me?.id ?? "")
    .all<CommentRow>();
  // Deleted comments only stay as placeholders when someone replied to them.
  const parents = new Set(rows.results.map((r) => r.parent_id).filter(Boolean));
  const comments = rows.results.filter((r) => r.status !== "deleted" || parents.has(r.id)).map((r) => shape(r, me));
  return json({
    comments,
    me: me && me.status === "active" ? { name: me.name, avatar: me.avatar } : null,
    banned: me?.status === "banned",
    canSignIn: googleConfigured(env),
  });
}

async function post(request: Request, env: Env): Promise<Response> {
  const me = await getReader(env, request);
  if (!me) return error(401, "Sign in to comment.");
  if (me.status !== "active") return error(403, "You can't comment on PlayTested.");
  const blocked = await gate(env, request, "comments");
  if (blocked) return blocked;
  if (!(await withinRate(env, "RL_AI", `comment-post:${clientIp(request)}`))) {
    return error(429, "You're commenting a bit fast — give it a minute.", { code: "rate_limited" });
  }
  const b = (await request.json().catch(() => ({}))) as { slug?: string; body?: string; parentId?: string };
  const slug = String(b.slug || "");
  const body = String(b.body || "").replace(/\r\n/g, "\n").trim();
  if (body.length < 2) return error(400, "Write a little more first.");
  if (body.length > MAX_LEN) return error(400, `Comments can be up to ${MAX_LEN} characters.`);
  const article = await env.DB.prepare("SELECT 1 FROM articles WHERE slug = ? AND live_json IS NOT NULL").bind(slug).first();
  if (!article) return error(404, "Article not found.");
  if (b.parentId) {
    const parent = await env.DB.prepare("SELECT parent_id FROM comments WHERE id = ? AND slug = ?").bind(b.parentId, slug).first<{ parent_id: string | null }>();
    if (!parent) return error(400, "That comment no longer exists.");
    // One level of replies: replying to a reply attaches to its parent.
    if (parent.parent_id) b.parentId = parent.parent_id;
  }
  if ((await bump(env, `comment-user:${me.id}`)) > PER_DAY) return error(429, "You've reached today's comment limit.");

  // Link-heavy comments wait for a moderator.
  const links = (body.match(/https?:\/\//gi) ?? []).length;
  const status = links > 2 ? "pending" : "visible";
  const id = uid(12);
  await env.DB.prepare(
    "INSERT INTO comments (id, slug, parent_id, commenter_id, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, slug, b.parentId ?? null, me.id, body, status, now())
    .run();
  await env.DB.prepare("UPDATE commenters SET last_seen_at = ? WHERE id = ?").bind(now(), me.id).run();
  const row = await env.DB.prepare("SELECT m.*, c.name, c.avatar FROM comments m JOIN commenters c ON c.id = m.commenter_id WHERE m.id = ?")
    .bind(id)
    .first<CommentRow>();
  return json({ comment: shape(row!, me), held: status === "pending" }, { status: 201 });
}

async function editOrDelete(request: Request, env: Env, id: string): Promise<Response> {
  const me = await getReader(env, request);
  if (!me) return error(401, "Sign in first.");
  const row = await env.DB.prepare("SELECT * FROM comments WHERE id = ?").bind(id).first<CommentRow>();
  if (!row || row.commenter_id !== me.id) return error(404, "Comment not found.");
  if (request.method === "DELETE") {
    await env.DB.prepare("UPDATE comments SET status = 'deleted', body = '' WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  if (now() - row.created_at > EDIT_WINDOW_MS) return error(400, "Comments can only be edited for 30 minutes.");
  const b = (await request.json().catch(() => ({}))) as { body?: string };
  const body = String(b.body || "").trim();
  if (body.length < 2 || body.length > MAX_LEN) return error(400, "That comment is too short or too long.");
  await env.DB.prepare("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?").bind(body, now(), id).run();
  return json({ ok: true });
}

export async function handleComments(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.replace(/^\/api\/comments/, "").replace(/\/$/, "") || "/";
  if (request.method !== "GET" && request.headers.get("origin") !== url.origin) return error(403, "Cross-site request blocked.");

  if (sub === "/" && request.method === "GET") return list(request, env);
  if (sub === "/" && request.method === "POST") return post(request, env);

  if (sub === "/auth/google/start") {
    const back = safeReturn(url.searchParams.get("return"));
    if (!googleConfigured(env)) return redirect(`${back}#comments`);
    const g = await getGuards(env);
    if (!featureOn(g, "comments")) return redirect(`${back}#comments`);
    const { url: to, cookie: c } = await googleStart(env, url.origin, null, READER_GOOGLE, { return: back });
    return redirect(to, [c]);
  }
  if (sub === "/auth/google/callback") {
    const result = await googleFinish(env, request, url.origin, READER_GOOGLE);
    if ("error" in result) return redirect("/");
    const back = safeReturn(result.extra.return ?? null);
    const existing = await env.DB.prepare("SELECT id FROM commenters WHERE google_sub = ?").bind(result.sub).first<{ id: string }>();
    const id = existing?.id ?? crypto.randomUUID();
    if (existing) {
      await env.DB.prepare("UPDATE commenters SET email = ?, name = ?, avatar = ?, last_seen_at = ? WHERE id = ?")
        .bind(result.email, result.name, result.picture, now(), id)
        .run();
    } else {
      await env.DB.prepare("INSERT INTO commenters (id, google_sub, email, name, avatar, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, result.sub, result.email, result.name, result.picture, now(), now())
        .run();
    }
    const token = uid(32);
    await env.DB.prepare("INSERT INTO reader_sessions (id_hash, commenter_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), id, now(), now() + READER_DAYS * 86_400_000)
      .run();
    return redirect(`${back}#comments`, [
      cookie(READER_COOKIE, token, READER_DAYS * 86_400),
      clearOAuthCookie(request, READER_GOOGLE),
    ]);
  }
  if (sub === "/auth/logout" && request.method === "POST") {
    const token = getCookie(request, READER_COOKIE);
    if (token) await env.DB.prepare("DELETE FROM reader_sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
    const res = json({ ok: true });
    res.headers.append("Set-Cookie", cookie(READER_COOKIE, "", 0));
    return res;
  }
  const m = /^\/([A-Za-z0-9_-]{6,40})$/.exec(sub);
  if (m && (request.method === "PATCH" || request.method === "DELETE")) return editOrDelete(request, env, m[1]);
  return error(404, "Not found.");
}
