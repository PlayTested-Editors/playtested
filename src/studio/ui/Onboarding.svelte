<script lang="ts">
  /**
   * The welcome tour for people who join the team (users.onboarded_at is null;
   * everyone already on the team was marked done when it shipped). Steps: hello,
   * display name + byline, how an article goes live, the editor's tools, editor
   * extras (editors only), done. Finishing or skipping marks it done for good.
   */
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import { api, ApiError } from "../api";
  import { loadSession, navigate, session, toastError } from "../state.svelte";

  let { ondone }: { ondone: () => void } = $props();

  const user = $derived(session.user!);
  const isEditor = $derived(user.role === "editor");
  type Step = "welcome" | "names" | "flow" | "tools" | "editor" | "done";
  const steps = $derived<Step[]>(isEditor ? ["welcome", "names", "flow", "tools", "editor", "done"] : ["welcome", "names", "flow", "tools", "done"]);
  let i = $state(0);
  const step = $derived(steps[Math.min(i, steps.length - 1)]);
  const last = $derived(step === "done");

  let name = $state(session.user?.name ?? "");
  let byline = $state("");
  let saving = $state(false);
  let serverError = $state("");
  const hasByline = $derived(Boolean(user.authorName));
  const first = $derived((name.trim() || user.name).split(" ")[0]);

  const bylineCheck = $derived.by(() => {
    const v = byline.replace(/\s+/g, " ").trim();
    if (!v) return { ok: false, msg: "Printed on your articles, like a gamer tag. Letters, numbers, spaces, dots, dashes.", tone: "" };
    if (v.length < 2) return { ok: false, msg: "At least 2 characters.", tone: "err" };
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(v)) return { ok: false, msg: "Use letters, numbers, spaces, dots, dashes or underscores.", tone: "err" };
    return { ok: true, msg: "We'll check it's free when you continue.", tone: "" };
  });
  const namesReady = $derived(name.trim().length >= 2 && (hasByline || bylineCheck.ok));

  let bylineInput = $state<HTMLInputElement>();
  let panel = $state<HTMLDivElement>();
  $effect(() => {
    if (step === "names") tick().then(() => (hasByline ? null : bylineInput?.focus()));
    else tick().then(() => panel?.querySelector<HTMLElement>("[data-primary]")?.focus({ preventScroll: true }));
  });

  async function saveNames(): Promise<boolean> {
    saving = true;
    serverError = "";
    try {
      await api.patch("/me", { name, ...(hasByline ? {} : { byline }) });
      await loadSession();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) serverError = e.message;
      else toastError(e);
      return false;
    } finally {
      saving = false;
    }
  }

  async function next() {
    if (step === "names" && !(await saveNames())) return;
    i++;
  }

  async function finish(write: boolean) {
    try {
      await api.post("/me/onboarded");
    } catch {
      /* worst case it shows again next visit */
    }
    await loadSession().catch(() => undefined);
    ondone();
    if (write) navigate("/studio/articles/new/");
  }

  function skip() {
    // The byline is the one thing that can't wait: articles need it.
    if (!session.user?.authorName) {
      i = steps.indexOf("names");
      return;
    }
    finish(false);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      skip();
    }
  }

  const ICON = {
    pen: "m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z",
    check: "M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    chat: "M8.625 9.75a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.294 48.294 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z",
    team: "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z",
  };
  const can = $derived(
    isEditor
      ? [
          ["Write and edit", "Your own articles, and anyone's drafts when they need a hand.", ICON.pen],
          ["Send work for review", "The chief editor gives the final OK and publishes.", ICON.check],
          ["Help run the site", "Moderate comments and keep an eye on team activity.", ICON.chat],
        ]
      : [
          ["Write reviews and articles", "Your own drafts, with autosave and a live preview.", ICON.pen],
          ["Send them for review", "The chief editor checks and publishes them under your byline.", ICON.check],
          ["Get feedback", "Notes from the chief appear right on your article.", ICON.chat],
        ],
  );
  const tools = [
    ["Write with AI", "Turn your rough notes into a structured draft with your favourite AI, then make it yours.", "from-indigo-500 to-purple-500", "M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z"],
    ["Tidy formatting", "Cleans pasted text: fixes Pros & Cons lists and strips stray styles from Google Docs.", "from-sky-500 to-blue-600", "M3.75 6.75h16.5M3.75 12h10.5m-10.5 5.25h7.5"],
    ["Find screenshots", "Official screenshots from Steam (or RAWG for console games), right in the image picker.", "from-green-500 to-green-700", "m2.25 15.75 5.16-5.16a2.25 2.25 0 0 1 3.18 0l5.16 5.16m-1.5-1.5 1.41-1.41a2.25 2.25 0 0 1 3.18 0l2.91 2.91M3.75 21h16.5A1.5 1.5 0 0 0 21.75 19.5V4.5A1.5 1.5 0 0 0 20.25 3H3.75A1.5 1.5 0 0 0 2.25 4.5v15A1.5 1.5 0 0 0 3.75 21Z"],
    ["Live preview", "See exactly how it will look on the site, on desktop or phone, as you type.", "from-amber-500 to-orange-600", "M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25"],
  ];
  const flow = [
    ["Write", "you", "Start a new article. Everything saves automatically, and History keeps every version."],
    ["Submit for review", "you", "When it's ready, press Submit for review. Images are optional; the chief can add them."],
    ["Review", "chief editor", "The chief either publishes it or asks for changes. Notes show at the top of your article, and it appears under \"Changes requested\"."],
  ];
