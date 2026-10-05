/**
 * Studio authentication.
 *
 * - Google sign-in (OIDC code flow + PKCE) for invited editors.
 * - Owner key: bootstraps the chief editor before Google is configured.
 * - One-time sign-in links the chief editor can hand out.
 * Sessions are random tokens in an HttpOnly cookie; only their hash is stored.
 */
import type { Env } from "./env";
import { audit, b64url, now, safeEqual, sha256Hex, uid } from "./util";

export type Role = "chief" | "editor" | "contributor";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
  role: Role;
  authorName: string | null;
}

export const SESSION_COOKIE = "pt_session";
const SESSION_DAYS = 30;

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSec: number, path = "/"): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function getCookie(request: Request, name: string): string | null {
  return readCookie(request, name);
}

const userCache = new WeakMap<Request, SessionUser | null>();

export async function getSessionUser(env: Env, request: Request): Promise<SessionUser | null> {
  if (userCache.has(request)) return userCache.get(request)!;
  const token = readCookie(request, SESSION_COOKIE);
  let user: SessionUser | null = null;
  if (token) {
    const row = await env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.avatar, u.role, u.author_name, u.status, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    )
      .bind(await sha256Hex(token))
      .first<{ id: string; email: string; name: string; avatar: string | null; role: Role; author_name: string | null; status: string; expires_at: number }>();
    if (row && row.status === "active" && row.expires_at > now()) {
      user = { id: row.id, email: row.email, name: row.name, avatar: row.avatar, role: row.role, authorName: row.author_name };
    }
  }
  userCache.set(request, user);
  return user;
}

/** Create a session and return the Set-Cookie header value. */
export async function startSession(env: Env, userId: string, request: Request): Promise<string> {
  const token = uid(32);
  const t = now();
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, t, t + SESSION_DAYS * 86_400_000, (request.headers.get("user-agent") || "").slice(0, 200))
    .run();
  await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(t, userId).run();
  // Opportunistic cleanup of expired sessions.
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t).run();
  return cookie(SESSION_COOKIE, token, SESSION_DAYS * 86_400);
}

export async function endSession(env: Env, request: Request): Promise<string> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
  return cookie(SESSION_COOKIE, "", 0);
}

export async function userCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function findUserByEmail(env: Env, email: string) {
  return env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email.trim().toLowerCase()).first<{
    id: string;
    status: string;
    role: Role;
  }>();
}

export async function createUser(
  env: Env,
  u: { email: string; name: string; role: Role; avatar?: string | null; authorName?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, avatar, author_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
  )
    .bind(id, u.email.trim().toLowerCase(), u.name || u.email, u.avatar ?? null, u.authorName ?? null, u.role, now())
    .run();
  return id;
}

/**
 * Owner key sign-in. The first use creates the chief editor account; later
 * uses sign in as the existing chief editor with that email.
 */
export async function ownerSignIn(
  env: Env,
  key: string,
  email: string,
  name: string,
): Promise<{ userId: string } | { error: string }> {
  if (!env.STUDIO_OWNER_KEY) return { error: "Owner key sign-in is not configured." };
  if (!safeEqual(key, env.STUDIO_OWNER_KEY)) return { error: "That owner key is not right." };
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return { error: "Enter the email address you'll use for Google sign-in." };
  const existing = await findUserByEmail(env, normalized);
  if (existing) {
    if (existing.role !== "chief") {
      await env.DB.prepare("UPDATE users SET role = 'chief', status = 'active' WHERE id = ?").bind(existing.id).run();
    }
    return { userId: existing.id };
  }
  const userId = await createUser(env, { email: normalized, name: name || normalized, role: "chief", authorName: name || null });
  await audit(env.DB, userId, "user.bootstrap_chief", userId);
  return { userId };
}

// ---------------------------------------------------------------------------
// Invites and one-time links

export async function createInvite(
  env: Env,
  by: SessionUser,
  email: string,
  role: Role,
  authorName: string | null,
): Promise<{ token: string; id: string }> {
  const token = uid(24);
  const id = crypto.randomUUID();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO invites (id, email, role, author_name, token_hash, invited_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, email.trim().toLowerCase(), role, authorName, await sha256Hex(token), by.id, t, t + 14 * 86_400_000)
    .run();
  await audit(env.DB, by.id, "invite.create", id, { email, role });
  return { token, id };
}

export async function lookupInvite(env: Env, token: string) {
  return env.DB.prepare("SELECT * FROM invites WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?")
    .bind(await sha256Hex(token), now())
    .first<{ id: string; email: string; role: Role; author_name: string | null; invited_by: string }>();
}

/**
 * Accept an invite. When `googleEmail` is given it must match the invited
 * address; without it (Google not configured) the one-time link itself is
 * the proof of identity.
 */
