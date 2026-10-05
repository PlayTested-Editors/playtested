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
import { now } from "./util";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

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
  };
}

export async function storeUpload(
  env: Env,
  body: ArrayBuffer,
  meta: { mime: string; filename: string; width?: number; height?: number; alt?: string; articleId?: string; userId: string },
): Promise<MediaRow> {
  const ext = EXT[meta.mime];
  if (!ext) throw new Error(`Unsupported image type: ${meta.mime}`);
  if (body.byteLength > MAX_UPLOAD_BYTES) throw new Error("Image is larger than 15 MB.");

  const id = crypto.randomUUID();
  const base = slugify(meta.filename.replace(/\.[a-z0-9]+$/i, "")).slice(0, 60) || "image";
  const publicPath = `/images/uploads/${base}-${id.slice(0, 6)}.${ext}`;
  const r2Key = `uploads${publicPath.slice("/images/uploads".length)}`;

  await env.MEDIA.put(r2Key, body, { httpMetadata: { contentType: meta.mime } });
  await env.DB.prepare(
    `INSERT INTO media (id, r2_key, public_path, filename, mime, bytes, width, height, alt, article_id, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      r2Key,
      publicPath,
      meta.filename.slice(0, 200),
      meta.mime,
      body.byteLength,
      meta.width ?? null,
      meta.height ?? null,
      meta.alt ?? null,
      meta.articleId ?? null,
      meta.userId,
      now(),
    )
    .run();
  return (await env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(id).first<MediaRow>())!;
}

/** Serve an uploaded image that isn't part of a deployed build yet. */
export async function serveStagedImage(env: Env, pathname: string): Promise<Response | null> {
  const row = await env.DB.prepare("SELECT r2_key, mime FROM media WHERE public_path = ?")
    .bind(decodeURIComponent(pathname))
    .first<{ r2_key: string; mime: string }>();
  if (!row) return null;
  const obj = await env.MEDIA.get(row.r2_key);
  if (!obj) return null;
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.mime,
      // Once the build lands the static copy takes over; don't let browsers pin this one.
      "Cache-Control": "no-store",
      ETag: obj.httpEtag,
    },
  });
}

/** Upload one staged image to GitHub as a blob (done just before publishing). */
export async function ensureBlob(env: Env, m: MediaRow): Promise<string> {
  if (m.blob_sha) return m.blob_sha;
  const obj = await env.MEDIA.get(m.r2_key);
  if (!obj) throw new Error(`Uploaded file ${m.filename} is missing from storage.`);
  const base64 = Buffer.from(await obj.arrayBuffer()).toString("base64");
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
