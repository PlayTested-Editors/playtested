/**
 * Strip active content from article HTML/markdown.
 *
 * Articles may contain raw HTML (layout divs, styled spans, images), and the
 * site shares its origin with the studio — so a <script> in an article would
 * run with an editor's session when they preview or read it. Applied on
 * publish and when rendering previews / the live fallback. Existing articles
 * contain none of what's removed here.
 */

const EMBED_HOSTS = /^https:\/\/(www\.)?(youtube\.com|youtube-nocookie\.com|player\.vimeo\.com|open\.spotify\.com|store\.steampowered\.com)\//i;

export function sanitizeHtml(input: string): { html: string; removed: number } {
  let removed = 0;
  const count = (re: RegExp, s: string, rep: string | ((m: string, ...a: string[]) => string)) =>
    s.replace(re, (...args) => {
      const out = typeof rep === "string" ? rep : rep(...(args as [string, ...string[]]));
      if (out !== args[0]) removed++;
      return out;
    });

  let s = input;
  // Script/style-like containers and their contents.
  s = count(/<(script|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, s, "");
  s = count(/<(script|base|meta|link|object|embed|applet|form)\b[^>]*>/gi, s, "");
  s = count(/<\/(object|embed|applet|form)\s*>/gi, s, "");
  // Inline event handlers: onclick=, onerror=, …
  s = count(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, s, "");
  // javascript:/vbscript:/data:text URLs in links and sources.
  s = count(
    /\s(href|src|action|formaction|xlink:href)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi,
    s,
    (_m, attr) => ` ${attr}="#"`,
  );
  // Same for markdown links/images: [text](javascript:…)
  s = count(/\]\(\s*(javascript|vbscript|data:text\/html):(?:[^()]|\([^()]*\))*\)/gi, s, "](#)");
  // Iframes only from known embed hosts.
  s = count(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>|<iframe\b[^>]*\/?>/gi, s, (m) => {
    const src = /\ssrc\s*=\s*("|')([^"']+)\1/i.exec(m)?.[2] ?? "";
    return EMBED_HOSTS.test(src) ? m : "";
  });
  return { html: s, removed };
}
