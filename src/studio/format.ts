/** Display helpers. */
import type { ArticleState } from "./api";

export const STATE_LABEL: Record<ArticleState, string> = {
  draft: "Draft",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  published: "Published",
};

export const STATE_STYLE: Record<ArticleState, string> = {
  draft: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  in_review: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30",
  changes_requested: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30",
  approved: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30",
  published: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30",
};

export function relTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  const abs = Math.abs(s);
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  let out: string;
  if (abs < 45) out = "just now";
  else if (abs < 3600) out = fmt(Math.round(abs / 60), "min");
  else if (abs < 86400) out = fmt(Math.round(abs / 3600), "hour");
  else if (abs < 86400 * 30) out = fmt(Math.round(abs / 86400), "day");
  else return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  if (out === "just now") return out;
  return s >= 0 ? `${out} ago` : `in ${out}`;
}

export function dateTime(ms: number | string | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The site publishes in Philippine time (+08:00). */
const SITE_OFFSET_MS = 8 * 3600_000;

/** ISO with offset → value for <input type="datetime-local"> in site time. */
export function toLocalInput(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms + SITE_OFFSET_MS).toISOString().slice(0, 16);
}

/** <input type="datetime-local"> value (site time) → ISO with +08:00. */
export function fromLocalInput(value: string): string {
  if (!value) return new Date(Date.now() + SITE_OFFSET_MS).toISOString().replace("Z", "+08:00");
  return `${value}:00.000+08:00`;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

export const KIND_LABEL: Record<string, string> = {
  import: "Imported from git",
  sync: "Synced from git",
  save: "Saved",
  autosave: "Autosaved",
  submit: "Submitted for review",
  request_changes: "Changes requested",
  approve: "Approved",
  publish: "Published",
  unpublish: "Unpublished",
  restore: "Restored",
};
