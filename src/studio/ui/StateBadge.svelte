<script lang="ts">
  import type { ArticleState } from "../api";
  import { STATE_LABEL, STATE_STYLE, dateTime } from "../format";

  let {
    state,
    live = false,
    pending = false,
    pubDate = null,
  }: { state: ArticleState; live?: boolean; pending?: boolean; pubDate?: number | null } = $props();

  // Published with a future date: not on the site until then.
  let scheduled = $derived(live && pubDate !== null && pubDate > Date.now());
  const SCHEDULED_STYLE = "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30";
</script>

<span class="inline-flex items-center gap-1.5">
  {#if scheduled && state === "published"}
    <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset {SCHEDULED_STYLE}" title={`Goes live ${dateTime(pubDate)}`}>
      Scheduled
    </span>
  {:else}
    <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset {STATE_STYLE[state]}">
      {STATE_LABEL[state]}
    </span>
  {/if}
  {#if scheduled && state !== "published"}
    <span
      class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset {SCHEDULED_STYLE}"
      title={`Scheduled: goes live ${dateTime(pubDate)}${pending ? "; these edits aren't published yet" : ""}`}
    >
      Scheduled
    </span>
  {:else if live && state !== "published"}
    <span
      class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30"
      title={pending ? "A published version is live; these edits aren't published yet" : "Live on the site"}
    >
      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>Live
    </span>
  {/if}
</span>
