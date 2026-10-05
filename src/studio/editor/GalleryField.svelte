<script lang="ts">
  import { flip } from "svelte/animate";
  import { scale } from "svelte/transition";
  import type { Media } from "../api";
  import MediaPicker from "../ui/MediaPicker.svelte";

  let {
    value = $bindable<string[]>([]),
    articleId,
    articleMedia = [],
    disabled = false,
    onmediaadded,
    onusethumb,
  }: {
    value?: string[];
    articleId: string;
    articleMedia?: Media[];
    disabled?: boolean;
    onmediaadded?: (m: Media[]) => void;
    onusethumb?: (url: string) => void;
  } = $props();

  let open = $state(false);
  let dragFrom = $state<number | null>(null);
  let dragOver = $state<number | null>(null);

  function move(from: number, to: number) {
    if (from === to) return;
    const next = [...value];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    value = next;
  }
</script>

<div>
  {#if value.length}
    <ul class="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {#each value as url, i (url)}
        <li
          class="group relative aspect-video overflow-hidden rounded-lg bg-slate-100 ring-2 transition dark:bg-slate-800 {dragOver === i ? 'ring-indigo-500' : 'ring-transparent'} {dragFrom === i ? 'opacity-40' : ''}"
          draggable={!disabled}
          ondragstart={() => (dragFrom = i)}
          ondragover={(e) => {
            e.preventDefault();
            dragOver = i;
          }}
          ondragleave={() => (dragOver = null)}
          ondrop={(e) => {
            e.preventDefault();
            if (dragFrom !== null) move(dragFrom, i);
            dragFrom = dragOver = null;
          }}
          ondragend={() => (dragFrom = dragOver = null)}
          animate:flip={{ duration: 200 }}
          in:scale={{ start: 0.9, duration: 150 }}
        >
          <img src={url} alt="" loading="lazy" class="h-full w-full cursor-grab object-cover" />
          <span class="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 text-[10px] font-bold text-white">{i + 1}</span>
          {#if !disabled}
            <div class="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent p-1.5 opacity-0 transition group-hover:opacity-100">
              {#if onusethumb}
                <button type="button" class="rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-800 hover:bg-white" onclick={() => onusethumb?.(url)}>Thumbnail</button>
              {/if}
              <button type="button" class="rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-rose-500" onclick={() => (value = value.filter((_, j) => j !== i))}>Remove</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="mt-1.5 text-[11px] text-slate-500">Drag to reorder. The first image shows first in the article's gallery.</p>
  {/if}
  {#if !disabled}
    <button type="button" class="btn-secondary mt-2 w-full" onclick={() => (open = true)}>+ Add gallery images</button>
  {/if}
</div>

<MediaPicker
  bind:open
  {articleId}
  {articleMedia}
  multiple
  title="Add gallery images"
  onpick={(m) => {
    onmediaadded?.(m);
    value = [...value, ...m.map((x) => x.url).filter((u) => !value.includes(u))];
  }}
/>
