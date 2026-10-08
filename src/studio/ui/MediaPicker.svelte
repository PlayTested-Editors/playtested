<script lang="ts">
  import { getContext, untrack } from "svelte";
  import Modal from "./Modal.svelte";
  import Dropzone from "./Dropzone.svelte";
  import { api, type Media, type ShotMatch, type ShotResults } from "../api";
  import { toast, toastError } from "../state.svelte";
  import { uploadFiles } from "../images.svelte";
  import { slugify } from "../format";

  let {
    open = $bindable(false),
    articleId,
    multiple = false,
    title = "Choose an image",
    articleMedia = [],
    onpick,
  }: {
    open?: boolean;
    articleId?: string;
    multiple?: boolean;
    title?: string;
    articleMedia?: Media[];
    onpick: (media: Media[]) => void;
  } = $props();

  let tab = $state<"article" | "library" | "find">("article");
  let library = $state<Media[]>([]);
  let fresh = $state<Media[]>([]);
  let selected = $state<string[]>([]);
  let loading = $state(false);
  // Fetched at most once per picker (an empty library is a valid answer).
  let libraryLoaded = false;

  let shown = $derived(
    tab === "article"
      ? [...fresh, ...articleMedia.filter((m) => !fresh.some((f) => f.id === m.id))]
      : library,
  );

  // Reset only when the picker opens — not when articleMedia changes while
  // it's open (the editor's autosave replaces it), which would drop the picks.
  $effect(() => {
    if (open) {
      untrack(() => {
        selected = [];
        fresh = [];
        if (!articleMedia.length) tab = "library";
      });
    }
  });

  $effect(() => {
    if (open && tab === "library" && !libraryLoaded) untrack(loadLibrary);
  });

  async function loadLibrary() {
    if (libraryLoaded) return;
    libraryLoaded = true;
    loading = true;
    try {
      library = (await api.get<{ media: Media[] }>("/media?pageSize=120")).media;
    } catch (e) {
      libraryLoaded = false; // let the next open retry
      toastError(e);
    } finally {
      loading = false;
    }
  }

  function toggle(m: Media) {
    if (!multiple) {
      onpick([m]);
      open = false;
      return;
    }
    selected = selected.includes(m.id) ? selected.filter((id) => id !== m.id) : [...selected, m.id];
  }

  function confirm() {
    const all = [...shown, ...library, ...fresh];
    onpick(selected.map((id) => all.find((m) => m.id === id)!).filter(Boolean));
    open = false;
  }

  // ---- Find screenshots (Steam, then RAWG) --------------------------------
  // The editor provides the article's game name (see Editor.svelte).
  const gameName = getContext<(() => string) | undefined>("studio.game");
  let q = $state("");
  let found = $state<ShotResults | null>(null);
  let finding = $state(false);
  let picks = $state<string[]>([]); // full-size URLs, in pick order
  let importing = $state(false);

  $effect(() => {
    if (open) untrack(() => (picks = []));
  });

  function openFind() {
    tab = "find";
    if (!found && !finding) {
      q = q || gameName?.() || "";
      if (q.trim()) find();
    }
  }

  async function find(match?: ShotMatch) {
    if (!q.trim()) return;
    finding = true;
    picks = [];
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (match) {
        params.set("source", match.source);
        params.set("id", match.id);
      }
      found = await api.get<ShotResults>(`/screenshots?${params}`);
    } catch (e) {
      toastError(e);
    } finally {
      finding = false;
    }
  }

  function pickShot(full: string) {
    if (!multiple) {
      importShots([full]);
      return;
    }
    picks = picks.includes(full) ? picks.filter((u) => u !== full) : [...picks, full];
  }

  /** Copy the chosen screenshots into this article's uploads (compressed like any upload). */
  async function importShots(urls: string[]) {
    if (!urls.length || importing) return;
    importing = true;
    try {
      const name = slugify(found?.current?.name || q || "screenshot") || "screenshot";
      const files: File[] = [];
      for (const [i, url] of urls.entries()) {
        const res = await fetch(`/api/studio/screenshots/image?url=${encodeURIComponent(url)}`, { credentials: "same-origin" });
        if (!res.ok) throw new Error((await res.text()) || "Couldn't fetch that screenshot.");
        const blob = await res.blob();
        // "rawg-1-game-name": the source comes first so the server's 60-character
        // cut keeps it (articles with RAWG images credit RAWG; see ArticleView).
        files.push(new File([blob], `${found?.current?.source ?? "shot"}-${i + 1}-${name.slice(0, 40)}.${blob.type.split("/")[1] || "jpg"}`, { type: blob.type }));
      }
      const media = await uploadFiles(files, articleId);
      if (!media.length) throw new Error("The screenshots couldn't be uploaded.");
      if (media.length < files.length) toast(`${files.length - media.length} screenshot(s) failed to upload.`, "error");
      onpick(media);
      open = false;
    } catch (e) {
      toastError(e);
    } finally {
      importing = false;
    }
  }
</script>

