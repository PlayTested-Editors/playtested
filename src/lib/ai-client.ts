/**
 * Browser helpers shared by the visitor-facing AI features (chat widget,
 * search answer box, "Ask this review", recommender/comparator).
 *
 *  - A tiny markdown renderer for AI output. Everything is HTML-escaped first;
 *    only bold/italic/code, lists, paragraphs and http(s)/site links survive.
 *  - The answer stream format: `<!--REFS:{...}:REFS-->` followed by
 *    OpenRouter's SSE. REFS maps citation markers ("[1]") to articles.
 *  - Friendly messages for the API's gate errors (paused / rate limited / daily cap).
 *
 * Client-only: import from <script> tags, never from server code.
 */
import { formatScore } from "./score";

export interface Ref {
  url?: string;
  title?: string;
  /** Short name used where the AI wrote [n] in place of a title. */
  label?: string;
  score?: number | null;
  /** "Ask this review": the section of the article a passage came from. */
  heading?: string;
}
export type Refs = Record<string, Ref>;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const SITE_HOSTS = new Set(["playtested.net", "www.playtested.net"]);

/** Allow only site-relative and http(s) links; same-site absolute links become relative. */
export function safeHref(raw: string | undefined | null): string | null {
  const url = String(raw ?? "").trim();
  if (/^\/(?!\/)/.test(url)) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    if (SITE_HOSTS.has(u.hostname) || u.hostname === location.hostname) return `${u.pathname}${u.search}${u.hash}`;
    return u.href;
  } catch {
    return null;
  }
}

