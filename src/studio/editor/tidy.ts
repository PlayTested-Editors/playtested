/**
 * Tidies the Pros / Cons sections of a review into the site's usual format:
 *
 *   ## Pros
 *
 *   - 🎯 First point
 *   - …
 *
 * It is deliberately strict, so it never invents sections:
 *  - a line counts as a Pros/Cons label only when the whole line is the label
 *    ("Pros", "**Cons:**", "### The Pros", "✅ Pros", …), not a sentence or a
 *    heading like "The Pros of Going Solo";
 *  - and it must be followed (blank lines allowed) by a bullet list.
 * Only the label line and the bullet markers change; the bullet text is kept
 * exactly. A combined "Pros & Cons" heading is dropped only when real Pros and
 * Cons sections follow it. Code blocks are left alone.
 */

type Kind = "pros" | "cons";

const BULLET = /^\s{0,3}(?:[-*+•▪◦]|\d{1,2}[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
// A point copied from an AI's rendered page loses its bullet but keeps its emoji.
const EMOJI_LED = /^\s{0,3}(\p{Extended_Pictographic}|\p{Regional_Indicator}{2})/u;
// "Pros & Cons Pros:" — a heading run into the first label when line breaks were lost.
const MERGED = /^(\s*(?:#{1,6}\s+)?(?:\*\*)?(?:the\s+)?pros\s*(?:&|and|\/|\+)\s*cons(?:\*\*)?\s*:?)\s+((?:\*\*)?pros\b.*)$/i;

/** "Pros", "## **The Cons:**", "👍 Pros" → its kind; anything else → null. */
function labelKind(line: string): Kind | null {
  const bare = line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(\*\*|__)(.*?)(\*\*|__)$/, "$2")
    .replace(/^(\*\*|__)/, "")
    .replace(/(\*\*|__)$/, "")
    .replace(/:\s*$/, "")
    .replace(/(\*\*|__)$/, "")
    .replace(/^\p{Extended_Pictographic}️?\s*/u, "")
    .trim()
    .toLowerCase();
  if (/^(the\s+)?(pros|positives|the good)$/.test(bare)) return "pros";
  if (/^(the\s+)?(cons|negatives|the bad)$/.test(bare)) return "cons";
  return null;
}

/** "## Pros & Cons", "**Pros and Cons:**" */
function isCombinedLabel(line: string): boolean {
  const bare = line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*|__/g, "")
    .replace(/:\s*$/, "")
    .trim()
    .toLowerCase();
  return /^(the\s+)?pros\s*(&|and|\/|\+)\s*cons$/.test(bare);
}

/** A point that lost its bullet: a short plain line, not a heading, label or paragraph. */
function isBarePoint(line: string): boolean {
  const t = line.trim();
  return t.length >= 2 && t.length <= 160 && !/^#{1,6}\s/.test(t) && !labelKind(t) && !isCombinedLabel(t);
}

const nextContent = (lines: string[], from: number) => {
  let j = from;
  while (j < lines.length && !lines[j].trim()) j++;
  return j;
};

export function tidyProsCons(markdown: string): { text: string; changed: number } {
  const lines = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((l) => {
      const m = MERGED.exec(l);
      return m ? [m[1], "", m[2]] : [l];
    });
  const out: string[] = [];
  let changed = 0;
  let inFence = false;
  // Points copied as plain text can lose both their bullet and emoji. Only trust
  // bare lines as points when the text has both a Pros and a Cons label.
  const hasBoth = lines.some((l) => labelKind(l) === "pros") && lines.some((l) => labelKind(l) === "cons");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) inFence = !inFence;
    if (inFence) {
      out.push(line);
      continue;
    }

    // A combined heading directly followed by a real Pros or Cons section is redundant.
    if (isCombinedLabel(line)) {
      const j = nextContent(lines, i + 1);
      const k = j < lines.length ? labelKind(lines[j]) : null;
      const follower = lines[nextContent(lines, j + 1)] ?? "";
      if (k && j + 1 < lines.length && (BULLET.test(follower) || EMOJI_LED.test(follower))) {
        changed++;
        i = j - 1; // drop the combined heading and the blank lines after it
        continue;
      }
      out.push(line);
      continue;
    }

    const kind = labelKind(line);
    const first = kind ? nextContent(lines, i + 1) : -1;
    // Points are a bullet list, or (when copied as plain text) emoji-led lines.
    const emojiMode = Boolean(kind) && first < lines.length && !BULLET.test(lines[first]) && EMOJI_LED.test(lines[first]);
    // Bare lines: short, right under the label, one per line (a blank line ends the list).
    const plainMode = Boolean(kind) && hasBoth && first === i + 1 && first < lines.length && !BULLET.test(lines[first]) && !emojiMode && isBarePoint(lines[first]);
    if (!kind || first >= lines.length || !(BULLET.test(lines[first]) || emojiMode || plainMode)) {
      out.push(line);
      continue;
    }

    // A real Pros/Cons section: canonical heading, blank line, "- " bullets.
    const heading = kind === "pros" ? "## Pros" : "## Cons";
    const items: string[] = [];
    let j = first;
    for (; j < lines.length; j++) {
      if (plainMode) {
        // A short line followed directly by a paragraph is the next section's
        // heading ("The Verdict"), not a point (never for the first point).
        const nextIsParagraph = j + 1 < lines.length && lines[j + 1].trim().length > 160;
        if (isBarePoint(lines[j]) && !(items.length && nextIsParagraph)) {
          items.push(`- ${lines[j].trim()}`);
          continue;
        }
        break;
      }
      if (emojiMode) {
        if (EMOJI_LED.test(lines[j])) {
          items.push(`- ${lines[j].trim()}`);
          continue;
        }
        if (!lines[j].trim() && EMOJI_LED.test(lines[nextContent(lines, j)] ?? "")) continue;
        break;
      }
      const b = BULLET.exec(lines[j]);
      if (b) {
        items.push(`- ${b[1].trim()}`);
        continue;
      }
      // Wrapped continuation of the previous bullet ("  more text").
      if (lines[j].trim() && /^\s{2,}\S/.test(lines[j]) && items.length) {
        items[items.length - 1] += ` ${lines[j].trim()}`;
        continue;
      }
      // A blank line inside the list is fine if another bullet follows.
      if (!lines[j].trim() && BULLET.test(lines[nextContent(lines, j)] ?? "")) continue;
      break;
    }
    const before = lines.slice(i, j).join("\n");
    const after = [heading, "", ...items].join("\n");
    if (before.trim() !== after) changed++;
    if (out.length && out[out.length - 1].trim()) out.push("");
    out.push(heading, "", ...items);
    if (j < lines.length && lines[j].trim()) out.push("");
    i = j - 1;
  }
  return { text: out.join("\n"), changed };
}

