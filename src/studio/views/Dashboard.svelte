<script lang="ts">
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import { api, type ArticleSummary } from "../api";
  import { isChief, isEditorOrAbove, session, toastError } from "../state.svelte";
  import { relTime, dateTime } from "../format";
  import StateBadge from "../ui/StateBadge.svelte";

  type List = { articles: ArticleSummary[]; names: Record<string, string>; total: number | null };
  let review = $state<List | null>(null);
  let changes = $state<List | null>(null);
  let mine = $state<List | null>(null);
  let scheduled = $state<List | null>(null);
  let recent = $state<List | null>(null);
  let guards = $state<{ settings: any; level: number; integrations: Record<string, boolean> } | null>(null);

  const EMPTY: List = { articles: [], names: {}, total: null };

  onMount(() => {
    // Each panel loads on its own: one failed request shows that panel empty
    // (plus one error toast) instead of leaving every panel loading forever.
    let reported = false;
    const q = (s: string, set: (l: List) => void) =>
      api
        .get<List>(`/articles?${s}`)
        .then(set)
        .catch((e) => {
          set(EMPTY);
          if (!reported) toastError(e);
          reported = true;
        });
    q("state=in_review&pageSize=8", (l) => (review = l));
    q(`state=changes_requested&pageSize=8${isChief() ? "" : "&mine=1"}`, (l) => (changes = l));
    q("mine=1&state=draft&pageSize=8", (l) => (mine = l));
    q("state=scheduled&sort=pub&pageSize=6", (l) => (scheduled = l));
    q("state=published&sort=pub&pageSize=6", (l) => (recent = l));
    if (isEditorOrAbove()) {
      api
        .get<any>("/guards")
        .then((g) => (guards = g))
        .catch(() => undefined);
    }
  });

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();

  // Show the quota closest to its limit (requests, D1 reads/writes, AI, KV).
  let worstMetric = $derived.by(() => {
    const u = guards?.settings?.usage;
    if (!u) return null;
    const key = u.worst?.key ?? "requests";
    return u.metrics?.[key] ?? { label: "Worker requests", used: u.total, limit: guards!.settings.dailyLimit };
  });
  let usagePct = $derived(worstMetric ? Math.min(100, (worstMetric.used / worstMetric.limit) * 100) : 0);
  let missing = $derived(guards ? Object.entries(guards.integrations).filter(([k, v]) => !v && ["github", "analytics", "google"].includes(k)).map(([k]) => k) : []);
  const levelText = ["Normal", "Conserve", "Essential only"];
</script>

{#snippet articleRow(a: ArticleSummary, names: Record<string, string>, showDate = false)}
  <li>
    <a href={`/studio/articles/${a.id}/`} class="group flex items-center gap-3 rounded-xl px-3 py-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/60">
      <div class="h-11 w-16 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800">
        {#if a.thumb}<img src={a.thumb} alt="" loading="lazy" class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />{/if}
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400">{a.title || "Untitled"}</p>
        <p class="truncate text-xs text-slate-500">
          {showDate ? dateTime(a.pubDate) : `${names[a.updatedBy ?? ""] ?? a.author ?? ""} · ${relTime(a.updatedAt)}`}
        </p>
      </div>
      <StateBadge state={a.state} live={a.isLive} pending={a.hasPendingChanges} />
    </a>
  </li>
{/snippet}

{#snippet panel(title: string, list: List | null, empty: string, href: string, showDate = false)}
  <section class="card p-2" in:fly={{ y: 12, duration: 250 }}>
    <header class="flex items-center justify-between px-3 py-2">
      <h2 class="text-sm font-semibold">{title} {#if list?.total}<span class="ml-1 text-slate-400">{list.total}</span>{/if}</h2>
      <a {href} class="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">View all</a>
    </header>
    {#if !list}
      <div class="space-y-2 p-3">{#each [1, 2, 3] as _}<div class="h-11 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800"></div>{/each}</div>
    {:else if !list.articles.length}
      <p class="px-3 pb-4 pt-1 text-sm text-slate-500">{empty}</p>
    {:else}
      <ul>{#each list.articles as a (a.id)}{@render articleRow(a, list.names, showDate)}{/each}</ul>
    {/if}
  </section>
{/snippet}

<div class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
  <div class="mb-8 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">{greeting}, {session.user?.name?.split(" ")[0]}</h1>
      <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {#if isChief() && review?.total}
          {review.total} article{review.total === 1 ? " is" : "s are"} waiting for your review.
        {:else}
          Here's what's happening on PlayTested.
        {/if}
      </p>
    </div>
    <a href="/studio/articles/new/" class="btn-primary">Write something new</a>
  </div>

  {#if missing.length && isChief()}
    <a href="/studio/settings/#integrations" class="mb-6 flex items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30">
      <span class="text-lg">⚙️</span>
      <span class="flex-1">Finish setup: connect <strong>{missing.join(", ")}</strong> so publishing, the usage watchdog and Google sign-in work.</span>
      <span class="font-semibold">Set up →</span>
    </a>
  {/if}

  <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
    <div class="min-w-0 space-y-6 lg:col-span-2">
      {@render panel(isChief() ? "Needs your review" : "In review", review, "Nothing waiting for review.", "/studio/articles/?state=in_review")}
      {@render panel("Changes requested", changes, "No changes requested.", "/studio/articles/?state=changes_requested")}
      {@render panel("My drafts", mine, "No drafts — start something new.", "/studio/articles/?state=draft&mine=1")}
    </div>
    <div class="min-w-0 space-y-6">
      {#if guards}
        <section class="card p-5" in:fly={{ y: 12, duration: 250 }}>
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold">Free-plan usage today</h2>
            <span class="rounded-full px-2 py-0.5 text-[11px] font-semibold {guards.level === 0 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : guards.level === 1 ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'}">{levelText[guards.level]}</span>
          </div>
          {#if guards.settings.usage && !guards.settings.usage.error}
            <p class="mt-3 text-xs font-medium text-slate-500">{worstMetric?.label} (closest to its limit)</p>
            <p class="text-2xl font-bold tabular-nums">{worstMetric?.used.toLocaleString()}<span class="text-sm font-medium text-slate-400"> / {worstMetric?.limit.toLocaleString()}</span></p>
            <div class="relative mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div class="h-full rounded-full transition-all duration-700 {usagePct >= guards.settings.thresholds.essential ? 'bg-rose-500' : usagePct >= guards.settings.thresholds.conserve ? 'bg-amber-500' : 'bg-emerald-500'}" style="width: {Math.max(usagePct, 1)}%"></div>
            </div>
            <p class="mt-2 text-xs text-slate-500">Across your whole Cloudflare account · checked {relTime(guards.settings.usage.checkedAt)} · <a class="text-indigo-600 hover:underline dark:text-indigo-400" href="/studio/settings/">all limits</a></p>
          {:else}
            <p class="mt-3 text-sm text-slate-500">{guards.settings.usage?.error ?? "Waiting for the first check (runs every 10 minutes)."}</p>
          {/if}
        </section>
      {/if}
      {@render panel("Scheduled", scheduled, "Nothing scheduled.", "/studio/articles/?state=scheduled", true)}
      {@render panel("Recently published", recent, "Nothing published yet.", "/studio/articles/?state=published&sort=pub", true)}
    </div>
  </div>
</div>