/** Accepts both the current `{url,title,...}` refs and the older "url::title" strings. */
export function normalizeRefs(raw: unknown): Refs {
  const out: Refs = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = /^\[\d+\]$/.test(k) ? k : `[${k}]`;
    if (typeof v === "string") {
      const [url, title] = v.split("::");
      out[key] = { url: safeHref(url) ?? undefined, title, label: title };
    } else if (v && typeof v === "object") {
      const r = v as Ref;
      out[key] = {
        url: safeHref(r.url) ?? undefined,
        title: r.title ? String(r.title) : undefined,
        label: r.label ? String(r.label) : r.title ? String(r.title) : undefined,
        score: typeof r.score === "number" ? r.score : null,
        heading: r.heading ? String(r.heading) : undefined,
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown → safe HTML

export interface RenderOptions {
  refs?: Refs;
  /** "link" turns [n] into links to the cited article; "strip" drops the markers. */
  citations?: "link" | "strip";
  /** Show a caret at the end (while streaming). */
  caret?: boolean;
  /** Internal: reviews already linked in this answer, so each name is linked once. */
  linked?: Set<string>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where `label` appears in `text` as a whole name (case-insensitive), or -1. */
function mentionAt(text: string, label: string | undefined): number {
  if (!label || label.length < 3) return -1;
  const m = new RegExp(`(^|[^\\w])${escapeRe(label)}(?!\\w)`, "i").exec(text);
  return m ? m.index + m[1].length : -1;
}

/**
 * The model doesn't always write [n] and names the game instead ("Tekken 8
 * scored 10/10"). Link the first plain mention of each review's name.
 */
function linkNames(html: string, opts: RenderOptions): string {
  const linked = opts.linked;
  if (!linked || !opts.refs || opts.citations === "strip") return html;
  const cands = Object.values(opts.refs)
    .filter((r) => r.url && (r.label?.length ?? 0) >= 3 && !linked.has(r.url))
    .sort((a, b) => b.label!.length - a.label!.length); // "Hades II" before "Hades"
  if (!cands.length) return html;
  const anchors: string[] = [];
  let inLink = 0;
  const out = html.split(/(<[^>]+>)/).map((part) => {
    if (part.startsWith("<")) {
      if (/^<a[\s>]/i.test(part)) inLink++;
      else if (/^<\/a>/i.test(part)) inLink = Math.max(0, inLink - 1);
      return part;
    }
    if (inLink || !part) return part;
    let seg = part;
    for (const r of cands) {
      if (linked.has(r.url!)) continue;
      const at = mentionAt(seg, escapeHtml(r.label!));
      if (at < 0) continue;
      linked.add(r.url!);
      const name = seg.slice(at, at + escapeHtml(r.label!).length);
      anchors.push(`<a href="${escapeHtml(r.url!)}" class="${CITE}" title="${escapeHtml(r.title || r.label!)}">${name}</a>`);
      // A placeholder, so later names can't match inside this link.
      seg = `${seg.slice(0, at)}\u0001${anchors.length - 1}\u0001${seg.slice(at + name.length)}`;
    }
    return seg;
  });
  return out.join("").replace(/\u0001(\d+)\u0001/g, (_, i: string) => anchors[Number(i)]);
}

const LINK = "font-medium text-indigo-600 dark:text-indigo-400 underline decoration-indigo-300 dark:decoration-indigo-500/60 underline-offset-2 hover:decoration-2";
const CITE = "font-semibold text-indigo-700 dark:text-indigo-300 underline decoration-dotted decoration-indigo-400 underline-offset-2 hover:decoration-solid";
// A still caret: no blinking (the owner is light-sensitive, see CLAUDE.md).
const CARET = `<span class="inline-block w-[0.45em] h-[1em] -mb-[0.15em] ml-0.5 rounded-sm bg-current opacity-40" aria-hidden="true"></span>`;

function inline(text: string, opts: RenderOptions): string {
  let s = escapeHtml(text);
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // [label](url) — the url was escaped along with everything else.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
    const href = safeHref(url.replace(/&amp;/g, "&"));
    if (!href) return label;
    const ext = !href.startsWith("/");
    return `<a href="${escapeHtml(href)}" class="${LINK}"${ext ? ' target="_blank" rel="noopener noreferrer nofollow"' : ""}>${label}</a>`;
  });
  // Citations: [1], [1, 2] or [1][2].
  s = s.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (whole, nums: string) => {
    if (opts.citations === "strip") return "";
    const refs = opts.refs ?? {};
    const parts = nums.split(/\s*,\s*/).map((n) => {
      const r = refs[`[${n}]`];
      if (!r?.url) return null;
      opts.linked?.add(r.url);
      const label = r.label || r.title || `source ${n}`;
      return `<a href="${escapeHtml(r.url)}" class="${CITE}" title="${escapeHtml(r.title || label)}">${escapeHtml(label)}</a>`;
    });
    return parts.every(Boolean) ? parts.join(", ") : whole;
  });
  // The model often repeats the name right after a citation ("[1] Elden Ring"),
  // which renders as "Elden Ring Elden Ring". Drop the echo.
  for (const r of Object.values(opts.refs ?? {})) {
    const label = r.label || r.title;
    if (!label || label.length < 2) continue;
    const esc = escapeHtml(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`(>${esc}</a>)\\s*(?:\\*\\*|__)?${esc}(?:\\*\\*|__)?`, "gi"), "$1");
  }
  s = s
    .replace(/\*\*(?=\S)([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([^_]+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code class="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 text-[0.9em]">${codes[Number(i)]}</code>`);
  s = linkNames(s, opts);
  if (opts.citations === "strip") s = s.replace(/\s+([.,;:!?])/g, "$1");
  return s;
}

export function renderMarkdown(src: string, options: RenderOptions = {}): string {
  const opts: RenderOptions = { ...options, linked: new Set() };
  const blocks: string[] = [];
  let para: string[] = [];
  let list = null as { tag: "ul" | "ol"; items: string[] } | null;
  const flushPara = () => {
    if (para.length) blocks.push(`<p class="my-2 first:mt-0 last:mb-0">${para.join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const cls = list.tag === "ul" ? "list-disc" : "list-decimal";
      blocks.push(`<${list.tag} class="${cls} pl-5 my-2 space-y-1 first:mt-0 last:mb-0">${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    }
    list = null;
  };

  for (const raw of String(src ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if ((m = /^\s*[-*+•]\s+(.*)$/.exec(line)) || (m = /^\s*\d{1,2}[.)]\s+(.*)$/.exec(line))) {
      const tag = /^\s*\d/.test(line) ? "ol" : "ul";
      flushPara();
      if (list?.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list!.items.push(inline(m[1], opts));
    } else if ((m = /^#{1,6}\s+(.*)$/.exec(line))) {
      flushPara();
      flushList();
      blocks.push(`<p class="my-2 first:mt-0 font-semibold">${inline(m[1].replace(/\*\*/g, ""), opts)}</p>`);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${inline(line.trim(), opts)}`;
    } else {
      flushList();
      para.push(inline(line, opts));
    }
  }
  flushPara();
  flushList();

  let html = blocks.join("");
  if (opts.caret) {
    const close = /(<\/li><\/[uo]l>|<\/p>)$/.exec(html);
    html = close ? `${html.slice(0, close.index)}${CARET}${close[1]}` : `${html}${CARET}`;
  }
  return html;
}

/** Plain text for the copy button: citations become titles, markdown marks go. */
export function toPlainText(src: string, refs: Refs = {}): string {
  return String(src ?? "")
    .replace(/\[(\d{1,2})\]/g, (whole, n: string) => refs[`[${n}]`]?.label || refs[`[${n}]`]?.title || whole)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)\*(\S[^*]*?)\*/g, "$1$2")
    .trim();
}

/** The refs an answer cited by [n], then the ones it named in plain words, in order. */
export function citedRefs(text: string, refs: Refs): Ref[] {
  const src = String(text ?? "");
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const m of src.matchAll(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g)) {
    for (const n of m[1].split(/\s*,\s*/)) {
      const r = refs[`[${n}]`];
      if (r?.url && !seen.has(r.url)) {
        seen.add(r.url);
        out.push(r);
      }
    }
  }
  const named = Object.values(refs)
    .filter((r) => r.url && !seen.has(r.url))
    .map((r) => ({ r, at: mentionAt(src, r.label) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at);
  for (const { r } of named) {
    if (seen.has(r.url!)) continue;
    seen.add(r.url!);
    out.push(r);
  }
  return out;
}

/** "We reviewed this" style chips linking to the cited articles. */
export function sourceChips(list: Ref[]): string {
  return list
    .map((r) => {
      const score = typeof r.score === "number" ? `<span class="shrink-0 rounded-full bg-indigo-600 px-1.5 py-px text-[10px] font-bold text-white">${escapeHtml(formatScore(r.score))}</span>` : "";
      return `<a href="${escapeHtml(r.url || "/")}" title="${escapeHtml(r.title || "")}" class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-indigo-200 dark:border-indigo-500/30 bg-white/80 dark:bg-slate-900/50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"><svg class="h-3 w-3 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"/></svg><span class="truncate">${escapeHtml(r.label || r.title || "Review")}</span>${score}</a>`;
    })
    .join("");
}

/** Shown until the first words arrive. Still text, no bouncing dots. */
export const TYPING_DOTS = `<span class="inline-block py-0.5 text-sm italic opacity-70" role="status">Thinking…</span>`;

// ---------------------------------------------------------------------------
// Requests

const GATE_CODES = new Set(["feature_paused", "rate_limited", "daily_cap"]);

export class AiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** A gate refusal (paused, too fast, daily limit) rather than a failure. */
  get soft(): boolean {
    return GATE_CODES.has(this.code ?? "") || this.status === 429 || this.status === 503;
  }
}

function errorFrom(status: number, body: unknown): AiError {
  const data = (body && typeof body === "object" ? body : {}) as { error?: unknown; code?: unknown };
  const code = typeof data.code === "string" ? data.code : undefined;
  const msg = typeof data.error === "string" && data.error.length < 200 ? data.error : "";
  if (code && msg) return new AiError(msg, status, code); // gate messages are written for visitors
  if (status === 429) return new AiError("You're going a bit fast — give it a minute and try again.", status, code);
  if (status === 503) return new AiError("This feature is taking a short break to keep PlayTested free to run. Please try again later.", status, code);
  if (msg && status !== 401 && status !== 403) return new AiError(msg, status, code);
  return new AiError("Something went wrong on our side. Please try again in a moment.", status, code);
}

function offline(): AiError {
  return new AiError(
    typeof navigator !== "undefined" && navigator.onLine === false
      ? "You appear to be offline. Reconnect and try again."
      : "Couldn't reach PlayTested. Check your connection and try again.",
  );
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw offline();
  }
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await send(url, { signal, headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || (data as { error?: unknown }).error) throw errorFrom(res.status, data);
  return data as T;
}

export async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await send(url, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || (data as { error?: unknown }).error) throw errorFrom(res.status, data);
  return data as T;
}

export interface StreamResult {
  text: string;
  refs: Refs;
  /** The visitor stopped it (AbortController) before it finished. */
  stopped: boolean;
}

/**
 * POST to a streaming AI endpoint; `onText` gets the whole answer so far after
 * every chunk. Resolves with what was received, also when stopped early.
 */
export async function streamAi(
  url: string,
  body: unknown,
  opts: { signal?: AbortSignal; onText?: (text: string, refs: Refs) => void } = {},
): Promise<StreamResult> {
  let refs: Refs = {};
  let text = "";
  let res: Response;
  try {
    res = await send(url, { method: "POST", signal: opts.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    if (isAbort(e)) return { text, refs, stopped: true };
    throw e;
  }
  if (!res.ok || !res.body) throw errorFrom(res.status, await res.json().catch(() => null));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let refsDone = false;
  let filtered = false;
  const START = "<!--REFS:";
  const END = ":REFS-->";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      if (!refsDone) {
        if (buf.startsWith(START)) {
          const end = buf.indexOf(END);
          if (end === -1 && !done) continue;
          if (end !== -1) {
            try {
              refs = normalizeRefs(JSON.parse(buf.slice(START.length, end)));
            } catch {
              refs = {};
            }
            buf = buf.slice(end + END.length).replace(/^\n/, "");
          }
          refsDone = true;
        } else if (buf.length >= START.length || done || !START.startsWith(buf)) {
          refsDone = true;
        } else continue;
      }
      const lines = buf.split("\n");
      buf = done ? "" : (lines.pop() ?? "");
      let changed = false;
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue; // ": OPENROUTER PROCESSING" keep-alives etc.
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt: { choices?: { delta?: { content?: string }; finish_reason?: string | null }[]; error?: unknown };
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        if (evt.error) throw new AiError("The AI stopped unexpectedly. Please try again.", 502);
        // The model's own safety filter sometimes cuts off harmless answers, often after one word.
        if (evt.choices?.[0]?.finish_reason === "content_filter") filtered = true;
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          changed = true;
        }
      }
      if (changed) opts.onText?.(text, refs);
      if (done) break;
    }
  } catch (e) {
    if (isAbort(e) || opts.signal?.aborted) return { text, refs, stopped: true };
    if (e instanceof AiError) throw e;
    if (text) return { text, refs, stopped: true }; // connection dropped mid-answer: keep what arrived
    throw offline();
  }
  if (filtered && text.trim().length < 40) {
    throw new AiError("The AI couldn't answer that one. Try asking it a slightly different way.", 502);
  }
  if (!text.trim()) throw new AiError("The AI didn't come back with an answer. Please try again.", 502);
  return { text, refs, stopped: filtered };
}

/** A friendly inline notice for an error (amber for "paused/too fast", red otherwise). */
export function noticeHtml(err: unknown): string {
  const e = err instanceof AiError ? err : new AiError("Something went wrong. Please try again.");
  const tone = e.soft
    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
    : "border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200";
  const icon = e.soft
    ? `<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-12.25a.75.75 0 00-1.5 0V10c0 .2.08.39.22.53l2.5 2.5a.75.75 0 101.06-1.06l-2.28-2.28V5.75z" clip-rule="evenodd"/>`
    : `<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/>`;
  return `<div role="status" class="flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${tone}"><svg class="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">${icon}</svg><span>${escapeHtml(e.message)}</span></div>`;
}

/** Run `fn` at most once per animation frame (smooth, cheap streaming renders). */
export function perFrame<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let queued: A | null = null;
  return (...args: A) => {
    const first = queued === null;
    queued = args;
    if (first)
      requestAnimationFrame(() => {
        const a = queued!;
        queued = null;
        fn(...a);
      });
  };
}

export const prefersReducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Copy text, with a fallback for browsers without the async clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
