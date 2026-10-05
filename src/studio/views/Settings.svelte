<script lang="ts">
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import { api } from "../api";
  import { dateTime, relTime } from "../format";
  import { isChief, session, toast, toastError } from "../state.svelte";
  import { deploys, refreshDeploys } from "../deploys.svelte";

  type Feature = "chat" | "summary" | "search" | "recommend" | "compare" | "askReview" | "comments" | "liveFallback";
  interface Guards {
    settings: {
      mode: "auto" | "normal" | "conserve" | "essential";
      autoLevel: number;
      dailyLimit: number;
      thresholds: { conserve: number; essential: number };
      liveFallbackMinutes: number;
      features: Record<Feature, boolean>;
      caps: Record<Feature, number>;
      usage?: { day: string; total: number; byScript: Record<string, number>; checkedAt: number; error?: string };
    };
    level: number;
    today: Record<string, number>;
    integrations: Record<string, boolean>;
    env: string;
  }

  let g = $state<Guards | null>(null);
  let draft = $state<Guards["settings"] | null>(null);
  let index = $state<{ indexed: number; chunks: number; pending: number; lastIndexedAt: number | null } | null>(null);
  let saving = $state(false);
  let checking = $state(false);
  let indexing = $state(false);
  let rebuilding = $state(false);

  const FEATURES: { key: Feature; label: string; text: string; offAt: number }[] = [
    { key: "liveFallback", label: "Live fallback", text: "Shows a just-published article before its build lands.", offAt: 1 },
    { key: "chat", label: "AI chat", text: "The site-wide chatbot.", offAt: 2 },
    { key: "search", label: "Search", text: "Full-text + semantic search (and game lookup for the AI tools).", offAt: 2 },
    { key: "summary", label: "AI summary", text: "“See AI Summary” on articles (cached per article).", offAt: 2 },
    { key: "askReview", label: "Ask this review", text: "Questions about a single article.", offAt: 2 },
    { key: "comments", label: "Comments", text: "Loading and posting reader comments (Google sign-in).", offAt: 2 },
    { key: "recommend", label: "Recommender", text: "/ai/recommend", offAt: 1 },
    { key: "compare", label: "Comparator", text: "/ai/compare", offAt: 1 },
  ];
  const MODES = [
    { key: "auto", label: "Automatic", text: "The watchdog steps down near the free limit and back up after the daily reset." },
    { key: "normal", label: "Everything on", text: "Ignore the watchdog." },
    { key: "conserve", label: "Conserve", text: "Live fallback, recommender and comparator off." },
    { key: "essential", label: "Essential only", text: "All live features off. Built pages and the studio keep working." },
  ] as const;
  const INTEGRATIONS: { key: string; label: string; how: string }[] = [
    { key: "github", label: "GitHub (publishing)", how: "Worker secret GITHUB_TOKEN — fine-grained token with Contents and Actions read/write on the repo." },
    { key: "analytics", label: "Cloudflare analytics (watchdog)", how: "Worker secret CF_ANALYTICS_TOKEN — API token with Account Analytics: Read." },
    { key: "google", label: "Google sign-in", how: "Worker secrets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." },
    { key: "openrouter", label: "OpenRouter (AI)", how: "Worker secret OPENROUTER_API_KEY." },
    { key: "rawg", label: "RAWG (game data)", how: "Worker secret RAWG_API_KEY." },
    { key: "alerts", label: "Usage alerts", how: "Optional Worker secret ALERT_WEBHOOK_URL (Discord or Slack webhook)." },
  ];

  async function load() {
    try {
      g = await api.get<Guards>("/guards");
      draft = structuredClone($state.snapshot(g.settings));
      index = await api.get("/index");
    } catch (e) {
      toastError(e);
    }
  }
  onMount(() => {
    load();
    refreshDeploys();
    if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ behavior: "smooth" }), 300);
  });

  async function saveSettings() {
    if (!draft) return;
    saving = true;
    try {
      g = await api.put<Guards>("/guards", {
        mode: draft.mode,
        dailyLimit: draft.dailyLimit,
        thresholds: draft.thresholds,
        liveFallbackMinutes: draft.liveFallbackMinutes,
        features: draft.features,
        caps: draft.caps,
      });
      draft = structuredClone($state.snapshot(g.settings));
      toast("Site limits saved", "success");
    } catch (e) {
      toastError(e);
    } finally {
      saving = false;
    }
  }

  async function checkNow() {
    checking = true;
    try {
      g = await api.post<Guards>("/guards/check");
      draft = structuredClone($state.snapshot(g.settings));
    } catch (e) {
      toastError(e);
    } finally {
      checking = false;
    }
  }

  async function runIndex() {
    indexing = true;
    try {
      for (let i = 0; i < 200; i++) {
        const r = await api.post<{ remaining: number }>("/index/run");
        index = await api.get("/index");
        if (!r.remaining) break;
      }
      toast("Search index is up to date", "success");
    } catch (e) {
      toastError(e);
    } finally {
      indexing = false;
    }
  }

  async function rebuild() {
    rebuilding = true;
    try {
      await api.post("/deploys");
      toast("Rebuild started — about 2 minutes", "success");
      setTimeout(refreshDeploys, 5000);
    } catch (e) {
      toastError(e);
    } finally {
      rebuilding = false;
    }
  }

  let usage = $derived(g?.settings.usage);
  let pct = $derived(usage && g ? (usage.total / g.settings.dailyLimit) * 100 : 0);
  let changed = $derived(Boolean(g && draft && JSON.stringify(draft) !== JSON.stringify($state.snapshot(g.settings))));
  const levelName = ["Normal", "Conserve", "Essential only"];
  const chief = isChief();