</script>

<svelte:window {onkeydown} />

<div class="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4 dark:bg-slate-950/70" transition:fade={{ duration: 150 }}>
  <div
    bind:this={panel}
    class="flex max-h-[calc(100vh-2rem)] w-full max-w-[600px] flex-col overflow-y-auto rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10"
    role="dialog"
    aria-modal="true"
    aria-labelledby="onb-title"
  >
    <div class="h-1 overflow-hidden rounded-t-2xl bg-slate-200 dark:bg-slate-800">
      <div class="h-full bg-gradient-to-r from-[#6CB8FF] to-[#2373D8] transition-[width] duration-300" style="width: {((i + 1) / steps.length) * 100}%"></div>
    </div>
    <div class="flex items-center justify-between px-6 pt-3.5 text-xs text-slate-500">
      <span>{last ? "Done" : `Step ${i + 1} of ${steps.length - 1}`}</span>
      {#if !last}<button type="button" class="underline hover:text-slate-800 dark:hover:text-slate-200" onclick={skip}>Skip tour</button>{/if}
    </div>

    {#key step}
      <section class="px-7 pb-1 pt-2" in:fade={{ duration: 150 }}>
        {#if step === "welcome"}
          <div class="mt-2 flex items-center gap-3.5">
            <img src="/favicon.svg" alt="" class="h-14 w-14 shrink-0" />
            <div>
              <span class="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">{isEditor ? "Editor" : "Contributor"}</span>
              <h2 id="onb-title" class="font-brand mt-1 text-2xl font-bold leading-tight">Welcome to PlayTested Studio, {first}!</h2>
            </div>
          </div>
          <p class="mb-4 mt-3 text-sm text-slate-500 dark:text-slate-400">This is where reviews get written, edited and published. A quick tour (about a minute) and you're ready to write.</p>
          <ul class="space-y-2.5">
            {#each can as [t, d, icon]}
              <li class="flex items-start gap-3 rounded-xl bg-slate-50 px-3.5 py-3 ring-1 ring-slate-200 dark:bg-slate-800/50 dark:ring-slate-700/70">
                <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                  <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d={icon} /></svg>
                </span>
                <span class="text-sm"><b class="block">{t}</b><span class="text-slate-500 dark:text-slate-400">{d}</span></span>
              </li>
            {/each}
          </ul>
        {:else if step === "names"}
          <h2 id="onb-title" class="font-brand mt-1 text-2xl font-bold">How you'll appear</h2>
          <p class="mb-2 text-sm text-slate-500 dark:text-slate-400">Two names: one for the team, one for readers.</p>
          <label class="label mt-4" for="onb-name">Display name</label>
          <input id="onb-name" class="input" maxlength="40" bind:value={name} />
          <p class="mt-1 text-[11px] text-slate-500">Shown inside the studio (notes, "edited by"). You can change it any time.</p>
          <label class="label mt-4" for="onb-byline">Byline</label>
          {#if hasByline}
            <p class="rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold dark:bg-slate-800/60">{user.authorName}</p>
            <p class="mt-1 text-[11px] text-slate-500">Set for you by the chief editor. It's printed on your articles.</p>
          {:else}
            <input
              id="onb-byline"
              class="input"
              maxlength="30"
              placeholder="e.g. pixelknight"
              autocomplete="off"
              bind:this={bylineInput}
              bind:value={byline}
              oninput={() => (serverError = "")}
              onkeydown={(e) => e.key === "Enter" && namesReady && !saving && next()}
            />
            <p class="mt-1 text-[11px] {serverError || bylineCheck.tone === 'err' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500'}">{serverError || bylineCheck.msg}</p>
          {/if}
          <div class="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3.5 py-3 dark:border-slate-700 dark:bg-slate-800/40">
            <p class="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">Preview</p>
            <p class="text-[17px] font-bold">By <span class={hasByline || byline.trim() ? "" : "text-slate-400"}>{hasByline ? user.authorName : byline.trim() || "your byline"}</span></p>
            <p class="text-xs text-slate-500">Published on {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} · REVIEW</p>
            <p class="mt-2.5 border-t border-slate-200 pt-2.5 text-[13px] text-slate-500 dark:border-slate-700">In the studio: <b class="text-slate-800 dark:text-slate-100">{name.trim() || "your name"}</b> left a note</p>
          </div>
          {#if !hasByline}
            <p class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">Pick your byline carefully: after this, only the chief editor can change it.</p>
          {/if}
        {:else if step === "flow"}
          <h2 id="onb-title" class="font-brand mt-1 text-2xl font-bold">How an article goes live</h2>
          <p class="mb-4 text-sm text-slate-500 dark:text-slate-400">{isEditor ? "Everyone's work, yours included, gets a final check from the chief editor." : "You write; the chief editor checks it and publishes."}</p>
          <ol>
            {#each flow as [t, who, d], k}
              <li class="relative grid grid-cols-[34px_1fr] gap-3 pb-3.5">
                <span class="absolute bottom-0 left-4 top-9 w-0.5 bg-slate-200 dark:bg-slate-700" aria-hidden="true"></span>
                <span class="grid h-[34px] w-[34px] place-items-center rounded-full text-sm font-bold {who === 'you' ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'}">{k + 1}</span>
                <span class="text-sm">
                  <b class="mt-1.5 block">{t}<span class="ml-1.5 rounded-full px-1.5 py-px align-[1px] text-[10px] font-bold uppercase {who === 'you' ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}">{who}</span></b>
                  <span class="text-slate-500 dark:text-slate-400">{d}</span>
                </span>
              </li>
            {/each}
            <li class="grid grid-cols-[34px_1fr] gap-3 pb-2">
              <span class="grid h-[34px] w-[34px] place-items-center rounded-full bg-emerald-500 text-sm font-bold text-white">✓</span>
              <span class="text-sm"><b class="mt-1.5 block">Live on PlayTested.net</b><span class="text-slate-500 dark:text-slate-400">With your byline on it. You can still suggest edits later; they go through review again.</span></span>
            </li>
          </ol>
          {#if isEditor}
            <p class="mb-2 rounded-lg bg-sky-50 px-3 py-2 text-[13px] text-sky-800 dark:bg-sky-500/10 dark:text-sky-200">As an editor you can also open and improve anyone's draft, then submit it for review on their behalf.</p>
          {/if}
        {:else if step === "tools"}
          <h2 id="onb-title" class="font-brand mt-1 text-2xl font-bold">Your writing toolkit</h2>
          <p class="mb-4 text-sm text-slate-500 dark:text-slate-400">All inside the editor. None of it is required.</p>
          <div class="grid gap-2.5 sm:grid-cols-2">
            {#each tools as [t, d, grad, icon]}
              <div class="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200 dark:bg-slate-800/50 dark:ring-slate-700/70">
                <span class="mb-2 grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br {grad} text-white">
                  <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d={icon} /></svg>
                </span>
                <b class="block text-[13.5px]">{t}</b>
                <span class="text-[12.5px] text-slate-500 dark:text-slate-400">{d}</span>
              </div>
            {/each}
          </div>
        {:else if step === "editor"}
          <h2 id="onb-title" class="font-brand mt-1 text-2xl font-bold">Your editor tools</h2>
          <p class="mb-4 text-sm text-slate-500 dark:text-slate-400">Editors help keep the site in shape. These are in the sidebar.</p>
          <ul class="space-y-2.5">
            {#each [["Edit any article", "Fix typos or polish anyone's draft. Changes still go to the chief before they're live.", ICON.pen], ["Comments", "Approve or remove reader comments held for moderation.", ICON.chat], ["Team & Activity", "See who's on the team and what changed recently.", ICON.team]] as [t, d, icon]}
              <li class="flex items-start gap-3 rounded-xl bg-slate-50 px-3.5 py-3 ring-1 ring-slate-200 dark:bg-slate-800/50 dark:ring-slate-700/70">
                <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                  <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d={icon} /></svg>
                </span>
                <span class="text-sm"><b class="block">{t}</b><span class="text-slate-500 dark:text-slate-400">{d}</span></span>
              </li>
            {/each}
          </ul>
        {:else}
          <img src="/favicon.svg" alt="" class="mx-auto mb-1 mt-3 h-[72px] w-[72px]" />
          <h2 id="onb-title" class="font-brand text-center text-2xl font-bold">You're all set, {first}!</h2>
          <p class="text-center text-sm text-slate-500 dark:text-slate-400">
            Your byline: <b class="text-slate-800 dark:text-slate-100">{session.user?.authorName ?? "—"}</b>. A short checklist stays on your dashboard until you've sent in your first draft.
          </p>
          <div class="mb-1 mt-5 flex flex-col gap-2">
            <button type="button" class="btn-primary w-full !py-3 text-[15px]" data-primary onclick={() => finish(true)}>Write my first article</button>
            <button type="button" class="btn-secondary w-full !py-3 text-[15px]" onclick={() => finish(false)}>Explore the studio</button>
          </div>
        {/if}
      </section>
    {/key}

    <div class="flex items-center justify-between gap-3 px-5 pb-5 pt-4">
      <button type="button" class="btn-ghost {i === 0 || last ? 'invisible' : ''}" onclick={() => (i = Math.max(0, i - 1))}>Back</button>
      <div class="flex gap-1.5" aria-hidden="true">
        {#each steps as _, k}
          <span class="h-[7px] rounded-full {k === i ? 'w-[18px] bg-indigo-600' : 'w-[7px] bg-slate-200 dark:bg-slate-700'}"></span>
        {/each}
      </div>
      {#if last}
        <span class="w-[72px]"></span>
      {:else}
        <button type="button" class="btn-primary" data-primary disabled={saving || (step === "names" && !namesReady)} onclick={next}>
          {saving ? "Saving…" : i === 0 ? "Let's go" : step === "names" ? "Save and continue" : i === steps.length - 2 ? "Finish" : "Next"}
        </button>
      {/if}
    </div>
  </div>
</div>