// One point labelled inline, the way Gemini writes them: "🎯 **Pro:** text", "* **Con**: text",
// "○ ❌ Con: text" (a nested list copied as plain text). Any indent, any bullet or none.
const LABELLED = new RegExp(
  String.raw`^\s*(?:[-*+•▪◦○●]|\d{1,2}[.)])?\s*` + // optional bullet, at any depth
    String.raw`((?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})[\u{FE0F}\u{200D}\p{Extended_Pictographic}]*\s*)?` + // emoji
    String.raw`(?:\*\*|__)?\s*(pros?|cons?)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(\S.*)$`, // label, then the point
  "iu",
);

/**
 * A run of points each labelled "Pro:" or "Con:" (2 or more, blank lines
 * allowed between them) becomes "## Pros" and "## Cons" lists, in their
 * original order, keeping each point's emoji and text. A "Pros & Cons" label
 * right before the run is dropped. Code blocks are left alone.
 */
export function tidyLabelledPoints(markdown: string): { text: string; changed: number } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let changed = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) inFence = !inFence;
    if (inFence || !LABELLED.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    const pros: string[] = [];
    const cons: string[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const m = LABELLED.exec(lines[j]);
      if (m) {
        const point = `- ${m[1] ? `${m[1].trim()} ` : ""}${m[3].trim()}`;
        (m[2].toLowerCase().startsWith("pro") ? pros : cons).push(point);
        continue;
      }
      if (!lines[j].trim() && LABELLED.test(lines[nextContent(lines, j)] ?? "")) continue;
      break;
    }
    if (pros.length + cons.length < 2) {
      out.push(lines[i]);
      continue;
    }
    // Drop a "Pros & Cons" label (a heading, bold line or parent bullet) just before the run.
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length && isCombinedLabel(out[out.length - 1].replace(/^\s*(?:[-*+•▪◦○●])\s+/, ""))) out.pop();
    if (out.length) out.push("");
    if (pros.length) out.push("## Pros", "", ...pros);
    if (pros.length && cons.length) out.push("");
    if (cons.length) out.push("## Cons", "", ...cons);
    if (j < lines.length && lines[j].trim()) out.push("");
    changed++;
    i = j - 1;
  }
  return { text: out.join("\n"), changed };
}

