<script lang="ts" module>
  // Open modals, innermost last: Escape and the focus trap act on the top one only.
  const stack: symbol[] = [];
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { tick } from "svelte";
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

  const id = Symbol("modal");
  let panel = $state<HTMLDivElement>();
  const isTop = () => stack[stack.length - 1] === id;

  function close() {
    open = false;
    onclose?.();
  }

  // On open: join the stack and move focus inside. On close: leave it and give
  // focus back to whatever opened the dialog.
  $effect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    stack.push(id);
    tick().then(() => {
      if (!panel || !isTop() || panel.contains(document.activeElement)) return;
      const body = panel.querySelector<HTMLElement>("[data-modal-body]");
      const target = body?.querySelector<HTMLElement>("[autofocus]") ?? body?.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
      target.focus({ preventScroll: true });
    });
    return () => {
      const i = stack.indexOf(id);
      if (i > -1) stack.splice(i, 1);
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body || panel?.contains(document.activeElement))) {
        opener.focus({ preventScroll: true });
      }
    };
  });

  function onkeydown(e: KeyboardEvent) {
    if (!open || !isTop()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab" && panel) {
      // Keep Tab inside the dialog.
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!panel.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
</script>

<svelte:window {onkeydown} />

{#if open}
  <div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
    <button
      class="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px] cursor-default"
      tabindex="-1"
      aria-label="Close"
      onclick={close}
      transition:fade={{ duration: 150 }}
    ></button>
    <div
      class="relative w-full {widths[size]} max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-white dark:bg-slate-900 shadow-2xl ring-1 ring-slate-900/5 dark:ring-white/10 focus:outline-none"
      bind:this={panel}
      tabindex="-1"
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
      <div class="flex-1 overflow-y-auto px-5 py-4" data-modal-body>
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
