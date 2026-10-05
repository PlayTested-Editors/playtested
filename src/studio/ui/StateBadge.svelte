<script lang="ts">
  import type { ArticleState } from "../api";
  import { STATE_LABEL, STATE_STYLE } from "../format";

  let { state, live = false, pending = false }: { state: ArticleState; live?: boolean; pending?: boolean } = $props();
</script>

<span class="inline-flex items-center gap-1.5">
  <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset {STATE_STYLE[state]}">
    {STATE_LABEL[state]}
  </span>
  {#if live && state !== "published"}
    <span
      class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30"
      title={pending ? "A published version is live; these edits aren't published yet" : "Live on the site"}
    >
      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>Live
    </span>
  {/if}
</span>