export async function acceptInvite(
  env: Env,
  token: string,
  identity: { email?: string; name?: string; avatar?: string | null },
): Promise<{ userId: string } | { error: string }> {
  const invite = await lookupInvite(env, token);
  if (!invite) return { error: "This invite link has expired or was already used." };
  if (identity.email && identity.email.toLowerCase() !== invite.email.toLowerCase()) {
    return { error: `This invite is for ${invite.email}. Sign in with that Google account.` };
  }
  let userId: string;
  const existing = await findUserByEmail(env, invite.email);
  if (existing) {
    userId = existing.id;
    await env.DB.prepare("UPDATE users SET role = ?, status = 'active' WHERE id = ?").bind(invite.role, userId).run();
  } else {
    userId = await createUser(env, {
      email: invite.email,
      name: identity.name || invite.author_name || invite.email.split("@")[0],
      role: invite.role,
      avatar: identity.avatar ?? null,
      authorName: invite.author_name,
    });
  }
  await env.DB.prepare("UPDATE invites SET accepted_at = ?, accepted_user_id = ? WHERE id = ?").bind(now(), userId, invite.id).run();
  await audit(env.DB, userId, "invite.accept", invite.id);
  return { userId };
}

export async function createLoginLink(env: Env, by: SessionUser, userId: string): Promise<string> {
  const token = uid(24);
  const t = now();
  await env.DB.prepare("INSERT INTO login_links (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, by.id, t, t + 24 * 3_600_000)
    .run();
  await audit(env.DB, by.id, "user.login_link", userId);
  return token;
}

export async function consumeLoginLink(env: Env, token: string): Promise<string | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT user_id FROM login_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(hash, now())
    .first<{ user_id: string }>();
  if (!row) return null;
  await env.DB.prepare("UPDATE login_links SET used_at = ? WHERE token_hash = ?").bind(now(), hash).run();
  return row.user_id;
}

// ---------------------------------------------------------------------------
// Google OIDC

export function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** Where a Google sign-in returns to: the studio, or reader comments. */
export interface GoogleFlow {
  callbackPath: string;
  cookiePath: string;
}
export const STUDIO_GOOGLE: GoogleFlow = { callbackPath: "/api/studio/auth/google/callback", cookiePath: "/api/studio/auth/" };

export async function googleStart(
  env: Env,
  origin: string,
  inviteToken: string | null,
  flow: GoogleFlow = STUDIO_GOOGLE,
  extra: Record<string, string> = {},
) {
  const state = uid(16);
  const verifier = uid(32);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${origin}${flow.callbackPath}`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  const payload = JSON.stringify({ state, verifier, invite: inviteToken, extra });
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    cookie: cookie("pt_oauth", payload, 600, flow.cookiePath),
  };
}

export async function googleFinish(
  env: Env,
  request: Request,
  origin: string,
  flow: GoogleFlow = STUDIO_GOOGLE,
): Promise<
  | { sub: string; email: string; name: string; picture: string | null; invite: string | null; extra: Record<string, string> }
  | { error: string }
> {
  const url = new URL(request.url);
  const raw = readCookie(request, "pt_oauth");
  if (!raw) return { error: "Sign-in session expired. Please try again." };
  let saved: { state: string; verifier: string; invite: string | null; extra?: Record<string, string> };
  try {
    saved = JSON.parse(raw);
  } catch {
    return { error: "Sign-in session was corrupted. Please try again." };
  }
  if (!url.searchParams.get("state") || url.searchParams.get("state") !== saved.state) {
    return { error: "Sign-in state did not match. Please try again." };
  }
  const code = url.searchParams.get("code");
  if (!code) return { error: url.searchParams.get("error") || "Google did not return a sign-in code." };

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${origin}${flow.callbackPath}`,
      grant_type: "authorization_code",
      code_verifier: saved.verifier,
    }),
  });
  const token = (await res.json().catch(() => ({}))) as { id_token?: string; error_description?: string };
  if (!res.ok || !token.id_token) return { error: token.error_description || "Google sign-in failed." };

  // The ID token came straight from Google's token endpoint over TLS, so the
  // claims can be read without re-verifying the signature (OIDC Core 3.1.3.7).
  const claims = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(token.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    ),
  ) as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string; aud?: string };
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return { error: "Google sign-in was issued for a different app." };
  if (!claims.email || !claims.email_verified) return { error: "Your Google account email isn't verified." };
  return {
    sub: claims.sub || claims.email,
    email: claims.email.toLowerCase(),
    name: claims.name || claims.email,
    picture: claims.picture ?? null,
    invite: saved.invite,
    extra: saved.extra ?? {},
  };
}
