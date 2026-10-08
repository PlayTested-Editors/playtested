/** Scores always show one decimal: 9 → "9.0", 8.5 → "8.5". */
export function formatScore(score: number | string): string {
  const n = typeof score === "number" ? score : Number(score);
  if (typeof score === "string" && (!score.trim() || !Number.isFinite(n))) return score;
  return Number.isInteger(n * 10) ? n.toFixed(1) : String(n);
}
