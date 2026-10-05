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

let workers: Worker[] = [];
let nextId = 0;
const pending = new Map<number, (r: EncodeResponse) => void>();

function pool(): Worker[] {
  if (!workers.length) {
    const n = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
    workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL("./encoder.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<EncodeResponse>) => {
        pending.get(e.data.id)?.(e.data);
        pending.delete(e.data.id);
      };
      return w;
    });
  }
  return workers;
}

let rr = 0;
function encode(file: File): Promise<EncodeResponse> {
  const id = ++nextId;
  const ws = pool();
  const w = ws[rr++ % ws.length];
  // GIFs keep their animation, so they skip re-encoding.
  if (file.type === "image/gif") return Promise.resolve({ id, ok: true, blob: file, width: 0, height: 0, mime: "image/gif" });
  return new Promise((resolve) => {
    pending.set(id, resolve);
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
  const list = [...files].filter((f) => ACCEPT.test(f.type) || /\.(avif|webp|jpe?g|png|gif)$/i.test(f.name));
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

  const encoding = runLimited(items, Math.max(1, pool().length), async ({ file, item }) => {
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

export function dismissUpload(key: number) {
  const i = uploads.findIndex((u) => u.key === key);
  if (i > -1) {
    URL.revokeObjectURL(uploads[i].previewUrl);
    uploads.splice(i, 1);
  }
}
