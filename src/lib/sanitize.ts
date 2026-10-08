/**
 * Strip active content from article HTML/markdown.
 *
 * Articles may contain raw HTML (layout divs, styled spans, images), and the
 * site shares its origin with the studio — so a script in an article would run
 * with an editor's session when they preview or read it. Applied on publish and
 * when rendering previews / the live fallback, and before the visual editor
 * previews raw HTML.
 *
 * The input is markdown with HTML mixed in, so this can't parse it as an HTML
 * document (that would escape the markdown). Instead every tag is rebuilt from
 * an allowlist of elements and attributes, URLs are checked after decoding
 * entities, and the pass repeats until nothing changes (so split tags like
 * `<scr<script>ipt>` can't reassemble). Existing articles only use div / img /
 * span / br with class, style, src and alt.
 */

const EMBED_HOSTS = /^https:\/\/(www\.)?(youtube\.com|youtube-nocookie\.com|player\.vimeo\.com|open\.spotify\.com|store\.steampowered\.com)\//i;

const ALLOWED_TAGS = new Set(
  (
    "a abbr b blockquote br caption center cite code col colgroup dd del details div dl dt em figcaption figure " +
    "h1 h2 h3 h4 h5 h6 hr i iframe img ins kbd li mark ol p picture pre q s small source span strong sub summary sup " +
    "table tbody td tfoot th thead tr u ul video audio track"
  ).split(" "),
);
const GLOBAL_ATTRS = new Set(["class", "style", "id", "title", "align", "dir", "lang", "role"]);
const TAG_ATTRS: Record<string, string[]> = {
  a: ["href", "target", "rel", "name"],
  img: ["src", "alt", "width", "height", "loading", "decoding", "srcset", "sizes"],
  iframe: ["src", "width", "height", "allow", "allowfullscreen", "frameborder", "loading", "referrerpolicy"],
  video: ["src", "controls", "poster", "autoplay", "muted", "loop", "playsinline", "preload", "width", "height"],
  audio: ["src", "controls", "autoplay", "muted", "loop", "preload"],
  source: ["src", "srcset", "type", "media", "sizes"],
  track: ["src", "kind", "srclang", "label", "default"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  col: ["span"],
  colgroup: ["span"],
  ol: ["start", "type", "reversed"],
  li: ["value"],
  details: ["open"],
};
const URL_ATTRS = new Set(["href", "src", "poster"]);
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

// Elements removed together with everything inside them.
const DROP_WITH_CONTENT = /<(script|style|noscript|template|textarea|title|xmp|plaintext|noembed|noframes|object|embed|applet|svg|math|form|select)\b[\s\S]*?<\/\1\s*>/gi;
// A tag, honouring quoted attribute values (so `alt="a>b"` doesn't end it early).
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

function decodeEntities(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16) || 0))
    .replace(/&#(\d+);?/g, (_m, d) => String.fromCodePoint(Number(d) || 0))
    .replace(/&colon;?/gi, ":")
    .replace(/&(tab|newline);?/gi, "")
    .replace(/&amp;?/gi, "&");
}

/** True for relative URLs and http(s)/mailto/tel; data: images only where allowed. */
export function safeUrl(raw: string, allowDataImage = false): boolean {
  const v = decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]+/g, "");
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!m) return !/^[^\/?#]*&/.test(v) && !v.startsWith("\\");
  const scheme = m[1].toLowerCase();
  if (SAFE_SCHEMES.has(scheme)) return true;
  return allowDataImage && scheme === "data" && /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(v);
}

const escAttr = (v: string) => v.replace(/&(?![a-z0-9#]+;)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cleanStyle(v: string): string {
  // Modern browsers can't run script from CSS, but block the old vectors anyway.
  return /expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding|@import/i.test(decodeEntities(v)) ? "" : v;
}

function rebuildTag(closing: string, name: string, attrText: string): string {
  const tag = name.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return "";
  if (closing) return `</${tag}>`;
  const allowed = TAG_ATTRS[tag] ?? [];
  const out: string[] = [];
  for (const m of attrText.matchAll(ATTR)) {
    const attr = m[1].toLowerCase();
    if (!(GLOBAL_ATTRS.has(attr) || allowed.includes(attr) || /^(aria|data)-[a-z0-9-]+$/.test(attr))) continue;
    let value = m[2] === undefined ? null : m[2].replace(/^["']|["']$/g, "");
    if (value !== null) {
      if (URL_ATTRS.has(attr) && !safeUrl(value, tag === "img" || tag === "source")) value = "#";
      if (attr === "srcset" && value.split(",").some((part) => !safeUrl(part.trim().split(/\s+/)[0] ?? ""))) continue;
      if (attr === "style") value = cleanStyle(value);
      if (tag === "iframe" && attr === "src" && !EMBED_HOSTS.test(decodeEntities(value))) return "";
    }
    out.push(value === null ? attr : `${attr}="${escAttr(value)}"`);
  }
  if (tag === "iframe" && !out.some((a) => a.startsWith("src="))) return "";
  const selfClose = /\/\s*$/.test(attrText) ? " /" : "";
  return `<${tag}${out.length ? " " + out.join(" ") : ""}${selfClose}>`;
}

function pass(input: string): string {
  let s = input.replace(DROP_WITH_CONTENT, "");
  // Iframes only from known embed hosts: drop disallowed ones with their content.
  s = s.replace(/<iframe\b((?:"[^"]*"|'[^']*'|[^'">])*)>[\s\S]*?<\/iframe\s*>/gi, (m, attrs: string) => {
    const src = /(?:^|[\s"'\/])src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
    return EMBED_HOSTS.test(decodeEntities(src)) ? m : "";
  });
  s = s.replace(TAG, (m, closing: string, name: string, attrs: string) => {
    // Markdown autolinks: <https://…> and <someone@example.com>
    if (!closing && attrs.startsWith("@")) return /^[^\s<>"']+$/.test(attrs) ? m : "";
    if (!closing && attrs.startsWith(":")) return /^[^\s<>"']+$/.test(attrs) && safeUrl(name + attrs) ? m : "";
    return rebuildTag(closing, name, attrs);
  });
  // Markdown links/images and reference definitions with unsafe URLs: [text](javascript:…)
  s = s.replace(/\]\(\s*<?([^)\s>]*)/g, (m, url: string) => (url && !safeUrl(url, true) ? "](#" : m));
  s = s.replace(/^(\s{0,3}\[[^\]\n]+\]:\s*<?)(\S+?)(>?(?:\s|$))/gm, (m, a: string, url: string, b: string) => (safeUrl(url, true) ? m : `${a}#${b}`));
  return s;
}

export function sanitizeHtml(input: string): { html: string; removed: number } {
  let s = input;
  let passes = 0;
  for (; passes < 8; passes++) {
    const next = pass(s);
    if (next === s) break;
    s = next;
  }
  return { html: s, removed: passes };
}
