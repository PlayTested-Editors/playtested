/** Small helpers shared by the Worker entry, API routes and studio. */

export const now = () => Date.now();

/** UTC day key, matching how Cloudflare resets the free daily request quota. */
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function error(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, { status });
}

export function uid(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function audit(
  db: D1Database,
  userId: string | null,
  action: string,
  target?: string | null,
  meta?: unknown,
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (user_id, action, target, meta, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, action, target ?? null, meta === undefined ? null : JSON.stringify(meta), now())
    .run();
}
