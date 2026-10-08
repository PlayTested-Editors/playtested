<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { api, type ArticleSummary } from "../api";
  import { navigate, refreshCounts, route, toast, toastError } from "../state.svelte";
  import Modal from "../ui/Modal.svelte";
  import { relTime, dateTime } from "../format";
  import StateBadge from "../ui/StateBadge.svelte";

  const TABS = [
    ["", "All"],
    ["draft", "Drafts"],
    ["in_review", "In review"],
    ["changes_requested", "Changes requested"],
    ["approved", "Approved"],
    ["pending", "Unpublished edits"],
    ["scheduled", "Scheduled"],
    ["published", "Published"],
  ] as const;

  let data = $state<{ articles: ArticleSummary[]; names: Record<string, string>; total: number | null; hasMore: boolean; page: number; pageSize: number; counts: Record<string, number> } | null>(null);
  let categories = $state<{ value: string; count: number }[]>([]);
  let loading = $state(false);
  let q = $state(route.query.get("q") || "");
  let searchTimer: ReturnType<typeof setTimeout>;

  let articleState = $derived(route.query.get("state") || "");
  let category = $derived(route.query.get("category") || "");
  let sort = $derived(route.query.get("sort") || "updated");
  let page = $derived(Number(route.query.get("page")) || 1);
  let mine = $derived(route.query.get("mine") === "1");

  function setParam(patch: Record<string, string | null>) {
    const p = new URLSearchParams(route.query);
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    if (!("page" in patch)) p.delete("page");
    const qs = p.toString();
    navigate(`/studio/articles/${qs ? `?${qs}` : ""}`, true);
  }

  $effect(() => {
    const qs = route.query.toString();
    load(qs);
  });

  // Keep the search box in step with the URL (back/forward, the sidebar link),
  // except while the user is typing a search that hasn't been applied yet.
  $effect(() => {
    const urlQ = route.query.get("q") || "";
    untrack(() => {
      if (q.trim() !== urlQ) {
        clearTimeout(searchTimer);
        q = urlQ;
      }
    });
  });

  // Only the latest request may write `data`: a slow earlier response must not
  // replace newer results.
  let requestSeq = 0;
  // Dim the list only when a load is slow enough to notice; a quick refresh
  // that dims and undims reads as a flicker.
  let dimTimer: ReturnType<typeof setTimeout> | undefined;
  async function load(qs: string) {
    const seq = ++requestSeq;
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => seq === requestSeq && (loading = true), 300);
    try {
      const d = await api.get<NonNullable<typeof data>>(`/articles?pageSize=30&${qs}`);
      if (seq === requestSeq) data = d;
    } catch (e) {
      if (seq === requestSeq) toastError(e);
    } finally {
      if (seq === requestSeq) {
        clearTimeout(dimTimer);
        loading = false;
      }
    }
  }

  onMount(() => {
    api.get<{ categories: { value: string; count: number }[] }>("/meta").then((m) => (categories = m.categories)).catch(() => undefined);
  });

  let creating = $state(false);
  async function createNew() {
    if (creating) return;
    creating = true;
    try {
      const d = await api.post<{ article: { id: string } }>("/articles", { data: {} });
      navigate(`/studio/articles/${d.article.id}/`);
    } catch (e) {
      toastError(e);
    } finally {
      creating = false;
    }
  }


  // Your own never-published drafts can be deleted from the list (the chief: anything
  // not live). The server decides per row (`canDelete`) and checks again on delete.
  let toDelete = $state<ArticleSummary | null>(null);
  let deleting = $state(false);
  const canDelete = (a: ArticleSummary) => Boolean(a.canDelete);
  async function confirmDelete() {
    const a = toDelete;
    if (!a || !data) return;
    deleting = true;
    try {
      await api.del(`/articles/${a.id}`);
      data.articles = data.articles.filter((x) => x.id !== a.id);
      refreshCounts();
      toast("Draft deleted", "success");
      toDelete = null;
    } catch (e) {
      toastError(e);
    } finally {
      deleting = false;
    }
  }
</script>

