/**
 * The image gallery shown on an article: the images picked for the gallery,
 * followed by any image used in the article body that isn't already in it.
 *
 * Writers used to pick every screenshot twice (once for the body, once for the
 * gallery). Most existing galleries already contain their body images under
 * the exact same URL, so matching on the normalised URL adds only the missing
 * ones and never shows the same picture twice.
 */

/** Image URLs used in a markdown body: `![alt](src)` and `<img src>`, in order. */
export function bodyImages(markdown: string | undefined): string[] {
  if (!markdown) return [];
  const found: { at: number; src: string }[] = [];
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) found.push({ at: m.index ?? 0, src: m[1] });
  for (const m of markdown.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) found.push({ at: m.index ?? 0, src: m[1] });
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.src)
    .filter((src) => !/^data:/i.test(src) && !/\.svg(\?|#|$)/i.test(src));
}

/** Same picture, regardless of query string, encoding, case or host. */
export function imageKey(src: string): string {
  let s = src.trim().split(/[?#]/)[0];
  try {
    s = decodeURI(s);
  } catch {}
  return s.replace(/^https?:\/\/[^/]+/i, "").toLowerCase();
}

/** Picked gallery images first (in their order), then new images from the body. */
export function mergeGallery(gallery: string[] | undefined, body: string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of [...(gallery ?? []), ...bodyImages(body)]) {
    if (!src) continue;
    const key = imageKey(src);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
  }
  return out;
}

/** Body images the gallery will add on top of the picked ones (for the studio). */
export function autoGalleryImages(gallery: string[] | undefined, body: string | undefined): string[] {
  const picked = new Set((gallery ?? []).map(imageKey));
  return mergeGallery([], body).filter((src) => !picked.has(imageKey(src)));
}
