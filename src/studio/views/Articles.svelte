<script lang="ts">
  import { fade } from "svelte/transition";
  import { api, type ArticleSummary } from "../api";
  import { navigate, route, toastError } from "../state.svelte";
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

  let data = $state<{ articles: ArticleSummary[]; names: Record<string, string>; total: number; page: number; pageSize: number; counts: Record<string, number> } | null>(null);
  let categories = $state<{ value: string; count: number }[]>([]);
  let loading = $state(false);
  let q = $state(route.query.get("q") || "");
  let searchTimer: ReturnType<typeof setTimeout>;

  let state = $derived(route.query.get("state") || "");
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

  async function load(qs: string) {
    loading = true;
    try {
      data = await api.get(`/articles?pageSize=30&${qs}`);
    } catch (e) {
      toastError(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    api.get<{ categories: { value: string; count: number }[] }>("/meta").then((m) => (categories = m.categories)).catch(() => undefined);
  });

  async function createNew() {
    try {
      const d = await api.post<{ article: { id: string } }>("/articles", { data: {} });
      navigate(`/studio/articles/${d.article.id}/`);
    } catch (e) {
      toastError(e);
    }
  }

  let pages = $derived(data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1);
</script>

<div class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
  <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
    <h1 class="text-2xl font-bold tracking-tight">Articles</h1>
    <button class="btn-primary" onclick={createNew}>New article</button>
  </div>

  <div class="-mx-4 mb-4 overflow-x-auto px-4">
    <div class="flex w-max gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-900">
      {#each TABS as [key, label]}
        {@const count = key === "" ? null : data?.counts?.[key]}
        <button
          class="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition {state === key ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}"
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
      <div class="space-y-px">{#each Array(8) as _}<div class="h-16 animate-pulse bg-slate-50 dark:bg-slate-800/50"></div>{/each}</div>
    {:else if !data.articles.length}
      <div class="px-6 py-16 text-center">
        <p class="text-sm text-slate-500">No articles match.</p>
      </div>
    {:else}
      <ul class="divide-y divide-slate-100 dark:divide-slate-800 transition-opacity {loading ? 'opacity-60' : ''}">
        {#each data.articles as a (a.id)}
          <li in:fade={{ duration: 120 }}>
            <a href={`/studio/articles/${a.id}/`} class="group flex items-center gap-4 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/50">
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
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if data && pages > 1}
    <div class="mt-4 flex items-center justify-between text-sm">
      <p class="text-slate-500">{data.total.toLocaleString()} articles · page {page} of {pages}</p>
      <div class="flex gap-2">
        <button class="btn-secondary" disabled={page <= 1} onclick={() => setParam({ page: String(page - 1) })}>Previous</button>
        <button class="btn-secondary" disabled={page >= pages} onclick={() => setParam({ page: String(page + 1) })}>Next</button>
      </div>
    </div>
  {/if}
</div>
