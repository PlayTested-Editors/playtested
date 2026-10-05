<script lang="ts">
  import type { Snippet } from "svelte";
  import { fade, fly } from "svelte/transition";

  let {
    open = $bindable(false),
    title,
    size = "md",
    children,
    footer,
    onclose,
  }: {
    open?: boolean;
    title: string;
    size?: "sm" | "md" | "lg" | "xl";
    children: Snippet;
    footer?: Snippet;
    onclose?: () => void;
  } = $props();

  const widths = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-5xl" };

  function close() {
    open = false;
    onclose?.();
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === "Escape" && close()} />

{#if open}
  <div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
    <button
      class="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px] cursor-default"
      aria-label="Close"
      onclick={close}
      transition:fade={{ duration: 150 }}
    ></button>
    <div
      class="relative w-full {widths[size]} max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-white dark:bg-slate-900 shadow-2xl ring-1 ring-slate-900/5 dark:ring-white/10"
      transition:fly={{ y: 24, duration: 200 }}
    >
      <header class="flex items-center justify-between gap-4 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
        <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        <button
          class="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100 transition-colors"
          aria-label="Close"
          onclick={close}
        >
          <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
        </button>
      </header>
      <div class="flex-1 overflow-y-auto px-5 py-4">
        {@render children()}
      </div>
      {#if footer}
        <footer class="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 rounded-b-2xl">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}
