<script lang="ts">
  import Modal from "../ui/Modal.svelte";
  import { api, ApiError, type ArticleData, type ArticleDetail } from "../api";
  import { dateTime } from "../format";

  let {
    open = $bindable(false),
    detail,
    data,
    onpublished,
  }: { open?: boolean; detail: ArticleDetail; data: ArticleData; onpublished: (d: ArticleDetail) => void } = $props();

  let phase = $state<"confirm" | "images" | "committing" | "error">("confirm");
  let progress = $state({ done: 0, total: 0 });
  let problems = $state<string[]>([]);
  let errorText = $state("");

  let future = $derived(Date.parse(data.pubDate) > Date.now());
  let isUpdate = $derived(Boolean(detail.live));
  let checks = $derived([
    { ok: Boolean(data.title.trim()), text: "Has a title" },
    { ok: Boolean(data.description.trim()), text: "Has a description" },
    { ok: Boolean(data.category.trim()), text: "Has a category" },
    { ok: Boolean(data.body.trim()), text: "Has body text" },
    { ok: Boolean(data.thumb), text: "Has a thumbnail (recommended)", soft: true },
    { ok: data.tags.length > 0, text: "Has tags (recommended)", soft: true },
  ]);
  let blocking = $derived(checks.some((c) => !c.ok && !c.soft));

  $effect(() => {
    if (open) {
      phase = "confirm";
      problems = [];
      errorText = "";
    }
  });

  async function publish() {
    phase = "committing";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await api.post<ArticleDetail>(`/articles/${detail.article.id}/publish`, { rev: detail.article.rev });
        onpublished(res);
        open = false;
        return;
      } catch (e) {
        if (e instanceof ApiError && e.data.code === "needs_blobs") {
          // Upload new images to GitHub one per request, then try again.
          const ids: string[] = e.data.media;
          phase = "images";
          progress = { done: 0, total: ids.length };
          try {
            for (const id of ids) {
              await api.post(`/media/${id}/blob`);
              progress.done++;
            }
          } catch (err) {
            phase = "error";
            errorText = (err as Error).message;
            return;
          }
          phase = "committing";
          continue;
        }
        phase = "error";
        problems = e instanceof ApiError ? (e.data.problems ?? []) : [];
        errorText = (e as Error).message;
        return;
      }
    }
  }

  let title = $derived(isUpdate ? "Publish changes" : future ? "Schedule article" : "Publish article");
</script>

<Modal bind:open {title} size="md">
  {#if phase === "confirm"}
    <div class="space-y-4 text-sm">
      <div class="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/50">
        <p class="font-semibold">{data.title || "Untitled"}</p>
        <p class="mt-1 text-xs text-slate-500">/article/{data.slug}/</p>
        <p class="mt-2 text-xs">
          {#if future}
            <span class="font-medium text-sky-600 dark:text-sky-400">Scheduled for {dateTime(data.pubDate)}</span> — it'll appear on the site automatically at that time.
          {:else if isUpdate}
            The live article updates on the site in about 1–2 minutes.
          {:else}
            <span class="font-medium text-emerald-600 dark:text-emerald-400">Viewable at its link right away</span>; the homepage and lists update in about 1–2 minutes.
          {/if}
        </p>
      </div>
      <ul class="space-y-1.5">
        {#each checks as c}
          <li class="flex items-center gap-2 {c.ok ? 'text-slate-700 dark:text-slate-300' : c.soft ? 'text-amber-700 dark:text-amber-400' : 'text-rose-600'}">
            <span class="grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold {c.ok ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' : c.soft ? 'bg-amber-100 dark:bg-amber-500/20' : 'bg-rose-100 dark:bg-rose-500/20'}">{c.ok ? "✓" : "!"}</span>
            {c.text}
          </li>
        {/each}
      </ul>
    </div>
  {:else if phase === "images"}
    <div class="py-6 text-center">
      <p class="text-sm font-medium">Uploading images to the site… {progress.done}/{progress.total}</p>
      <div class="mx-auto mt-3 h-2 w-64 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div class="h-full rounded-full bg-indigo-500 transition-all duration-300" style="width: {progress.total ? (progress.done / progress.total) * 100 : 0}%"></div>
      </div>
    </div>
  {:else if phase === "committing"}
    <div class="flex flex-col items-center gap-3 py-8">
      <div class="h-8 w-8 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"></div>
      <p class="text-sm font-medium">Publishing…</p>
    </div>
  {:else}
    <div class="space-y-3 text-sm">
      <p class="font-medium text-rose-600">{errorText}</p>
      {#if problems.length}
        <ul class="list-disc space-y-1 pl-5 text-slate-700 dark:text-slate-300">{#each problems as p}<li>{p}</li>{/each}</ul>
      {/if}
    </div>
  {/if}
  {#snippet footer()}
    {#if phase === "confirm" || phase === "error"}
      <button class="btn-secondary" onclick={() => (open = false)}>Cancel</button>
      <button class="btn-success" disabled={blocking} onclick={publish}>{phase === "error" ? "Try again" : title}</button>
    {/if}
  {/snippet}
</Modal>
