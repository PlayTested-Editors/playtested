/// <reference lib="webworker" />
/**
 * Image encoder (runs off the main thread). Resizes to MAX_EDGE on the long
 * side and encodes AVIF — the format every existing image on the site uses —
 * falling back to WebP if AVIF encoding fails.
 */
import encodeAvif from "@jsquash/avif/encode";

export interface EncodeRequest {
  id: number;
  file: Blob;
  maxEdge: number;
  format: "avif" | "webp";
}

export type EncodeResponse =
  | { id: number; ok: true; blob: Blob; width: number; height: number; mime: string }
  | { id: number; ok: false; error: string };

self.onmessage = async (e: MessageEvent<EncodeRequest>) => {
  const { id, file, maxEdge, format } = e.data;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    let blob: Blob | null = null;
    let mime = "image/avif";
    if (format === "avif") {
      try {
        const data = ctx.getImageData(0, 0, width, height);
        const out = await encodeAvif(data, { quality: 58, speed: 7 });
        blob = new Blob([out], { type: "image/avif" });
      } catch {
        blob = null;
      }
    }
    if (!blob) {
      blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
      mime = blob.type || "image/webp";
      if (mime !== "image/webp") {
        blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
        mime = "image/jpeg";
      }
    }
    (self as unknown as Worker).postMessage({ id, ok: true, blob, width, height, mime } satisfies EncodeResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error).message || "Could not read this image." } satisfies EncodeResponse);
  }
};
