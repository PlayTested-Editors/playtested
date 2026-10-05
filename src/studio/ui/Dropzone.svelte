<script lang="ts">
  import type { Media } from "../api";
  import { uploadFiles } from "../images.svelte";
  import { toast } from "../state.svelte";

  let {
    articleId,
    compact = false,
    onuploaded,
  }: { articleId?: string; compact?: boolean; onuploaded?: (media: Media[]) => void } = $props();

  let over = $state(false);
  let input: HTMLInputElement;

  async function handle(files: FileList | File[] | null | undefined) {
    if (!files || !files.length) return;
    const list = [...files];
    const done = await uploadFiles(list, articleId);
    if (done.length) {
      toast(`${done.length} image${done.length === 1 ? "" : "s"} uploaded`, "success");
      onuploaded?.(done);
    }
    if (done.length < list.length) toast(`${list.length - done.length} image(s) failed — see the upload tray`, "error");
  }
</script>

<button
  type="button"
  class="group relative w-full rounded-xl border-2 border-dashed transition-all duration-200
    {over ? 'border-indigo-500 bg-indigo-50/70 dark:bg-indigo-500/10 scale-[1.01]' : 'border-slate-300 dark:border-slate-700 hover:border-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'}
    {compact ? 'px-4 py-3' : 'px-6 py-8'}"
  onclick={() => input.click()}
  ondragover={(e) => {
    e.preventDefault();
    over = true;
  }}
  ondragleave={() => (over = false)}
  ondrop={(e) => {
    e.preventDefault();
    over = false;
    handle(e.dataTransfer?.files);
  }}
>
  <div class="flex {compact ? 'flex-row gap-3' : 'flex-col gap-2'} items-center justify-center text-center">
    <svg class="h-8 w-8 text-slate-400 group-hover:text-indigo-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.16-5.16a2.25 2.25 0 0 1 3.18 0l5.16 5.16m-1.5-1.5 1.41-1.41a2.25 2.25 0 0 1 3.18 0l2.91 2.91M3.75 21h16.5A1.5 1.5 0 0 0 21.75 19.5V4.5A1.5 1.5 0 0 0 20.25 3H3.75A1.5 1.5 0 0 0 2.25 4.5v15A1.5 1.5 0 0 0 3.75 21Zm10.5-11.25h.008v.008h-.008V9.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
    </svg>
    <div>
      <p class="text-sm font-medium text-slate-700 dark:text-slate-200">
        <span class="text-indigo-600 dark:text-indigo-400">Choose images</span> or drop them here
      </p>
      {#if !compact}
        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Select as many as you like — they're resized and compressed to AVIF before upload.</p>
      {/if}
    </div>
  </div>
</button>
<input bind:this={input} type="file" accept="image/*" multiple class="hidden" onchange={(e) => { handle(e.currentTarget.files); e.currentTarget.value = ""; }} />
