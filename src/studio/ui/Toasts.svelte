<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { toasts } from "../state.svelte";

  const tone = {
    success: "bg-emerald-600 text-white",
    error: "bg-rose-600 text-white",
    info: "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900",
  };
</script>

<div class="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,380px)] flex-col gap-2" aria-live="polite">
  {#each toasts as t (t.id)}
    <div
      class="pointer-events-auto flex items-start gap-3 rounded-xl px-4 py-3 text-sm shadow-lg {tone[t.kind]}"
      in:fly={{ y: 16, duration: 200 }}
      out:fly={{ x: 40, duration: 180 }}
      animate:flip={{ duration: 200 }}
    >
      <p class="flex-1 leading-snug">{t.message}</p>
      {#if t.action}
        <a class="shrink-0 font-semibold underline underline-offset-2" href={t.action.href} target="_blank" rel="noopener">{t.action.label}</a>
      {/if}
    </div>
  {/each}
</div>