/**
 * Removes inline styling pasted in from Google Docs, Word or web pages
 * (`<span style="color: #000000; font-family: Arial…">text</span>` → `text`).
 * Only the site's grey caption style is kept. The text inside is untouched.
 */
export function stripPastedStyles(markdown: string): { text: string; changed: number } {
  const keep = (style: string) => style.replace(/\s+/g, "").replace(/;$/, "").toLowerCase() === "font-size:0.95em;color:#888";
  let text = markdown;
  let changed = 0;
  // Innermost spans first, repeated until none are left, so nested wrappers unwrap too.
  for (let pass = 0; pass < 10; pass++) {
    let hit = false;
    text = text.replace(/<span\s+style\s*=\s*"([^"]*)"\s*>((?:(?!<span[\s>])[\s\S])*?)<\/span>/gi, (m, style: string, inner: string) => {
      if (keep(style)) return m;
      hit = true;
      changed++;
      return inner;
    });
    if (!hit) break;
  }
  return { text, changed };
}

// A line that is only an image: <img …> or ![alt](src).
const IMAGE_LINE = /^\s*(?:<img\b[^>]*>|!\[[^\]]*\]\([^)]*\))\s*$/i;
// Where a sentence can end (so the paragraph wasn't cut short).
const ENDS_SENTENCE = /[.!?:;…"”')\]*_>]\s*$/;
const PLAIN_LINE = (l: string) => l.trim() !== "" && !/^\s*(?:#{1,6}\s|[-*+>|]|\d{1,2}[.)]\s|<|```|~~~)/.test(l);

/**
 * An image dropped mid-sentence splits the paragraph in two ("…it was an
 * absolute" / image / "blast just like old times…"). Rejoin the sentence and
 * put the image(s) at the start of the paragraph instead.
 */
export function rejoinSplitParagraphs(markdown: string): { text: string; changed: number } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let changed = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) inFence = !inFence;
    if (inFence || !PLAIN_LINE(lines[i]) || ENDS_SENTENCE.test(lines[i])) continue;
    // The first half must be the end of its paragraph (blank line next).
    if (lines[i + 1] === undefined || lines[i + 1].trim()) continue;
    // One or more image lines (blank lines between), then the rest of the sentence.
    let j = nextContent(lines, i + 1);
    const images: number[] = [];
    while (j < lines.length && IMAGE_LINE.test(lines[j])) {
      images.push(j);
      j = nextContent(lines, j + 1);
    }
    if (!images.length || j >= lines.length || !PLAIN_LINE(lines[j]) || !/^\s*\p{Ll}/u.test(lines[j])) continue;
    // Find where the first half's paragraph starts.
    let start = i;
    while (start > 0 && PLAIN_LINE(lines[start - 1])) start--;
    const imageLines = images.flatMap((k, n) => (n ? ["", lines[k]] : [lines[k]]));
    const joined = `${lines[i].trimEnd()} ${lines[j].trimStart()}`;
    lines.splice(start, j - start + 1, ...imageLines, "", ...lines.slice(start, i), joined);
    changed++;
    i = start + imageLines.length;
  }
  return { text: lines.join("\n"), changed };
}

// ---- Unlabelled points ------------------------------------------------------------
// Some AI replies give pros and cons as ONE list with no labels:
//   - 🎯 **A phenomenal payoff:** Acts as the ultimate "series finale"…
//   - 🕹️ **Clunky mechanics:** The controls … haven't aged gracefully…
// Which point is which can't be read from the text, so the editor asks (with a guess).

