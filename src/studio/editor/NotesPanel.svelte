<script lang="ts">
  import { fly, slide } from "svelte/transition";
  import { api, type ArticleDetail, type Note } from "../api";
  import { relTime } from "../format";
  import { session, toastError } from "../state.svelte";

  let {
    articleId,
    notes,
    onupdate,
    onclose,
  }: { articleId: string; notes: Note[]; onupdate: (d: ArticleDetail) => void; onclose: () => void } = $props();

  let text = $state("");
  let busy = $state(false);
  let showResolved = $state(false);
  let visible = $derived(notes.filter((n) => showResolved || !n.resolvedAt));

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    busy = true;
    try {
      onupdate(await api.post<ArticleDetail>(`/articles/${articleId}/notes`, { text }));
      text = "";
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
    }
  }

  async function resolve(n: Note) {
    try {
      onupdate(await api.post<ArticleDetail>(`/notes/${n.id}/resolve`));
    } catch (err) {
      toastError(err);
    }
  }
</script>

<aside class="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col bg-white shadow-2xl ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10" transition:fly={{ x: 400, duration: 220 }}>
  <header class="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
    <div>
      <h2 class="font-semibold">Review notes</h2>
      <p class="text-xs text-slate-500">Feedback between editors. Notes never appear on the site.</p>
    </div>
    <button class="btn-ghost !p-2" aria-label="Close" onclick={onclose}>✕</button>
  </header>
  <div class="flex-1 space-y-3 overflow-y-auto p-5">
    {#if !visible.length}
      <p class="py-8 text-center text-sm text-slate-500">No open notes.</p>
    {/if}
    {#each visible as n (n.id)}
      <div class="rounded-xl p-3 text-sm {n.resolvedAt ? 'bg-slate-50 opacity-60 dark:bg-slate-800/40' : 'bg-amber-50/70 ring-1 ring-amber-200/70 dark:bg-amber-500/5 dark:ring-amber-500/20'}" transition:slide={{ duration: 150 }}>
        <div class="mb-1 flex items-center justify-between gap-2">
          <p class="text-xs font-semibold">{n.userName ?? "Someone"} <span class="font-normal text-slate-500">· {relTime(n.createdAt)}</span></p>
          {#if !n.resolvedAt && (session.user?.role === "chief" || session.user?.id === n.userId)}
            <button class="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400" onclick={() => resolve(n)}>Resolve</button>
          {/if}
        </div>
        <p class="whitespace-pre-wrap leading-relaxed text-slate-700 dark:text-slate-200">{n.body}</p>
      </div>
    {/each}
    {#if notes.some((n) => n.resolvedAt)}
      <button class="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200" onclick={() => (showResolved = !showResolved)}>{showResolved ? "Hide" : "Show"} resolved notes</button>
    {/if}
  </div>
  <form class="border-t border-slate-100 p-4 dark:border-slate-800" onsubmit={add}>
    <textarea class="input min-h-[80px]" placeholder="Leave a note for the team…" bind:value={text}></textarea>
    <div class="mt-2 flex justify-end"><button class="btn-primary" disabled={busy || !text.trim()}>Add note</button></div>
  </form>
</aside>
