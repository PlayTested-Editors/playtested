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

const nextContent = (lines: string[], from: number) => {
  let j = from;
  while (j < lines.length && !lines[j].trim()) j++;
  return j;
};

export function tidyProsCons(markdown: string): { text: string; changed: number } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let changed = 0;
  let inFence = false;

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
      if (k && j + 1 < lines.length && BULLET.test(lines[nextContent(lines, j + 1)] ?? "")) {
        changed++;
        i = j - 1; // drop the combined heading and the blank lines after it
        continue;
      }
      out.push(line);
      continue;
    }

    const kind = labelKind(line);
    const first = kind ? nextContent(lines, i + 1) : -1;
    if (!kind || first >= lines.length || !BULLET.test(lines[first])) {
      out.push(line);
      continue;
    }

    // A real Pros/Cons section: canonical heading, blank line, "- " bullets.
    const heading = kind === "pros" ? "## Pros" : "## Cons";
    const items: string[] = [];
    let j = first;
    for (; j < lines.length; j++) {
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
