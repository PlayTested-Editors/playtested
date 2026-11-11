/**
 * Search intent: understands words like "quick reviews", "full review",
 * "best RPG demos", "first impressions 2024" or "9+ co-op" in a query.
 *
 * Pure functions (no DOM, no Worker APIs), shared by the search page (instant
 * results from the static index) and /api/search (full-text results), so both
 * read a query the same way. A query is split into
 *  - `text`:  what is left to search for (game names, genres, ...)
 *  - `kinds`: what sort of article is wanted (impressions, full review, demo, ...)
 *  - `sort`, `year`, `minScore`, `maxScore`: ordering and filters
 * Kinds come from the title, because articles carry no "type" field: the site
 * has hundreds of "... First Impressions" and "... Full Review" posts.
 */

export type Kind = "impressions" | "quick" | "review" | "demo" | "earlyaccess" | "preview" | "tech" | "writeup" | "news";
export type Sort = "score" | "lowscore" | "newest" | "oldest";

export interface Intent {
  /** Query with the intent words removed. Empty when the whole query was intent. */
  text: string;
  kinds: Kind[];
  sort: Sort | null;
  year: number | null;
  minScore: number | null;
  maxScore: number | null;
  /** Plain-English summary for the results page, e.g. "first impressions, newest first". */
  label: string;
}

export const KIND_LABEL: Record<Kind, string> = {
  impressions: "first impressions",
  quick: "quick reviews and first impressions",
  review: "full reviews",
  demo: "demos",
  earlyaccess: "early access",
  preview: "previews",
  tech: "tech",
  writeup: "write-ups",
  news: "news and updates",
};

const SORT_LABEL: Record<Sort, string> = {
  score: "highest scored first",
  lowscore: "lowest scored first",
  newest: "newest first",
  oldest: "oldest first",
};

// Multi-word phrases first (matched on the lowercased query), then single words.
const PHRASES: [RegExp, { kind?: Kind; sort?: Sort }][] = [
  [/\bfirst (?:impressions?|looks?)\b/g, { kind: "impressions" }],
  [/\b(?:quick|early|initial) (?:impressions?|looks?|thoughts?|takes?)\b/g, { kind: "impressions" }],
  [/\bhands[- ]on\b/g, { kind: "impressions" }],
  [/\bin[- ]depth\b/g, { kind: "review" }],
  [/\bfull(?:y)? (?:in[- ]depth )?reviews?\b/g, { kind: "review" }],
  [/\b(?:final|complete|detailed|proper|long|scored) reviews?\b/g, { kind: "review" }],
  [/\b(?:quick|short|brief|fast) reviews?\b/g, { kind: "quick" }],
  [/\bearly[- ]access\b/g, { kind: "earlyaccess" }],
  [/\b(?:write[- ]?ups?|editorials?|opinion pieces?|games? of the year|goty)\b/g, { kind: "writeup" }],
  [/\b(?:top|best|highest|higher)[- ]rated\b/g, { sort: "score" }],
  [/\b(?:worst|lowest|lower)[- ]rated\b/g, { sort: "lowscore" }],
  [/\bmust[- ]plays?\b/g, { sort: "score" }],
  [/\bhidden gems?\b/g, {}],
];

// Words that are also part of game names ("Full Metal", "Complete Edition", "Quick..."):
// they only mean a kind of article when the query also says "review(s)".
const WITH_REVIEW_WORD: Record<string, Kind> = {
  quick: "quick",
  brief: "quick",
  full: "review",
  complete: "review",
  detailed: "review",
};

