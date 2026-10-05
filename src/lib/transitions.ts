/**
 * View-transition names shared by the article page and the cards linking to it.
 *
 * ArticleView names its title `title-<slug>` and its hero `hero-<slug>`; cards
 * get the same names from script at click time (src/scripts/motion.ts), which
 * keeps them unique even when a post appears twice on one page.
 */
export const heroTransitionName = (slug: string) => `hero-${slug}`;
export const titleTransitionName = (slug: string) => `title-${slug}`;

/**
 * Encode a name the way Astro encodes `transition:name` values (`reEncode` in
 * astro/dist/runtime/server/transition.js), so a name set from script or a
 * style attribute matches the one Astro renders.
 */
export function vtName(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code >= 128 || /[A-Za-z0-9-]/.test(ch)) out += ch;
    else if (ch === "_") out += "__";
    else out += "_" + code.toString(16).padStart(2, "0");
  }
  return /^[-0-9_]/.test(out) ? "_" + out : out;
}
