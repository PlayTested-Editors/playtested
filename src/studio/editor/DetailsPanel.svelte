<script lang="ts">
  import type { ArticleData, Media } from "../api";
  import { fromLocalInput, slugify, toLocalInput } from "../format";
  import TagInput from "../ui/TagInput.svelte";
  import MediaPicker from "../ui/MediaPicker.svelte";
  import GalleryField from "./GalleryField.svelte";

  let {
    data = $bindable(),
    articleId,
    articleMedia = [],
    meta,
    isLive,
    disabled = false,
    slugAuto = $bindable(false),
    onmediaadded,
  }: {
    data: ArticleData;
    articleId: string;
    articleMedia?: Media[];
    meta: { categories: string[]; tags: string[]; authors: string[] };
    isLive: boolean;
    disabled?: boolean;
    slugAuto?: boolean;
    onmediaadded?: (m: Media[]) => void;
  } = $props();

  let pick = $state<null | "thumb" | "large">(null);
  let pickOpen = $state(false);
  let future = $derived(Date.parse(data.pubDate) > Date.now());
  const descMax = 300;
</script>

{#snippet imageSlot(field: "thumb" | "large", label: string, hint: string)}
  <div>
    <span class="label">{label}</span>
    <div class="group relative aspect-video overflow-hidden rounded-xl bg-slate-100 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
      {#if data[field]}
        <img src={data[field]} alt="" class="h-full w-full object-cover" />
        {#if !disabled}
          <div class="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 opacity-0 transition group-hover:opacity-100">
            <button type="button" class="btn-secondary !py-1 text-xs" onclick={() => { pick = field; pickOpen = true; }}>Change</button>
            <button type="button" class="btn-danger !py-1 text-xs" onclick={() => (data[field] = undefined)}>Remove</button>
          </div>
        {/if}
      {:else}
        <button type="button" class="flex h-full w-full flex-col items-center justify-center gap-1 text-xs text-slate-500 transition hover:bg-slate-200/60 hover:text-indigo-600 dark:hover:bg-slate-700/50" {disabled} onclick={() => { pick = field; pickOpen = true; }}>
          <span class="text-2xl leading-none">+</span>{hint}
        </button>
      {/if}
    </div>
  </div>
{/snippet}

<div class="space-y-6">
  <div>
    <label class="label" for="slug">URL slug</label>
    <div class="flex items-center gap-2">
      <span class="hidden text-xs text-slate-400 sm:inline">/article/</span>
      <input
        id="slug"
        class="input font-mono text-xs"
        value={data.slug}
        {disabled}
        oninput={(e) => {
          slugAuto = false;
          data.slug = slugify(e.currentTarget.value);
        }}
      />
      {#if !isLive}
        <button type="button" class="btn-ghost !px-2 text-xs whitespace-nowrap" title="Keep the slug in sync with the title" onclick={() => { slugAuto = true; data.slug = slugify(data.title); }}>
          {slugAuto ? "Auto ✓" : "From title"}
        </button>
      {/if}
    </div>
    {#if isLive}
      <p class="mt-1 text-[11px] text-amber-600 dark:text-amber-400">This article is live — changing the slug changes its URL and breaks old links.</p>
    {/if}
  </div>

  <div>
    <label class="label" for="desc">Description</label>
    <textarea id="desc" class="input min-h-[96px]" maxlength={descMax * 3} {disabled} bind:value={data.description} placeholder="One or two sentences shown on cards, search results and social shares."></textarea>
    <p class="mt-1 text-right text-[11px] tabular-nums {data.description.length > descMax ? 'text-amber-600' : 'text-slate-400'}">{data.description.length} characters</p>
  </div>

  <div class="grid gap-4 sm:grid-cols-2">
    <div>
      <label class="label" for="cat">Category</label>
      <input id="cat" class="input" list="studio-categories" {disabled} bind:value={data.category} placeholder="review" />
      <datalist id="studio-categories">{#each meta.categories as c}<option value={c}></option>{/each}</datalist>
    </div>
    <div>
      <label class="label" for="score">Score <span class="normal-case font-normal text-slate-400">(out of 10, optional)</span></label>
      <input
        id="score"
        class="input"
        type="number"
        min="0"
        max="10"
        step="0.1"
        {disabled}
        value={data.score ?? ""}
        oninput={(e) => (data.score = e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
      />
    </div>
  </div>

  <div>
    <span class="label">Tags</span>
    <TagInput bind:value={data.tags} suggestions={meta.tags} {disabled} placeholder="PC, Console, RPG…" />
  </div>

  <div class="grid gap-4 sm:grid-cols-2">
    <div>
      <label class="label" for="author">Byline</label>
      <input id="author" class="input" list="studio-authors" {disabled} bind:value={data.author} />
      <datalist id="studio-authors">{#each meta.authors as a}<option value={a}></option>{/each}</datalist>
    </div>
    <div>
      <label class="label" for="game">Game <span class="normal-case font-normal text-slate-400">(optional)</span></label>
      <input id="game" class="input" {disabled} bind:value={data.game} placeholder="e.g. Elden Ring" />
    </div>
  </div>

  <div>
    <label class="label" for="date">Publish date <span class="normal-case font-normal text-slate-400">(Philippine time)</span></label>
    <div class="flex gap-2">
      <input id="date" type="datetime-local" class="input" {disabled} value={toLocalInput(data.pubDate)} onchange={(e) => (data.pubDate = fromLocalInput(e.currentTarget.value))} />
      <button type="button" class="btn-secondary whitespace-nowrap" {disabled} onclick={() => (data.pubDate = fromLocalInput(""))}>Now</button>
    </div>
    <p class="mt-1 text-[11px] {future ? 'text-sky-600 dark:text-sky-400 font-medium' : 'text-slate-500'}">
      {future ? "Future date: publishing will schedule this — it appears on the site automatically at this time." : "Set a future date to schedule the article."}
    </p>
  </div>

  <label class="flex items-center justify-between gap-4 rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-800/50">
    <span>
      <span class="block text-sm font-medium">Featured</span>
      <span class="block text-xs text-slate-500">Shown in the homepage carousel and "You might also like".</span>
    </span>
    <input type="checkbox" class="h-5 w-9 cursor-pointer appearance-none rounded-full bg-slate-300 transition before:block before:h-4 before:w-4 before:translate-x-0.5 before:rounded-full before:bg-white before:shadow before:transition checked:bg-indigo-600 checked:before:translate-x-[18px] dark:bg-slate-600" {disabled} bind:checked={data.featured} />
  </label>

  <div class="grid gap-4 sm:grid-cols-2">
    {@render imageSlot("thumb", "Thumbnail", "Card & share image")}
    {@render imageSlot("large", "Hero image", "Big image above the article")}
  </div>

  <div>
    <span class="label">Gallery</span>
    <GalleryField bind:value={() => data.gallery ?? [], (v) => (data.gallery = v)} {articleId} {articleMedia} {disabled} {onmediaadded} onusethumb={(u) => (data.thumb = u)} body={data.body} />
  </div>
</div>

<MediaPicker
  bind:open={pickOpen}
  {articleId}
  {articleMedia}
  title={pick === "thumb" ? "Choose a thumbnail" : "Choose a hero image"}
  onpick={(m) => {
    onmediaadded?.(m);
    if (pick && m[0]) data[pick] = m[0].url;
  }}
/>