<div class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
  <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
    <h1 class="text-2xl font-bold tracking-tight">Articles</h1>
    <button class="btn-primary" disabled={creating} onclick={createNew}>New article</button>
  </div>

  <div class="-mx-4 mb-4 overflow-x-auto px-4">
    <div class="flex w-max gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-900">
      {#each TABS as [key, label]}
        {@const count = key === "" ? null : data?.counts?.[key]}
        <button
          class="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition {articleState === key ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}"
          onclick={() => setParam({ state: key || null })}
        >
          {label}{#if count}<span class="ml-1.5 text-xs text-slate-400">{count}</span>{/if}
        </button>
      {/each}
    </div>
  </div>

  <div class="mb-4 flex flex-wrap gap-2">
    <div class="relative min-w-[220px] flex-1">
      <svg class="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clip-rule="evenodd" /></svg>
      <input
        class="input pl-9"
        placeholder="Search titles…"
        bind:value={q}
        oninput={() => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => setParam({ q: q.trim() || null }), 300);
        }}
      />
    </div>
    <select class="input w-auto" value={category} onchange={(e) => setParam({ category: e.currentTarget.value || null })}>
      <option value="">All categories</option>
      {#each categories as c}<option value={c.value}>{c.value} ({c.count})</option>{/each}
    </select>
    <select class="input w-auto" value={sort} onchange={(e) => setParam({ sort: e.currentTarget.value })}>
      <option value="updated">Recently edited</option>
      <option value="pub">Publish date</option>
      <option value="title">Title A–Z</option>
      <option value="score">Score</option>
    </select>
    <label class="flex items-center gap-2 rounded-lg px-3 text-sm text-slate-600 dark:text-slate-300">
      <input type="checkbox" class="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" checked={mine} onchange={(e) => setParam({ mine: e.currentTarget.checked ? "1" : null })} />
      Mine only
    </label>
  </div>

  <div class="card overflow-hidden">
    {#if !data}
      <div class="relative space-y-px" aria-busy="true">
        {#each Array(8) as _}<div class="h-16 bg-slate-50 dark:bg-slate-800/40"></div>{/each}
        <p class="absolute inset-x-0 top-6 text-center text-sm text-slate-400" role="status">Loading articles…</p>
      </div>
    {:else if !data.articles.length}
      <div class="px-6 py-16 text-center">
        <p class="text-sm text-slate-500">No articles match.</p>
      </div>
    {:else}
      <ul class="divide-y divide-slate-100 dark:divide-slate-800 transition-opacity {loading ? 'opacity-60' : ''}">
        {#each data.articles as a (a.id)}
          <li class="flex items-center transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
            <a href={`/studio/articles/${a.id}/`} class="group flex min-w-0 flex-1 items-center gap-4 px-4 py-3">
              <div class="h-12 w-20 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800">
                {#if a.thumb}<img src={a.thumb} alt="" loading="lazy" class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />{/if}
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-semibold text-slate-900 group-hover:text-indigo-600 dark:text-slate-100 dark:group-hover:text-indigo-400">{a.title || "Untitled"}</p>
                <p class="mt-0.5 truncate text-xs text-slate-500">
                  {a.category ?? "—"} · {a.author ?? "—"} · {sort === "pub" ? dateTime(a.pubDate) : `edited ${relTime(a.updatedAt)}${data.names[a.updatedBy ?? ""] ? ` by ${data.names[a.updatedBy ?? ""]}` : ""}`}
                </p>
              </div>
              {#if a.score !== null}
                <span class="hidden sm:inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-xs font-bold text-white dark:bg-slate-700">{a.score}</span>
              {/if}
              <div class="hidden md:block"><StateBadge state={a.state} live={a.isLive} pending={a.hasPendingChanges} /></div>
            </a>
            {#if canDelete(a)}
              <button
                type="button"
                class="mr-2 rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                title="Delete draft"
                aria-label={`Delete draft: ${a.title || "Untitled"}`}
                onclick={() => (toDelete = a)}
              >
                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if data && (page > 1 || data.hasMore)}
    <div class="mt-4 flex items-center justify-between text-sm">
      <p class="text-slate-500">{data.total !== null ? `${data.total.toLocaleString()} articles · ` : ""}page {page}</p>
      <div class="flex gap-2">
        <button class="btn-secondary" disabled={page <= 1} onclick={() => setParam({ page: String(page - 1) })}>Previous</button>
        <button class="btn-secondary" disabled={!data.hasMore} onclick={() => setParam({ page: String(page + 1) })}>Next</button>
      </div>
    </div>
  {/if}
</div>

<Modal open={toDelete !== null} title="Delete draft?" size="sm" onclose={() => (toDelete = null)}>
  <p class="text-sm text-slate-600 dark:text-slate-300">
    <b>{toDelete?.title || "Untitled"}</b> will be deleted with its history and notes. It can't be undone.
    {toDelete?.wasPublished ? "It isn't on the site now (it was unpublished)." : "It was never published, so nothing changes on the site."}
    Uploaded images stay in the Media library.
  </p>
  {#snippet footer()}
    <button class="btn-secondary" onclick={() => (toDelete = null)}>Cancel</button>
    <button class="btn-danger" disabled={deleting} onclick={confirmDelete}>{deleting ? "Deleting…" : "Delete"}</button>
  {/snippet}
</Modal>