<Modal bind:open {title} size="xl">
  <div class="space-y-4">
    <Dropzone
      {articleId}
      compact
      onuploaded={(m) => {
        fresh = [...m, ...fresh];
        if (libraryLoaded) library = [...m, ...library.filter((x) => !m.some((y) => y.id === x.id))];
        tab = "article";
        if (multiple) selected = [...selected, ...m.map((x) => x.id)];
      }}
    />
    <div class="flex gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1 w-fit text-sm">
      {#each [["article", "This article"], ["library", "All uploads"], ["find", "Find screenshots"]] as [key, label]}
        <button
          class="rounded-md px-3 py-1 font-medium transition {tab === key ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-slate-100' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}"
          onclick={() => (key === "find" ? openFind() : (tab = key as typeof tab))}>{label}</button
        >
      {/each}
    </div>
    {#if tab === "find"}
      <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); find(); }}>
        <input class="input" placeholder="Game name, e.g. Elden Ring" bind:value={q} aria-label="Game name" />
        <button class="btn-secondary whitespace-nowrap" disabled={finding || !q.trim()}>Search</button>
      </form>
      {#if found?.matches.length}
        <div class="flex flex-wrap items-center gap-1.5 text-xs">
          <span class="text-slate-500">Not the right game?</span>
          {#each found.matches as m (m.source + m.id)}
            {@const active = found.current?.source === m.source && found.current?.id === m.id}
            <button
              type="button"
              class="rounded-full px-2.5 py-1 font-medium ring-1 transition {active ? 'bg-indigo-600 text-white ring-indigo-600' : 'ring-slate-200 text-slate-600 hover:bg-slate-100 dark:ring-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'}"
              disabled={finding}
              onclick={() => find(m)}
            >{m.name}{m.year ? ` (${m.year})` : ""} · {m.source === "steam" ? "Steam" : "RAWG"}</button>
          {/each}
        </div>
      {/if}
      {#if finding}
        <p class="py-10 text-center text-sm text-slate-500">Searching…</p>
      {:else if !found}
        <p class="py-10 text-center text-sm text-slate-500">Type the game's name to see its official screenshots from Steam (or RAWG for console games).</p>
      {:else if !found.shots.length}
        <p class="py-10 text-center text-sm text-slate-500">No screenshots found{found.current ? ` for ${found.current.name}` : ""}. Try another match above, or a different spelling.</p>
      {:else}
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {#each found.shots as s (s.full)}
            <button
              type="button"
              class="group relative aspect-video overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800 ring-2 transition {picks.includes(s.full) ? 'ring-indigo-500 scale-[0.97]' : 'ring-transparent hover:ring-indigo-300'}"
              disabled={importing}
              onclick={() => pickShot(s.full)}
            >
              <img src={s.thumb} alt="" loading="lazy" referrerpolicy="no-referrer" class="h-full w-full object-cover" />
              {#if picks.includes(s.full)}
                <span class="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-indigo-600 text-xs font-bold text-white shadow">{picks.indexOf(s.full) + 1}</span>
              {/if}
            </button>
          {/each}
        </div>
        <p class="text-[11px] text-slate-500">
          Official screenshots from {found.current?.source === "steam" ? "the game's Steam page" : "RAWG"}. Picked images are copied into this article's uploads. Your own screenshots are always the safest choice.
        </p>
      {/if}
    {:else if loading}
      <p class="py-10 text-center text-sm text-slate-500">Loading…</p>
    {:else if !shown.length}
      <p class="py-10 text-center text-sm text-slate-500">
        {tab === "article" ? "No images uploaded for this article yet — drop some above." : "No uploads yet."}
      </p>
    {:else}
      <div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {#each shown as m (m.id)}
          <button
            type="button"
            class="group relative aspect-square overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800 ring-2 transition {selected.includes(m.id) ? 'ring-indigo-500 scale-[0.97]' : 'ring-transparent hover:ring-indigo-300'}"
            onclick={() => toggle(m)}
            title={m.filename}
          >
            <img src={m.url} alt={m.alt ?? ""} loading="lazy" class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
            {#if selected.includes(m.id)}
              <span class="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-indigo-600 text-xs font-bold text-white shadow">{selected.indexOf(m.id) + 1}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  {#snippet footer()}
    {#if tab === "find"}
      <button class="btn-secondary" onclick={() => (open = false)}>Cancel</button>
      {#if multiple || importing}
        <button class="btn-primary" disabled={!picks.length || importing} onclick={() => importShots(picks)}>
          {importing ? "Adding…" : `Add ${picks.length || ""} screenshot${picks.length === 1 ? "" : "s"}`}
        </button>
      {/if}
    {:else if multiple}
      <button class="btn-secondary" onclick={() => (open = false)}>Cancel</button>
      <button class="btn-primary" disabled={!selected.length} onclick={confirm}>Add {selected.length || ""} image{selected.length === 1 ? "" : "s"}</button>
    {:else}
      <button class="btn-secondary" onclick={() => (open = false)}>Cancel</button>
    {/if}
  {/snippet}
</Modal>