</script>

<div class="mx-auto max-w-4xl px-4 py-8 sm:px-6">
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Site & limits</h1>
      <p class="mt-1 text-sm text-slate-500">Keeps PlayTested inside Cloudflare's free plan. Built pages never count — only live features do.</p>
    </div>
    {#if chief && changed}
      <button class="btn-primary" disabled={saving} onclick={saveSettings} in:fly={{ y: -6, duration: 150 }}>{saving ? "Saving…" : "Save changes"}</button>
    {/if}
  </div>

  {#if !g || !draft}
    <div class="space-y-4">{#each [1, 2, 3] as _}<div class="h-40 animate-pulse rounded-2xl bg-slate-200/60 dark:bg-slate-800"></div>{/each}</div>
  {:else}
    <div class="space-y-6">
      <!-- Usage -->
      <section class="card p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 class="font-semibold">Today's usage</h2>
            <p class="text-xs text-slate-500">Worker + Pages Functions requests across your whole Cloudflare account (resets 8 AM PH time).</p>
          </div>
          <div class="flex items-center gap-2">
            <span class="rounded-full px-2.5 py-1 text-xs font-semibold {g.level === 0 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : g.level === 1 ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'}">Mode: {levelName[g.level]}</span>
            {#if chief}<button class="btn-secondary !py-1 text-xs" disabled={checking} onclick={checkNow}>{checking ? "Checking…" : "Check now"}</button>{/if}
          </div>
        </div>
        {#if usage && !usage.error}
          <p class="mt-4 text-3xl font-bold tabular-nums">{usage.total.toLocaleString()} <span class="text-base font-medium text-slate-400">/ {g.settings.dailyLimit.toLocaleString()} ({pct.toFixed(1)}%)</span></p>
          <div class="relative mt-3 h-3 rounded-full bg-slate-100 dark:bg-slate-800">
            <div class="h-full rounded-full transition-all duration-700 {pct >= g.settings.thresholds.essential ? 'bg-rose-500' : pct >= g.settings.thresholds.conserve ? 'bg-amber-500' : 'bg-emerald-500'}" style="width: {Math.min(100, Math.max(pct, 0.5))}%"></div>
            <span class="absolute -top-1 h-5 w-0.5 bg-amber-500" style="left: {g.settings.thresholds.conserve}%" title="Conserve"></span>
            <span class="absolute -top-1 h-5 w-0.5 bg-rose-500" style="left: {g.settings.thresholds.essential}%" title="Essential only"></span>
          </div>
          <div class="mt-4 grid gap-1 text-xs sm:grid-cols-2">
            {#each Object.entries(usage.byScript).sort((a, b) => b[1] - a[1]) as [name, n]}
              <div class="flex justify-between rounded-lg bg-slate-50 px-3 py-1.5 dark:bg-slate-800/50"><span class="truncate text-slate-600 dark:text-slate-300">{name}</span><span class="tabular-nums font-medium">{n.toLocaleString()}</span></div>
            {/each}
          </div>
          <p class="mt-3 text-xs text-slate-500">Checked {relTime(usage.checkedAt)} · the watchdog runs every 10 minutes.</p>
        {:else}
          <p class="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{usage?.error ?? "No usage check has run yet."}</p>
        {/if}
      </section>

      <!-- Mode -->
      <section class="card p-6">
        <h2 class="font-semibold">Mode</h2>
        <div class="mt-4 grid gap-2 sm:grid-cols-2">
          {#each MODES as m}
            <label class="flex cursor-pointer gap-3 rounded-xl p-3 ring-1 transition {draft.mode === m.key ? 'bg-indigo-50 ring-indigo-300 dark:bg-indigo-500/10 dark:ring-indigo-500/40' : 'ring-slate-200 hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800/50'}">
              <input type="radio" name="mode" class="mt-0.5 text-indigo-600 focus:ring-indigo-500" value={m.key} disabled={!chief} bind:group={draft.mode} />
              <span><span class="block text-sm font-medium">{m.label}</span><span class="block text-xs text-slate-500">{m.text}</span></span>
            </label>
          {/each}
        </div>
        <div class="mt-4 grid gap-4 sm:grid-cols-3">
          <div><label class="label" for="th-c">Conserve at %</label><input id="th-c" class="input" type="number" min="5" max="99" disabled={!chief} bind:value={draft.thresholds.conserve} /></div>
          <div><label class="label" for="th-e">Essential at %</label><input id="th-e" class="input" type="number" min="6" max="100" disabled={!chief} bind:value={draft.thresholds.essential} /></div>
          <div><label class="label" for="lim">Daily limit</label><input id="lim" class="input" type="number" min="1000" step="1000" disabled={!chief} bind:value={draft.dailyLimit} /></div>
        </div>
      </section>

      <!-- Features -->
      <section class="card p-6">
        <h2 class="font-semibold">Live features</h2>
        <p class="text-xs text-slate-500">Each has an on/off switch and a daily cap (0 = no cap). Counts are today's.</p>
        <ul class="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
          {#each FEATURES as f}
            <li class="flex flex-wrap items-center gap-4 py-3">
              <label class="flex min-w-[220px] flex-1 cursor-pointer items-center gap-3">
                <input type="checkbox" class="h-5 w-9 cursor-pointer appearance-none rounded-full bg-slate-300 transition before:block before:h-4 before:w-4 before:translate-x-0.5 before:rounded-full before:bg-white before:shadow before:transition checked:bg-indigo-600 checked:before:translate-x-[18px] dark:bg-slate-600" disabled={!chief} bind:checked={draft.features[f.key]} />
                <span>
                  <span class="block text-sm font-medium">{f.label} {#if g.level >= f.offAt && draft.features[f.key]}<span class="ml-1 text-[11px] font-semibold text-amber-600">paused by mode</span>{/if}</span>
                  <span class="block text-xs text-slate-500">{f.text}</span>
                </span>
              </label>
              {#if f.key === "liveFallback"}
                <div class="flex items-center gap-2 text-xs"><span class="text-slate-500">for</span><input class="input !w-20 !py-1" type="number" min="0" max="1440" disabled={!chief} bind:value={draft.liveFallbackMinutes} /><span class="text-slate-500">min</span></div>
              {:else}
                <div class="flex items-center gap-2 text-xs">
                  <span class="tabular-nums text-slate-500">{(g.today[`feature:${f.key}`] ?? 0).toLocaleString()} today · cap</span>
                  <input class="input !w-24 !py-1" type="number" min="0" disabled={!chief} bind:value={draft.caps[f.key]} />
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </section>

      <!-- Deploys -->
      <section id="deploys" class="card p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 class="font-semibold">Site builds</h2>
            <p class="text-xs text-slate-500">
              {#if deploys.build}Live build: <span class="font-mono">{deploys.build.commit?.slice(0, 7) ?? "?"}</span>, built {relTime(deploys.build.builtAt)} ({dateTime(deploys.build.builtAt)}){:else}No build info yet.{/if}
            </p>
          </div>
          {#if chief && deploys.github}<button class="btn-secondary !py-1 text-xs" disabled={rebuilding} onclick={rebuild}>Rebuild now</button>{/if}
        </div>
        {#if !deploys.github}
          <p class="mt-3 text-sm text-slate-500">Connect GitHub to see builds here.</p>
        {:else if deploys.runsError}
          <p class="mt-3 text-sm text-rose-600">{deploys.runsError}</p>
        {:else}
          <ul class="mt-3 divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {#each deploys.runs as r (r.id)}
              <li class="flex items-center gap-3 py-2">
                <span class="h-2 w-2 rounded-full {r.status !== 'completed' ? 'bg-amber-500 animate-pulse' : r.conclusion === 'success' ? 'bg-emerald-500' : 'bg-rose-500'}"></span>
                <a class="flex-1 truncate hover:text-indigo-600" href={r.html_url} target="_blank" rel="noopener">{r.display_title}</a>
                <span class="text-xs text-slate-500">{r.status !== "completed" ? r.status.replace("_", " ") : r.conclusion} · {relTime(Date.parse(r.created_at))}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- Search index -->
      <section class="card p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 class="font-semibold">Search index</h2>
            <p class="text-xs text-slate-500">
              {#if index}{index.indexed.toLocaleString()} articles · {index.chunks.toLocaleString()} passages · {index.pending} waiting · last indexed {relTime(index.lastIndexedAt)}{/if}
            </p>
          </div>
          {#if chief && index?.pending}<button class="btn-secondary !py-1 text-xs" disabled={indexing} onclick={runIndex}>{indexing ? "Indexing…" : "Index now"}</button>{/if}
        </div>
        <p class="mt-2 text-xs text-slate-500">Published articles are indexed immediately; anything changed in git is picked up by the 10-minute job.</p>
      </section>

      <!-- Integrations -->
      <section id="integrations" class="card p-6">
        <h2 class="font-semibold">Integrations</h2>
        <ul class="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
          {#each INTEGRATIONS as i}
            <li class="flex items-start gap-3 py-2.5">
              <span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold {g.integrations[i.key] ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}">{g.integrations[i.key] ? "✓" : "–"}</span>
              <div>
                <p class="text-sm font-medium">{i.label}</p>
                {#if !g.integrations[i.key]}<p class="text-xs text-slate-500">{i.how}</p>{/if}
              </div>
            </li>
          {/each}
        </ul>
        <p class="mt-3 text-xs text-slate-500">Environment: <span class="font-semibold">{session.env}</span></p>
      </section>
    </div>
  {/if}
</div>
