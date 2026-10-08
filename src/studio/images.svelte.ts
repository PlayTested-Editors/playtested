/**
 * Upload queue: compress in workers (2 at a time), upload (3 at a time), with
 * per-file progress the UI can render.
 */
import { api, type Media } from "./api";
import type { EncodeRequest, EncodeResponse } from "./encoder.worker";

export interface UploadItem {
  key: number;
  name: string;
  previewUrl: string;
  status: "queued" | "compressing" | "uploading" | "done" | "error";
  originalBytes: number;
  finalBytes?: number;
  error?: string;
  media?: Media;
}

export const uploads = $state<UploadItem[]>([]);

const MAX_EDGE = 1920;
const ACCEPT = /^image\/(avif|webp|jpeg|png|gif|heic|heif)$/i;
// A single encode that takes longer than this is treated as stuck.
const ENCODE_TIMEOUT_MS = 120_000;

/** Can this file go through the upload queue? (Others are skipped, not failed.) */
export function isAcceptedImage(f: File): boolean {
  return ACCEPT.test(f.type) || /\.(avif|webp|jpe?g|png|gif)$/i.test(f.name);
}

let workers: Worker[] = [];
let nextId = 0;
const pending = new Map<number, { resolve: (r: EncodeResponse) => void; worker: Worker; timer: ReturnType<typeof setTimeout> }>();

/** Fail every job on a broken/stuck worker and retire it (the pool respawns on demand). */
function retire(w: Worker, error: string) {
  for (const [id, p] of pending) {
    if (p.worker !== w) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve({ id, ok: false, error });
  }
  w.terminate();
  workers = workers.filter((x) => x !== w);
}

function pool(): Worker[] {
  if (!workers.length) {
    const n = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
    workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL("./encoder.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<EncodeResponse>) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(e.data.id);
        p.resolve(e.data);
      };
      // The worker failed to load (e.g. its wasm chunk) or crashed: without
      // this its jobs would sit at "Compressing" forever.
      w.onerror = (e) => {
        e.preventDefault();
        retire(w, "The image compressor stopped working. Reload the page and try again.");
      };
      w.onmessageerror = () => retire(w, "The image compressor sent back something unreadable.");
      return w;
    });
  }
  return workers;
}

let rr = 0;
function encode(file: File): Promise<EncodeResponse> {
  const id = ++nextId;
  // GIFs keep their animation, so they skip re-encoding.
  if (file.type === "image/gif") return Promise.resolve({ id, ok: true, blob: file, width: 0, height: 0, mime: "image/gif" });
  let ws: Worker[];
  try {
    ws = pool();
  } catch {
    return Promise.resolve({ id, ok: false, error: "This browser couldn't start the image compressor." });
  }
  const w = ws[rr++ % ws.length];
  return new Promise((resolve) => {
    const timer = setTimeout(() => retire(w, "Compressing took too long. Try a smaller image."), ENCODE_TIMEOUT_MS);
    pending.set(id, { resolve, worker: w, timer });
    w.postMessage({ id, file, maxEdge: MAX_EDGE, format: "avif" } satisfies EncodeRequest);
  });
}

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift()!);
    }),
  );
}

let keySeq = 0;

/**
 * Compress and upload files. Resolves with the successfully uploaded media,
 * in the same order the files were given.
 */
export async function uploadFiles(files: File[] | FileList, articleId?: string): Promise<Media[]> {
  const list = [...files].filter(isAcceptedImage);
  const items = list.map((file) => {
    const item: UploadItem = {
      key: ++keySeq,
      name: file.name,
      previewUrl: URL.createObjectURL(file),
      status: "queued",
      originalBytes: file.size,
    };
    uploads.unshift(item);
    return { file, item: uploads[0] };
  });

  // Encoding is CPU-bound (2 workers); uploads overlap with encoding (3 at a time).
  const encoded = new Map<number, EncodeResponse>();
  const uploadQueue: { file: File; item: UploadItem }[] = [];
  let encodingDone = false;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());

  let encoders = 1;
  try {
    encoders = pool().length;
  } catch {
    /* encode() reports the failure per file */
  }
  const encoding = runLimited(items, Math.max(1, encoders), async ({ file, item }) => {
    item.status = "compressing";
    const r = await encode(file);
    encoded.set(item.key, r);
    if (!r.ok) {
      item.status = "error";
      item.error = r.error;
    } else {
      item.status = "uploading";
      uploadQueue.push({ file, item });
      wake();
    }
  }).then(() => {
    encodingDone = true;
    wake();
  });

  const uploader = async () => {
    for (;;) {
      const next = uploadQueue.shift();
      if (!next) {
        if (encodingDone) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
        continue;
      }
      const r = encoded.get(next.item.key) as Extract<EncodeResponse, { ok: true }>;
      const ext = r.mime.split("/")[1].replace("jpeg", "jpg");
      const name = next.file.name.replace(/\.[a-z0-9]+$/i, "") + "." + ext;
      try {
        const res = await api.upload<{ media: Media }>("/media", r.blob, {
          "Content-Type": r.mime,
          "X-Filename": encodeURIComponent(name),
          ...(r.width ? { "X-Width": String(r.width), "X-Height": String(r.height) } : {}),
          ...(articleId ? { "X-Article-Id": articleId } : {}),
        });
        next.item.media = res.media;
        next.item.finalBytes = r.blob.size;
        next.item.status = "done";
      } catch (e) {
        next.item.status = "error";
        next.item.error = (e as Error).message;
      }
    }
  };
  await Promise.all([encoding, uploader(), uploader(), uploader()]);

  // Clear finished items after a moment so the tray doesn't grow forever.
  setTimeout(() => {
    for (const { item } of items) {
      if (item.status === "done") {
        URL.revokeObjectURL(item.previewUrl);
        const i = uploads.findIndex((u) => u.key === item.key);
        if (i > -1) uploads.splice(i, 1);
      }
    }
  }, 6000);

  return items.map(({ item }) => item.media).filter(Boolean) as Media[];
}

/** Remove every finished or failed item from the tray. */
export function clearFinishedUploads() {
  for (let i = uploads.length - 1; i >= 0; i--) {
    if (uploads[i].status === "done" || uploads[i].status === "error") {
      URL.revokeObjectURL(uploads[i].previewUrl);
      uploads.splice(i, 1);
    }
  }
}

export function dismissUpload(key: number) {
  const i = uploads.findIndex((u) => u.key === key);
  if (i > -1) {
    URL.revokeObjectURL(uploads[i].previewUrl);
    uploads.splice(i, 1);
  }
}