// A point: bullet, optional emoji, a short bold lead-in, then the sentence.
const LEAD_POINT = /^\s{0,3}[-*+•]\s+(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})[️‍\p{Extended_Pictographic}]*\s*)?\*\*[^*\n]{2,70}\*\*:?\s*\S/u;
const NEGATIVE = /\b(clunky|clunkier|lacks?|lacking|frustrat\w*|tedious|repetitive|grind\w*|bugs?|bugg\w*|glitch\w*|crash\w*|issues?|problems?|poor|weak\w*|dated|aged|outdated|janky|jank|awkward|confus\w*|annoy\w*|short|shallow|bland|boring|slow|sluggish|backseat|whiplash|never|no\s|not\b|isn't|doesn't|don't|can't|without|missing|limited|overpriced|pay-to-win|p2w|predatory|stiff|unbalanced|cluttered|noise|noisy|hollow|lonely|lack|drag\w*|padding|forgettable|disappoint\w*|mess\w*|broken|cheap)\b/i;
const POSITIVE = /\b(phenomenal|masterful|gorgeous|beautiful|stunning|excellent|great|fantastic|brilliant|fun|satisfying|smooth|natural|polished|impressive|engaging|addict\w*|peak|best|incredible|charming|rich|deep|lovable|delight\w*|superb|solid|welcome|improv\w*|striking|immersive|memorable|hilarious|generous|clever|creative|unique)\b/i;

export interface UnsortedPoints {
  start: number; // first line of the list
  end: number; // line after the list
  items: string[]; // each point without its bullet
  guess: ("pro" | "con")[];
}

/** An unlabelled list of 4+ lead-in points, when the article has no Pros/Cons sections yet. */
export function findUnsortedPoints(markdown: string): UnsortedPoints | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines.some((l) => labelKind(l))) return null; // already has Pros / Cons labels
  for (let i = 0; i < lines.length; i++) {
    if (!LEAD_POINT.test(lines[i])) continue;
    const items: string[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      if (LEAD_POINT.test(lines[j])) {
        items.push(lines[j].replace(/^\s{0,3}[-*+•]\s+/, "").trim());
        continue;
      }
      // Wrapped continuation of the previous point.
      if (lines[j].trim() && /^\s{2,}\S/.test(lines[j]) && items.length) {
        items[items.length - 1] += ` ${lines[j].trim()}`;
        continue;
      }
      if (!lines[j].trim() && LEAD_POINT.test(lines[nextContent(lines, j)] ?? "")) continue;
      break;
    }
    if (items.length < 4) {
      i = j;
      continue;
    }
    // Score each point, then pick the split "first k are pros, the rest cons" that
    // agrees with the scores best (AI replies list praises first).
    const score = items.map((t) => {
      const lead = /\*\*([^*]+)\*\*/.exec(t)?.[1] ?? "";
      const neg = (t.match(new RegExp(NEGATIVE.source, "gi")) || []).length + (NEGATIVE.test(lead) ? 2 : 0);
      const pos = (t.match(new RegExp(POSITIVE.source, "gi")) || []).length + (POSITIVE.test(lead) ? 2 : 0);
      return pos - neg;
    });
    let bestK = items.length, bestErr = Infinity;
    for (let k = 1; k < items.length; k++) {
      const err = score.slice(0, k).filter((s) => s < 0).length + score.slice(k).filter((s) => s > 0).length;
      if (err < bestErr) (bestErr = err), (bestK = k);
    }
    return { start: i, end: j, items, guess: items.map((_, n) => (n < bestK ? "pro" : "con")) };
  }
  return null;
}

/** Replace the list with "## Pros" / "## Cons" sections, in the chosen split. */
export function applySortedPoints(markdown: string, found: UnsortedPoints, kinds: ("pro" | "con")[]): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const pros = found.items.filter((_, n) => kinds[n] === "pro").map((t) => `- ${t}`);
  const cons = found.items.filter((_, n) => kinds[n] === "con").map((t) => `- ${t}`);
  const block = [
    ...(pros.length ? ["## Pros", "", ...pros] : []),
    ...(pros.length && cons.length ? [""] : []),
    ...(cons.length ? ["## Cons", "", ...cons] : []),
  ];
  const before = lines.slice(0, found.start);
  const after = lines.slice(found.end);
  while (before.length && !before[before.length - 1].trim()) before.pop();
  while (after.length && !after[0].trim()) after.shift();
  return [...before, ...(before.length ? [""] : []), ...block, ...(after.length ? ["", ...after] : [])].join("\n");
}

/** Everything the "Tidy" button does: pasted styling, split sentences, inline "Pro:"/"Con:" points, then Pros / Cons sections. */
export function tidyFormatting(markdown: string): { text: string; styles: number; sections: number; rejoined: number } {
  const a = stripPastedStyles(markdown);
  const r = rejoinSplitParagraphs(a.text);
  const b = tidyLabelledPoints(r.text);
  const c = tidyProsCons(b.text);
  return { text: c.text, styles: a.changed, sections: b.changed + c.changed, rejoined: r.changed };
}