const WORDS: Record<string, { kind?: Kind; sort?: Sort }> = {
  impressions: { kind: "impressions" },
  impression: { kind: "impressions" },
  demo: { kind: "demo" },
  demos: { kind: "demo" },
  preview: { kind: "preview" },
  previews: { kind: "preview" },
  trailer: { kind: "preview" },
  trailers: { kind: "preview" },
  beta: { kind: "preview" },
  tech: { kind: "tech" },
  gadget: { kind: "tech" },
  gadgets: { kind: "tech" },
  hardware: { kind: "tech" },
  news: { kind: "news" },
  announcement: { kind: "news" },
  announcements: { kind: "news" },
  updates: { kind: "news" },
  best: { sort: "score" },
  top: { sort: "score" },
  highest: { sort: "score" },
  greatest: { sort: "score" },
  favorite: { sort: "score" },
  favorites: { sort: "score" },
  favourite: { sort: "score" },
  favourites: { sort: "score" },
  worst: { sort: "lowscore" },
  lowest: { sort: "lowscore" },
  latest: { sort: "newest" },
  newest: { sort: "newest" },
  recent: { sort: "newest" },
  recently: { sort: "newest" },
  oldest: { sort: "oldest" },
  earliest: { sort: "oldest" },
};

/** Filler that adds nothing to a search ("show me the best RPGs you've reviewed"). */
const FILLER = new Set(
  "a an and are as at be by for from give has have i in is it its list me my of on or please show that the these this those to was were what which who with you your youve you've ive i've all any every some find about do does did can could should would score scores scored rating ratings rated".split(
    " ",
  ),
);
/** Present in nearly every title, so only meaningful when nothing else is left. */
const GENERIC = new Set(["review", "reviews", "reviewed", "game", "games", "article", "articles", "post", "posts"]);

const num = (s: string) => Math.min(Math.max(Number(s), 0), 10);

