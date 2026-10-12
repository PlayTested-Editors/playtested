/**
 * Studio image uploads.
 *
 * Images are resized/compressed in the browser, then stored in R2 under their
 * final public path (/images/uploads/…). Until a build includes them, a request
 * for that path misses the static assets and the Worker serves the R2 copy —
 * so previews and freshly published articles show images immediately. On
 * publish the bytes are committed to git and become free static assets.
 */
import type { Env } from "./env";
import { slugify } from "./articles";
import { createBlob } from "./github";
import { now, sha256Hex } from "./util";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Staging storage: R2 when the account has it, otherwise Workers KV (free,
// no card needed; values up to 25 MB, and uploads are rare enough for the
// free plan's 1,000 writes/day).
const KV_PREFIX = "media:";

async function stagePut(env: Env, key: string, body: ArrayBuffer, mime: string): Promise<void> {
  if (env.MEDIA) await env.MEDIA.put(key, body, { httpMetadata: { contentType: mime } });
  else await env.CACHE.put(KV_PREFIX + key, body, { metadata: { mime } });
}

async function stageGet(env: Env, key: string): Promise<ArrayBuffer | null> {
  if (env.MEDIA) {
    const obj = await env.MEDIA.get(key);
    return obj ? obj.arrayBuffer() : null;
  }
  return env.CACHE.get(KV_PREFIX + key, "arrayBuffer");
}

export async function stageDelete(env: Env, key: string): Promise<void> {
  if (env.MEDIA) await env.MEDIA.delete(key);
  else await env.CACHE.delete(KV_PREFIX + key);
}

const EXT: Record<string, string> = {
  "image/avif": "avif",
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
};

export interface MediaRow {
  id: string;
  r2_key: string;
  public_path: string;
  filename: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  blob_sha: string | null;
  committed: number;
  article_id: string | null;
  uploaded_by: string | null;
  created_at: number;
  sha256: string | null;
  source_url: string | null;
}

export function mediaJson(m: MediaRow) {
  return {
    id: m.id,
    url: m.public_path,
    filename: m.filename,
    mime: m.mime,
    bytes: m.bytes,
    width: m.width,
    height: m.height,
    alt: m.alt,
    committed: Boolean(m.committed),
    articleId: m.article_id,
    createdAt: m.created_at,
    sourceUrl: m.source_url ?? null,
  };
}

export async function storeUpload(
  env: Env,
  body: ArrayBuffer,
  meta: { mime: string; filename: string; width?: number; height?: number; alt?: string; articleId?: string; userId: string; sourceUrl?: string },
): Promise<MediaRow> {
  const ext = EXT[meta.mime];
  if (!ext) throw new Error(`Unsupported image type: ${meta.mime}`);
  if (body.byteLength > MAX_UPLOAD_BYTES) throw new Error("Image is larger than 15 MB.");

  // The same image (identical bytes, or the same imported screenshot) already in
  // this article: hand back that one instead of storing a copy.
  const sha256 = await sha256Hex(body);
  if (meta.articleId) {
    const same = await env.DB.prepare("SELECT * FROM media WHERE article_id = ? AND (sha256 = ? OR (? IS NOT NULL AND source_url = ?)) LIMIT 1")
      .bind(meta.articleId, sha256, meta.sourceUrl ?? null, meta.sourceUrl ?? null)
      .first<MediaRow>();
    if (same) return same;
  }

  const id = crypto.randomUUID();
  const base = await uploadBase(env, meta);
  // Number after what the article already has; skip any name already in use.
  let n = 1;
  if (meta.articleId) {
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM media WHERE article_id = ?").bind(meta.articleId).first<{ n: number }>();
    n = (c?.n ?? 0) + 1;
  }
  // The row is inserted first: its unique public_path claims the name, so two
  // uploads in parallel can't both take it (and overwrite each other's file).
  let publicPath = "";
  for (let tries = 0; ; tries++, n++) {
    const candidate = `/images/uploads/${base}-${n}.${ext}`;
    if (tries > 40) throw new Error("Couldn't find a free file name for this image.");
    if (await existsOnSite(env, candidate)) continue;
    try {
      await env.DB.prepare(
        `INSERT INTO media (id, r2_key, public_path, filename, mime, bytes, width, height, alt, article_id, uploaded_by, created_at, sha256, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          `uploads${candidate.slice("/images/uploads".length)}`,
          candidate,
          meta.filename.slice(0, 200),
          meta.mime,
          body.byteLength,
          meta.width ?? null,
          meta.height ?? null,
          meta.alt ?? null,
          meta.articleId ?? null,
          meta.userId,
          now(),
          sha256,
          meta.sourceUrl ?? null,
        )
        .run();
      publicPath = candidate;
      break;
    } catch (e) {
      if (!/UNIQUE/i.test((e as Error).message)) throw e; // taken a moment ago: try the next number
    }
  }
  try {
    await stagePut(env, `uploads${publicPath.slice("/images/uploads".length)}`, body, meta.mime);
  } catch (e) {
    await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(id).run();
    throw e;
  }
  return (await env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(id).first<MediaRow>())!;
}

/**
 * A readable file name: the article's game ("halo-campaign-evolved"), else its
 * slug or headline, else the original file name without long digit runs.
 * Screenshots from RAWG start with "rawg-" (articles using them credit RAWG).
 */
async function uploadBase(env: Env, meta: { filename: string; articleId?: string; sourceUrl?: string }): Promise<string> {
  let base = "";
  if (meta.articleId) {
    const a = await env.DB.prepare("SELECT slug, title, json_extract(draft_json, '$.game') AS game FROM articles WHERE id = ?")
      .bind(meta.articleId)
      .first<{ slug: string; title: string; game: string | null }>();
    // Apostrophes vanish rather than becoming dashes: "Marvel's Wolverine" → "marvels-wolverine".
    const clean = (s: string) => slugify(s.replace(/['’]/g, ""));
    if (a) base = clean(a.game || "") || (/^untitled-/.test(a.slug) ? "" : a.slug) || clean((a.title || "").split("|").pop() || "");
  }
  if (!base) base = slugify(meta.filename.replace(/\.[a-z0-9]+$/i, "").replace(/\d{5,}/g, " "));
  base = base.slice(0, 50).replace(/-+$/, "") || "image";
  let rawg = false;
  try {
    rawg = Boolean(meta.sourceUrl) && new URL(meta.sourceUrl!).hostname === "media.rawg.io";
  } catch {
    /* not a URL */
  }
  return rawg ? `rawg-${base}` : base;
}

/** An image already on the site under this name (uploads committed before the studio tracked them). */
async function existsOnSite(env: Env, publicPath: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM media WHERE public_path = ?").bind(publicPath).first();
  if (row) return true;
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${publicPath}`, { method: "HEAD" }));
  return res.status === 200;
}

/** Serve an uploaded image that isn't part of a deployed build yet. */
export async function serveStagedImage(env: Env, pathname: string): Promise<Response | null> {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null; // malformed %-escape: let the normal 404 answer
  }
  // Upload paths are always /images/uploads/<slug>-<id>.<ext>: anything else
  // can't be a staged upload, so don't spend a D1 read on it.
  if (!/^\/images\/uploads\/[a-z0-9-]+\.(avif|webp|jpg|png|gif)$/.test(path)) return null;
  const row = await env.DB.prepare("SELECT r2_key, mime FROM media WHERE public_path = ?")
    .bind(path)
    .first<{ r2_key: string; mime: string }>();
  if (!row) return null;
  const bytes = await stageGet(env, row.r2_key);
  if (!bytes) return null;
  return new Response(bytes, {
    headers: {
      "Content-Type": row.mime,
      "X-Content-Type-Options": "nosniff",
      // Once the build lands the static copy takes over; don't let browsers pin this one.
      "Cache-Control": "no-store",
    },
  });
}

/** Upload one staged image to GitHub as a blob (done just before publishing). */
export async function ensureBlob(env: Env, m: MediaRow): Promise<string> {
  if (m.blob_sha) return m.blob_sha;
  const bytes = await stageGet(env, m.r2_key);
  if (!bytes) throw new Error(`Uploaded file ${m.filename} is missing from storage.`);
  const base64 = Buffer.from(bytes).toString("base64");
  const sha = await createBlob(env, base64);
  await env.DB.prepare("UPDATE media SET blob_sha = ? WHERE id = ?").bind(sha, m.id).run();
  return sha;
}

export async function mediaForPaths(env: Env, paths: string[]): Promise<MediaRow[]> {
  if (!paths.length) return [];
  const placeholders = paths.map(() => "?").join(",");
  const res = await env.DB.prepare(`SELECT * FROM media WHERE public_path IN (${placeholders})`)
    .bind(...paths)
    .all<MediaRow>();
  return res.results;
}
