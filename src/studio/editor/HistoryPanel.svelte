<script lang="ts">
  import { diffWords } from "diff";
  import { untrack } from "svelte";
  import { fly } from "svelte/transition";
  import { api, type ArticleData, type Revision } from "../api";
  import { KIND_LABEL, dateTime, relTime } from "../format";
  import { toastError } from "../state.svelte";

  let {
    articleId,
    current,
    live = null,
    liveAt = null,
    startWithLive = false,
    canRestore,
    onrestore,
    onclose,
  }: {
    articleId: string;
    current: ArticleData;
    /** The version readers see now, to compare the working copy with. */
    live?: ArticleData | null;
    liveAt?: number | null;
    /** Open straight on the comparison with the live version. */
    startWithLive?: boolean;
    canRestore: boolean;
    onrestore: (revisionId: number) => Promise<void>;
    onclose: () => void;
  } = $props();

  /** `id` -1 is the live version (not a stored revision: compare only, no restore). */
  const LIVE_ID = -1;
  let revisions = $state<Revision[] | null>(null);
  let selected = $state<{ id: number; data: ArticleData; kind: string; createdAt: number } | null>(
    untrack(() => (startWithLive && live ? { id: LIVE_ID, data: live, kind: "live", createdAt: liveAt ?? 0 } : null)),
  );
  let restoring = $state(false);

  function openLive() {
    if (live) selected = { id: LIVE_ID, data: live, kind: "live", createdAt: liveAt ?? 0 };
  }

  $effect(() => {
    void articleId;
    api
      .get<{ revisions: Revision[] }>(`/articles/${articleId}/revisions`)
      .then((r) => (revisions = r.revisions))
      .catch(toastError);
  });

  async function open(r: Revision) {
    try {
      selected = await api.get(`/revisions/${r.id}`);
    } catch (e) {
      toastError(e);
    }
  }

  const FIELDS: [keyof ArticleData, string][] = [
    ["title", "Title"],
    ["slug", "Slug"],
    ["description", "Description"],
    ["category", "Category"],
    ["tags", "Tags"],
    ["score", "Score"],
    ["author", "Byline"],
    ["pubDate", "Publish date"],
    ["featured", "Featured"],
    ["thumb", "Thumbnail"],
    ["large", "Hero image"],
    ["gallery", "Gallery"],
    ["game", "Game"],
  ];
  const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") || "—" : v === null || v === undefined || v === "" ? "—" : String(v));

  let fieldChanges = $derived(
    selected ? FIELDS.filter(([k]) => JSON.stringify(selected!.data[k] ?? null) !== JSON.stringify(current[k] ?? null)) : [],
  );
  let bodyDiff = $derived(selected && selected.data.body !== current.body ? diffWords(selected.data.body, current.body) : []);
</script>

<aside class="fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl flex-col bg-white shadow-2xl ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10" transition:fly={{ x: 400, duration: 220 }}>
  <header class="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
    <div>
      <h2 class="font-semibold">
        {selected
          ? selected.id === LIVE_ID
            ? "Compare with the live version"
            : `Compare with ${KIND_LABEL[selected.kind]?.toLowerCase() ?? selected.kind} · ${dateTime(selected.createdAt)}`
          : "History"}
      </h2>
      <p class="text-xs text-slate-500">
        {selected
          ? selected.id === LIVE_ID
            ? "Red is what readers see now, green is the working copy."
            : "Red is in that version, green is in your current draft."
          : "Every save, review step and publish is kept."}
      </p>
    </div>
    <div class="flex gap-2">
      {#if selected}
        <button class="btn-ghost" onclick={() => (selected = null)}>← Back</button>
        {#if canRestore && selected.id !== LIVE_ID}
          <button
            class="btn-primary"
            disabled={restoring}
            onclick={async () => {
              restoring = true;
              await onrestore(selected!.id);
              restoring = false;
              selected = null;
            }}>Restore this version</button
          >
        {/if}
      {/if}
      <button class="btn-ghost !p-2" aria-label="Close" onclick={onclose}>✕</button>
    </div>
  </header>
  <div class="flex-1 overflow-y-auto">
    {#if !selected}
      {#if !revisions}
        <p class="p-6 text-sm text-slate-500">Loading…</p>
      {:else}
        {#if live}
          <div class="px-5 pt-4">
            <button class="btn-secondary w-full" onclick={openLive}>Compare the working copy with the live version</button>
          </div>
        {/if}
        <ol class="relative px-5 py-4">
          {#each revisions as r (r.id)}
            <li class="relative flex gap-4 pb-5 pl-6 before:absolute before:left-[7px] before:top-3 before:h-full before:w-px before:bg-slate-200 last:before:hidden dark:before:bg-slate-700">
              <span class="absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full ring-4 ring-white dark:ring-slate-900 {r.kind === 'publish' ? 'bg-emerald-500' : r.kind === 'request_changes' ? 'bg-rose-500' : r.kind === 'submit' || r.kind === 'approve' ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600'}"></span>
              <button class="flex-1 rounded-lg p-2 -m-2 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60" onclick={() => open(r)}>
                <p class="text-sm font-medium">{KIND_LABEL[r.kind] ?? r.kind}{r.note && r.kind !== "publish" ? ` — ${r.note}` : ""}</p>
                <p class="text-xs text-slate-500">{r.userName ?? "Unknown"} · {relTime(r.createdAt)} · {dateTime(r.createdAt)}</p>
              </button>
            </li>
          {/each}
        </ol>
      {/if}
    {:else}
      <div class="space-y-5 p-5">
        {#if !fieldChanges.length && !bodyDiff.length}
          <p class="text-sm text-slate-500">{selected.id === LIVE_ID ? "The working copy is identical to the live version." : "This version is identical to your current draft."}</p>
        {/if}
        {#if fieldChanges.length}
          <table class="w-full text-sm">
            <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
              {#each fieldChanges as [k, label]}
                <tr>
                  <td class="w-28 py-2 pr-3 align-top text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</td>
                  <td class="py-2 align-top"><span class="rounded bg-rose-50 px-1 text-rose-700 line-through decoration-rose-300 dark:bg-rose-500/10 dark:text-rose-300">{show(selected.data[k])}</span></td>
                  <td class="py-2 pl-2 align-top"><span class="rounded bg-emerald-50 px-1 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{show(current[k])}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
        {#if bodyDiff.length}
          <div>
            <p class="label">Article body</p>
            <div class="whitespace-pre-wrap rounded-xl bg-slate-50 p-4 font-[ui-serif,Georgia,serif] text-[15px] leading-7 dark:bg-slate-800/50">
              {#each bodyDiff as part}
                {#if part.added}<ins class="rounded bg-emerald-100 text-emerald-900 no-underline dark:bg-emerald-500/20 dark:text-emerald-200">{part.value}</ins>{:else if part.removed}<del class="rounded bg-rose-100 text-rose-900 dark:bg-rose-500/20 dark:text-rose-200">{part.value}</del>{:else}<span class="text-slate-500 dark:text-slate-400">{part.value.length > 400 ? `${part.value.slice(0, 160)} … ${part.value.slice(-160)}` : part.value}</span>{/if}
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</aside>
