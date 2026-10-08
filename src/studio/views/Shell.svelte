<script lang="ts">
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { api, getViewAs, setViewAs } from "../api";
  import { clearReturn, counts as countsSignal, loadSession, navigate, refreshCounts, route, session, toggleTheme, isEditorOrAbove } from "../state.svelte";
  import { deploys, latestRun, refreshDeploys, stopDeploys } from "../deploys.svelte";
  import { relTime } from "../format";

  let { children }: { children: Snippet } = $props();
  let counts = $state<Record<string, number>>({});
  let commentsHeld = $state(0);
  let mobileOpen = $state(false);
  let menuButton = $state<HTMLButtonElement>();
  let drawer = $state<HTMLElement>();
  // The editor gets the whole width (writing + live preview side by side).
  let focus = $derived(route.parts[0] === "articles" && Boolean(route.parts[1]) && route.parts[1] !== "new");

  async function loadCounts() {
    try {
      const r = await api.get<{ counts: Record<string, number> }>("/articles?pageSize=1");
      counts = r.counts;
      if (isEditorOrAbove()) {
        const c = await api.get<{ counts: Record<string, number> }>("/comments?status=pending");
        commentsHeld = c.counts.pending ?? 0;
      }
    } catch {
      /* ignore */
    }
  }

  onMount(() => {
    refreshDeploys();
    // Counts are cheap but not free; refresh every 5 minutes while visible.
    const t = setInterval(() => document.visibilityState === "visible" && loadCounts(), 300_000);
    return () => {
      clearInterval(t);
      stopDeploys();
    };
  });

  $effect(() => {
    // Refresh counts when moving between views (the path, not its ?filters)
    // or when a view asks (refreshCounts()). Also runs once on mount.
    void route.parts.join("/");
    void countsSignal.version;
    loadCounts();
    mobileOpen = false;
  });

  // Mobile drawer: focus moves into it on open and back to the menu button on close.
  $effect(() => {
    if (!mobileOpen) return;
    queueMicrotask(() => drawer?.querySelector<HTMLElement>("a[href], button")?.focus({ preventScroll: true }));
    return () => {
      if (!document.activeElement || document.activeElement === document.body || drawer?.contains(document.activeElement)) menuButton?.focus({ preventScroll: true });
    };
  });

  const nav = $derived([
    { href: "/studio/", label: "Dashboard", icon: "M2.25 12l8.954-8.955a1.126 1.126 0 0 1 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25", match: (p: string[]) => !p.length },
    { href: "/studio/articles/", label: "Articles", icon: "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z", match: (p: string[]) => p[0] === "articles" && route.query.get("state") !== "in_review" },
    { href: "/studio/articles/?state=in_review", label: "Review queue", badge: counts.in_review, icon: "M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", match: (p: string[]) => p[0] === "articles" && route.query.get("state") === "in_review" },
    { href: "/studio/media/", label: "Media", icon: "m2.25 15.75 5.16-5.16a2.25 2.25 0 0 1 3.18 0l5.16 5.16m-1.5-1.5 1.41-1.41a2.25 2.25 0 0 1 3.18 0l2.91 2.91M3.75 21h16.5A1.5 1.5 0 0 0 21.75 19.5V4.5A1.5 1.5 0 0 0 20.25 3H3.75A1.5 1.5 0 0 0 2.25 4.5v15A1.5 1.5 0 0 0 3.75 21Z", match: (p: string[]) => p[0] === "media" },
    ...(isEditorOrAbove()
      ? [
          { href: "/studio/comments/", label: "Comments", badge: commentsHeld, icon: "M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z", match: (p: string[]) => p[0] === "comments" },
          { href: "/studio/team/", label: "Team", icon: "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z", match: (p: string[]) => p[0] === "team" },
          { href: "/studio/settings/", label: "Site & limits", icon: "M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75", match: (p: string[]) => p[0] === "settings" },
          { href: "/studio/activity/", label: "Activity", icon: "M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", match: (p: string[]) => p[0] === "activity" },
        ]
      : []),
  ]);

  let run = $derived(latestRun());
  let deployLabel = $derived.by(() => {
    if (!deploys.loaded) return { text: "Checking site…", tone: "slate" };
    if (deploys.watching || (run && run.status !== "completed")) return { text: "Building site…", tone: "amber" };
    if (run?.conclusion === "failure") return { text: "Last build failed", tone: "rose" };
    if (deploys.build) return { text: `Live · built ${relTime(deploys.build.builtAt)}`, tone: "emerald" };
    return { text: "Status unknown", tone: "slate" };
  });
  const dot: Record<string, string> = { slate: "bg-slate-400", amber: "bg-amber-500 animate-pulse", rose: "bg-rose-500", emerald: "bg-emerald-500" };

  // "View as": the chief previews the studio as an editor or contributor.
  let isRealChief = $derived(session.user?.role === "chief" || session.user?.realRole === "chief");
  let viewing = $state<"chief" | "editor" | "contributor">(getViewAs() ?? "chief");
  async function viewAs(role: "chief" | "editor" | "contributor") {
    if (role === viewing) return;
    setViewAs(role === "chief" ? null : role);
    viewing = role;
    mobileOpen = false;
    await loadSession();
    refreshCounts();
    navigate("/studio/", true);
  }

  async function signOut() {
    setViewAs(null);
    await api.post("/auth/logout").catch(() => undefined);
    stopDeploys();
    clearReturn();
    session.user = null;
    navigate("/studio/login/", true);
  }
</script>

<svelte:window onkeydown={(e) => mobileOpen && e.key === "Escape" && (mobileOpen = false)} />

