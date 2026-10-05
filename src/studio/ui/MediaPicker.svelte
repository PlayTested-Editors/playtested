<script lang="ts">
  import Modal from "./Modal.svelte";
  import Dropzone from "./Dropzone.svelte";
  import { api, type Media } from "../api";
  import { toastError } from "../state.svelte";

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

  let tab = $state<"article" | "library">("article");
  let library = $state<Media[]>([]);
  let fresh = $state<Media[]>([]);
  let selected = $state<string[]>([]);
  let loading = $state(false);

  let shown = $derived(
    tab === "article"
      ? [...fresh, ...articleMedia.filter((m) => !fresh.some((f) => f.id === m.id))]
      : library,
  );

  $effect(() => {
    if (open) {
      selected = [];
      fresh = [];
      if (!articleMedia.length) tab = "library";
    }
  });

  $effect(() => {
    if (open && tab === "library" && !library.length) loadLibrary();
  });

  async function loadLibrary() {
    loading = true;
    try {
      library = (await api.get<{ media: Media[] }>("/media?pageSize=120")).media;
    } catch (e) {
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
</script>

<Modal bind:open {title} size="xl">
  <div class="space-y-4">
    <Dropzone
      {articleId}
      compact
      onuploaded={(m) => {
        fresh = [...m, ...fresh];
        tab = "article";
        if (multiple) selected = [...selected, ...m.map((x) => x.id)];
      }}
    />
    <div class="flex gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1 w-fit text-sm">
      {#each [["article", "This article"], ["library", "All uploads"]] as [key, label]}
        <button
          class="rounded-md px-3 py-1 font-medium transition {tab === key ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-slate-100' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}"
          onclick={() => (tab = key as typeof tab)}>{label}</button
        >
      {/each}
    </div>
    {#if loading}
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
    {#if multiple}
      <button class="btn-secondary" onclick={() => (open = false)}>Cancel</button>
      <button class="btn-primary" disabled={!selected.length} onclick={confirm}>Add {selected.length || ""} image{selected.length === 1 ? "" : "s"}</button>
    {:else}
      <button class="btn-secondary" onclick={() => (open = false)}>Cancel</button>
    {/if}
  {/snippet}
</Modal>
