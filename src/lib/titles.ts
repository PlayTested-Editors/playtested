/**
 * The game's name from an article title. Titles come in a few shapes:
 *   "Tagline | Game Review", "Tagline | Full Review - Game", "Game: Short Review".
 * Used where the AI writes [n] in place of a title, and for starter prompts.
 */
const KIND = String.raw`(?:(?:early\s+access|short|quick|full|in-depth|first|early|beta|demo|final|hands-on)\s+)?(?:review|preview|impressions?)(?:\s+in\s+progress)?`;
const KIND_LEAD = new RegExp(`^${KIND}\\s*[-–—:]\\s*`, "i");
const KIND_TRAIL = new RegExp(`[\\s:–—-]*${KIND}$`, "i");

export function shortTitle(title: string): string {
  const parts = title.split("|").map((s) => s.trim()).filter(Boolean);
  const name = (parts.length > 1 ? parts[parts.length - 1] : (parts[0] ?? title)).replace(KIND_LEAD, "").replace(KIND_TRAIL, "").trim();
  return name || title;
}