export function parseIntent(raw: string, now = new Date()): Intent {
  let q = ` ${raw.toLowerCase().replace(/[“”"]/g, " ").replace(/\s+/g, " ").trim()} `;
  const kinds = new Set<Kind>();
  let sort: Sort | null = null;
  let year: number | null = null;
  let minScore: number | null = null;
  let maxScore: number | null = null;

  const take = (m: { kind?: Kind; sort?: Sort }) => {
    if (m.kind) kinds.add(m.kind);
    if (m.sort) sort = m.sort;
  };

  // Score bounds: "9+", "above 8", "at least 8.5", "under 7".
  q = q.replace(/\b(\d{1,2}(?:\.\d)?)\s*\+/g, (_, n) => ((minScore = num(n)), " "));
  q = q.replace(/\b(?:above|over|at least|minimum|min|score of|scoring|rated|>=?)\s+(\d{1,2}(?:\.\d)?)\b/g, (_, n) => ((minScore = num(n)), " "));
  q = q.replace(/\b(?:below|under|less than|at most|max|<=?)\s+(\d{1,2}(?:\.\d)?)\b/g, (_, n) => ((maxScore = num(n)), " "));

  for (const [re, m] of PHRASES) q = q.replace(re, () => (take(m), " "));

  const words = q.match(/[a-z0-9][a-z0-9'.+-]*/g) ?? [];
  const reviewWord = words.some((w) => /^review(?:s|ed)?$/.test(w));
  const rest: string[] = [];
  for (const w of words) {
    const hit = WORDS[w] ?? (reviewWord && WITH_REVIEW_WORD[w] ? { kind: WITH_REVIEW_WORD[w] } : undefined);
    if (hit) take(hit);
    else if (!FILLER.has(w)) rest.push(w);
  }

  // A year only filters when the query also says what kind of thing is wanted
  // (or nothing else): "Cyberpunk 2077" and "Doom 2016" stay plain searches.
  const intentful = kinds.size > 0 || sort !== null || minScore !== null || maxScore !== null;
  const yearAt = rest.findIndex((w) => /^(?:19|20)\d\d$/.test(w) && Number(w) >= 2005 && Number(w) <= now.getFullYear());
  const others = rest.filter((w, i) => i !== yearAt && !GENERIC.has(w));
  if (yearAt >= 0 && (intentful || others.length === 0)) {
    year = Number(rest[yearAt]);
    rest.splice(yearAt, 1);
  }

  // Generic words ("reviews", "games") only count when they are all that's left.
  let text = rest.filter((w) => !GENERIC.has(w)).join(" ");
  if (!text && rest.some((w) => /^review(?:s|ed)?$/.test(w)) && !kinds.size) kinds.add("review");

  const k = [...kinds];
  const label = [
    k.map((x) => KIND_LABEL[x]).join(" + "),
    year ? `from ${year}` : "",
    minScore !== null ? `scored ${minScore}+` : "",
    maxScore !== null ? `scored under ${maxScore}` : "",
    sort ? SORT_LABEL[sort] : "",
  ]
    .filter(Boolean)
    .join(", ");

  const none = !k.length && !sort && !year && minScore === null && maxScore === null;
  // Nothing recognised: the query is exactly what was typed.
  if (none) text = raw.replace(/\s+/g, " ").trim();

  return { text, kinds: k, sort, year, minScore, maxScore, label };
}

export const hasIntent = (i: Intent) => i.kinds.length > 0 || i.sort !== null || i.year !== null || i.minScore !== null || i.maxScore !== null;

interface DocLike {
  title: string;
  category?: string | null;
  score?: number | null;
  pubDate?: number | null;
}

/** What sort of article this is, from its title and category. */
export function kindsOf(d: DocLike): Set<Kind> {
  const t = d.title.toLowerCase();
  const cat = (d.category ?? "").trim().toLowerCase();
  const out = new Set<Kind>();
  // "impressions" the word, not "First Impression" in a review headline.
  const impressions = /\bimpressions\b|first looks?|hands[- ]on|early thoughts|quick (?:look|thoughts|take)/.test(t);
  if (impressions) out.add("impressions");
  // A "Quick Review" is its own short format; first impressions are short takes too, so "quick" finds both.
  const quick = /\bquick review\b/.test(t);
  if (quick || impressions) out.add("quick");
  if (/\breview\b/.test(t) && !impressions && !quick) out.add("review");
  if (/\bdemo\b/.test(t)) out.add("demo");
  if (/early access/.test(t)) out.add("earlyaccess");
  if (/preview|trailer|\bbeta\b|playtest/.test(t)) out.add("preview");
  if (cat === "tech") out.add("tech");
  if (cat === "write-up" || /games? of the year|goty/.test(t)) out.add("writeup");
  if (!out.size && cat === "review") out.add("news"); // review-category posts that aren't reviews: announcements, updates
  return out;
}

export function matchesIntent(d: DocLike, i: Intent): boolean {
  if (i.kinds.length) {
    const have = kindsOf(d);
    if (!i.kinds.every((k) => have.has(k))) return false;
  }
  if (i.year !== null && (!d.pubDate || new Date(d.pubDate).getFullYear() !== i.year)) return false;
  const s = d.score ?? null;
  if (i.minScore !== null && (s === null || s < i.minScore)) return false;
  if (i.maxScore !== null && (s === null || s >= i.maxScore)) return false;
  if ((i.sort === "score" || i.sort === "lowscore") && s === null && !i.kinds.length) return false; // "best RPGs": only scored ones
  return true;
}

/** Stable re-ordering by the intent's sort (relevance order is kept when there is none). */
export function sortByIntent<T extends DocLike>(list: T[], i: Intent): T[] {
  const by = i.sort;
  if (!by) return list;
  const idx = new Map(list.map((d, n) => [d, n]));
  const date = (d: T) => d.pubDate ?? 0;
  const cmp: Record<Sort, (a: T, b: T) => number> = {
    score: (a, b) => (b.score ?? -1) - (a.score ?? -1) || date(b) - date(a),
    lowscore: (a, b) => (a.score ?? 99) - (b.score ?? 99) || date(b) - date(a),
    newest: (a, b) => date(b) - date(a),
    oldest: (a, b) => date(a) - date(b),
  };
  return [...list].sort((a, b) => cmp[by](a, b) || idx.get(a)! - idx.get(b)!);
}

/** The query exactly as typed, with no intent applied ("search as plain words"). */
export function plainIntent(raw: string): Intent {
  return { text: raw.replace(/\s+/g, " ").trim(), kinds: [], sort: null, year: null, minScore: null, maxScore: null, label: "" };
}