{#snippet sidebar()}
  <div class="flex h-full flex-col">
    <a href="/studio/" class="flex items-center gap-2.5 px-4 py-5">
      <img src="/playtested.png" alt="" class="h-8 w-8 rounded-lg shadow" />
      <div class="leading-tight">
        <p class="text-sm font-bold tracking-tight">PlayTested Studio</p>
        {#if session.env !== "production"}
          <p class="text-[10px] font-bold uppercase tracking-widest text-amber-600 dark:text-amber-400">{session.env}</p>
        {/if}
      </div>
    </a>
    <div class="px-3">
      <a href="/studio/articles/new/" class="btn-primary w-full">
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" /></svg>
        New article
      </a>
    </div>
    <nav class="mt-5 flex-1 space-y-0.5 px-3">
      {#each nav as item (item.href)}
        {@const active = item.match(route.parts)}
        <a
          href={item.href}
          class="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition
            {active ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-100'}"
        >
          <svg class="h-5 w-5 shrink-0 {active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300'}" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d={item.icon} /></svg>
          <span class="flex-1">{item.label}</span>
          {#if item.badge}
            <span class="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white" in:fade>{item.badge}</span>
          {/if}
        </a>
      {/each}
      <div class="my-2 border-t border-slate-200/70 dark:border-slate-800"></div>
      <a
        href="/"
        target="_blank"
        rel="noopener"
        class="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-100"
      >
        <svg class="h-5 w-5 shrink-0 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" /></svg>
        <span class="flex-1">View live site</span>
        <span class="text-xs text-slate-400" aria-hidden="true">↗</span>
      </a>
    </nav>
    <div class="space-y-3 border-t border-slate-200/70 dark:border-slate-800 p-3">
      <a href="/studio/settings/#deploys" class="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
        <span class="h-2 w-2 rounded-full {dot[deployLabel.tone]}"></span>
        <span class="truncate">{deployLabel.text}</span>
      </a>
      <div class="flex items-center gap-3 px-2">
        {#if session.user?.avatar}
          <img src={session.user.avatar} alt="" class="h-8 w-8 rounded-full" referrerpolicy="no-referrer" />
        {:else}
          <div class="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-xs font-bold text-white">{session.user?.name?.[0]?.toUpperCase() ?? "?"}</div>
        {/if}
        <div class="min-w-0 flex-1 leading-tight">
          <p class="truncate text-sm font-medium">{session.user?.name}</p>
          <p class="text-[11px] capitalize text-slate-500">{session.user?.role === "chief" ? "Chief editor" : session.user?.role}</p>
        </div>
        <button class="btn-ghost !p-1.5" title="Toggle theme" aria-label="Toggle theme" onclick={toggleTheme}>
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" /></svg>
        </button>
      </div>
      {#if isRealChief}
        <div class="px-1">
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">View studio as</p>
          <div class="grid grid-cols-3 rounded-lg bg-slate-100 p-0.5 text-[11px] font-semibold dark:bg-slate-800" role="group" aria-label="View studio as">
            {#each [["chief", "Chief"], ["editor", "Editor"], ["contributor", "Contributor"]] as [key, label]}
              <button
                type="button"
                aria-pressed={viewing === key}
                class="rounded-md px-1.5 py-1 transition {viewing === key ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}"
                onclick={() => viewAs(key as "chief" | "editor" | "contributor")}>{label}</button
              >
            {/each}
          </div>
        </div>
      {/if}
      <div class="flex gap-2 px-1 text-xs">
        <a href="/" target="_blank" class="btn-ghost !px-2 !py-1 flex-1">View site ↗</a>
        <button class="btn-ghost !px-2 !py-1 flex-1" onclick={signOut}>Sign out</button>
      </div>
    </div>
  </div>
{/snippet}

<div class="min-h-screen {focus ? '' : 'lg:pl-64'}">
  <aside class="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-200/70 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 {focus ? '' : 'lg:block'}">
    {@render sidebar()}
  </aside>

  <header class="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200/70 bg-white/80 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 {focus ? 'hidden' : 'lg:hidden'}">
    <button class="btn-ghost !p-1.5" aria-label="Open menu" aria-expanded={mobileOpen} bind:this={menuButton} onclick={() => (mobileOpen = true)}>
      <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>
    </button>
    <p class="text-sm font-bold">PlayTested Studio</p>
  </header>

  {#if mobileOpen}
    <div class="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <button class="absolute inset-0 bg-slate-950/50" tabindex="-1" aria-label="Close menu" onclick={() => (mobileOpen = false)} transition:fade={{ duration: 150 }}></button>
      <aside class="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-white dark:bg-slate-900 shadow-xl" bind:this={drawer} transition:fly={{ x: -280, duration: 200 }}>
        {@render sidebar()}
      </aside>
    </div>
  {/if}

  <main>
    {#if session.user?.realRole === "chief" && session.user.role !== "chief"}
      <div class="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-300 bg-amber-100/95 px-4 py-2 text-sm text-amber-900 backdrop-blur dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-100" in:fade>
        <span><b>Previewing as {session.user.role === "editor" ? "an editor" : "a contributor"}.</b> You see and can do only what they can.</span>
        <button type="button" class="ml-auto rounded-md px-2.5 py-1 text-xs font-semibold ring-1 ring-amber-400 transition hover:bg-amber-200 dark:ring-amber-500/50 dark:hover:bg-amber-500/25" onclick={() => viewAs("chief")}>Back to chief editor</button>
      </div>
    {/if}
    {@render children()}
  </main>
</div>
