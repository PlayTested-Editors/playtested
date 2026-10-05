<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { api, type Media } from "../api";
  import { bytes, relTime } from "../format";
  import { toast, toastError } from "../state.svelte";
  import Dropzone from "../ui/Dropzone.svelte";

  let media = $state<Media[] | null>(null);
  let page = $state(1);
  let more = $state(false);

  async function load(reset = false) {
    try {
      if (reset) page = 1;
      const r = await api.get<{ media: Media[]; pageSize: number }>(`/media?page=${page}&pageSize=60`);
      media = reset || !media ? r.media : [...media, ...r.media];
      more = r.media.length === r.pageSize;
    } catch (e) {
      toastError(e);
    }
  }
  onMount(() => load(true));

  async function copy(url: string) {
    await navigator.clipboard.writeText(url).catch(() => undefined);
    toast("Image path copied", "info", undefined, 1500);
  }
</script>

<div class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
  <div class="mb-6">
    <h1 class="text-2xl font-bold tracking-tight">Media</h1>
    <p class="mt-1 text-sm text-slate-500">Images uploaded through the studio. Older images from before the studio live in the site's repository.</p>
  </div>
  <div class="mb-6"><Dropzone onuploaded={(m) => (media = [...m, ...(media ?? [])])} /></div>
  {#if !media}
    <div class="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">{#each Array(12) as _}<div class="aspect-square animate-pulse rounded-xl bg-slate-200/60 dark:bg-slate-800"></div>{/each}</div>
  {:else if !media.length}
    <p class="py-12 text-center text-sm text-slate-500">No uploads yet.</p>
  {:else}
    <ul class="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
      {#each media as m (m.id)}
        <li class="group" in:fade={{ duration: 150 }}>
          <button class="relative block aspect-square w-full overflow-hidden rounded-xl bg-slate-100 ring-1 ring-slate-900/5 dark:bg-slate-800" onclick={() => copy(m.url)} title="Copy path">
            <img src={m.url} alt={m.alt ?? ""} loading="lazy" class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
            {#if !m.committed}<span class="absolute left-1.5 top-1.5 rounded bg-amber-500 px-1.5 text-[10px] font-bold text-white">Not published</span>{/if}
          </button>
          <p class="mt-1.5 truncate text-xs font-medium" title={m.filename}>{m.filename}</p>
          <p class="text-[11px] text-slate-500">{bytes(m.bytes)} · {relTime(m.createdAt)}</p>
        </li>
      {/each}
    </ul>
    {#if more}
      <div class="mt-6 text-center"><button class="btn-secondary" onclick={() => { page++; load(); }}>Load more</button></div>
    {/if}
  {/if}
</div>
