<script lang="ts">
  import type { ArticleData } from "../api";

  let { data }: { data: ArticleData } = $props();

  let frame: HTMLIFrameElement;
  let form: HTMLFormElement;
  let payload: HTMLInputElement;
  let device = $state<"desktop" | "mobile">("desktop");
  let loading = $state(true);
  let scrollY = 0;
  let timer: ReturnType<typeof setTimeout>;
  let lastSent = "";

  // Re-render the real article template ~1s after typing stops.
  $effect(() => {
    const json = JSON.stringify(data);
    clearTimeout(timer);
    timer = setTimeout(() => send(json), lastSent ? 1000 : 0);
  });

  function send(json: string) {
    if (!form || json === lastSent) return;
    lastSent = json;
    try {
      scrollY = frame.contentWindow?.scrollY ?? 0;
    } catch {
      scrollY = 0;
    }
    payload.value = json;
    loading = true;
    form.submit();
  }

  function onload() {
    loading = false;
    try {
      frame.contentWindow?.scrollTo({ top: scrollY });
    } catch {
      /* cross-origin never happens here; ignore */
    }
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center justify-between gap-2 border-b border-slate-200/70 bg-white/80 px-3 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
    <div class="flex items-center gap-2 text-xs font-medium text-slate-500">
      <span class="h-2 w-2 rounded-full {loading ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500'}"></span>
      Live preview
    </div>
    <div class="flex gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
      {#each [["desktop", "Desktop"], ["mobile", "Phone"]] as [key, label]}
        <button class="rounded-md px-2.5 py-1 text-xs font-medium transition {device === key ? 'bg-white shadow-sm dark:bg-slate-900' : 'text-slate-500'}" onclick={() => (device = key as typeof device)}>{label}</button>
      {/each}
    </div>
  </div>
  <div class="relative flex-1 overflow-hidden bg-slate-200/60 dark:bg-slate-950">
    <iframe
      bind:this={frame}
      name="studio-preview"
      title="Article preview"
      class="mx-auto h-full border-0 bg-white transition-[width] duration-300 dark:bg-slate-900 {device === 'mobile' ? 'w-[390px] shadow-xl' : 'w-full'}"
      {onload}
    ></iframe>
  </div>
  <form bind:this={form} method="POST" action="/live/preview/" target="studio-preview" class="hidden">
    <input bind:this={payload} type="hidden" name="payload" />
  </form>
</div>
