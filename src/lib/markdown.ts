/**
 * Runtime markdown renderer for pages rendered in the Worker (live fallback,
 * studio preview). Built pages still use Astro's own markdown pipeline; this
 * mirrors its output closely enough (GFM, raw HTML, heading ids, smart quotes).
 */
import { Marked } from "marked";

function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function smartypants(text: string): string {
  return text
    .replace(/(^|[-—\s(\["])'/g, "$1‘")
    .replace(/'/g, "’")
    .replace(/(^|[-—/\[(‘\s])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/\.{3}/g, "…");
}

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      return `<h${depth} id="${headingId(html)}">${html}</h${depth}>\n`;
    },
    image({ href, title, text }) {
      const t = title ? ` title="${title}"` : "";
      return `<img src="${href}" alt="${text}"${t} loading="lazy" decoding="async">`;
    },
    text(token) {
      // Leave raw HTML and inline code alone; only prose gets smart quotes.
      if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
      if ("escaped" in token && token.escaped) return token.text;
      return smartypants(token.text).replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  },
});

export function renderMarkdown(source: string): string {
  return md.parse(source, { async: false }) as string;
}
