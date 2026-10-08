<script lang="ts">
  import { fade } from "svelte/transition";
  import { api } from "../api";
  import { relTime } from "../format";
  import { isChief, refreshCounts, toast, toastError } from "../state.svelte";

  interface Row {
    id: string;
    slug: string;
    parent_id: string | null;
    body: string;
    status: "visible" | "pending" | "hidden" | "deleted";
    created_at: number;
    edited_at: number | null;
    commenter_id: string;
    name: string;
    email: string;
    avatar: string | null;
    commenter_status: "active" | "banned";
    article_title: string | null;
  }

  const TABS = [
    ["", "All"],
    ["pending", "Held for review"],
    ["visible", "Visible"],
    ["hidden", "Hidden"],
  ] as const;

  let tab = $state<string>("");
  let data = $state<{ comments: Row[]; counts: Record<string, number>; page: number } | null>(null);

  $effect(() => {
    void tab;
    load();
  });

  // Only the latest request may write `data` (quick tab switches).
  let requestSeq = 0;
  async function load() {
    const seq = ++requestSeq;
    try {
      const d = await api.get<NonNullable<typeof data>>(`/comments${tab ? `?status=${tab}` : ""}`);
      if (seq === requestSeq) data = d;
    } catch (e) {
      if (seq === requestSeq) toastError(e);
    }
  }

  async function setStatus(c: Row, status: "visible" | "hidden" | "deleted") {
    try {
      await api.patch(`/comments/${c.id}`, { status });
      const was = c.status;
      c.status = status;
      if (data) {
        // Keep the held count (tab + sidebar badge) in step.
        if (was === "pending" && data.counts.pending) data.counts.pending--;
        // It no longer belongs in a filtered tab.
        if (tab && tab !== status) data.comments = data.comments.filter((x) => x.id !== c.id);
      }
      if (was === "pending") refreshCounts();
      toast(status === "visible" ? "Comment approved" : status === "hidden" ? "Comment hidden" : "Comment deleted", "success", undefined, 1800);
    } catch (e) {
      toastError(e);
    }
  }

  async function ban(c: Row) {
    const banning = c.commenter_status !== "banned";
    if (banning && !confirm(`Ban ${c.name}? Their comments are hidden and they can't post again.`)) return;
    try {
      await api.patch(`/commenters/${c.commenter_id}`, { status: banning ? "banned" : "active" });
      toast(banning ? `${c.name} is banned` : `${c.name} can comment again`, "success");
      load();
      refreshCounts();
    } catch (e) {
      toastError(e);
    }
  }

  const tone: Record<Row["status"], string> = {
    visible: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
    pending: "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
    hidden: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    deleted: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
  };
</script>

<div class="mx-auto max-w-4xl px-4 py-8 sm:px-6">
  <div class="mb-6">
    <h1 class="text-2xl font-bold tracking-tight">Comments</h1>
    <p class="mt-1 text-sm text-slate-500">Readers sign in with Google to comment. Comments with several links wait here for approval.</p>
  </div>

  <div class="-mx-4 mb-4 overflow-x-auto px-4">
    <div class="flex w-max gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-900">
      {#each TABS as [key, label]}
        <button class="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition {tab === key ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}" onclick={() => (tab = key)}>
          {label}{#if key && data?.counts?.[key]}<span class="ml-1.5 text-xs text-slate-400">{data.counts[key]}</span>{/if}
        </button>
      {/each}
    </div>
  </div>

  <div class="card">
    {#if !data}
      <p class="p-6 text-sm text-slate-500">Loading…</p>
    {:else if !data.comments.length}
      <p class="p-10 text-center text-sm text-slate-500">No comments here.</p>
    {:else}
      <ul class="divide-y divide-slate-100 dark:divide-slate-800">
        {#each data.comments as c (c.id)}
          <li class="flex gap-3 p-4" in:fade={{ duration: 120 }}>
            {#if c.avatar}
              <img src={c.avatar} alt="" class="h-9 w-9 shrink-0 rounded-full" referrerpolicy="no-referrer" />
            {:else}
              <div class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-sm font-bold text-white">{c.name[0]?.toUpperCase()}</div>
            {/if}
            <div class="min-w-0 flex-1">
              <p class="text-sm">
                <span class="font-semibold">{c.name}</span>
                <span class="text-xs text-slate-500">· {c.email} · {relTime(c.created_at)}</span>
                {#if c.commenter_status === "banned"}<span class="ml-1 rounded bg-rose-600 px-1.5 text-[10px] font-bold text-white">BANNED</span>{/if}
              </p>
              <a class="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400" href={`/article/${c.slug}/#comments`} target="_blank">on {c.article_title ?? c.slug} ↗</a>
              <p class="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">{c.body || "(deleted)"}</p>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span class="rounded-full px-2 py-0.5 font-semibold {tone[c.status]}">{c.status === "pending" ? "held" : c.status}</span>
                {#if c.status !== "visible" && c.status !== "deleted"}<button class="btn-ghost !px-2 !py-1 text-xs" onclick={() => setStatus(c, "visible")}>Approve</button>{/if}
                {#if c.status === "visible" || c.status === "pending"}<button class="btn-ghost !px-2 !py-1 text-xs" onclick={() => setStatus(c, "hidden")}>Hide</button>{/if}
                {#if c.status !== "deleted"}<button class="btn-ghost !px-2 !py-1 text-xs text-rose-600" onclick={() => setStatus(c, "deleted")}>Delete</button>{/if}
                {#if isChief()}<button class="btn-ghost !px-2 !py-1 text-xs {c.commenter_status === 'banned' ? '' : 'text-rose-600'}" onclick={() => ban(c)}>{c.commenter_status === "banned" ? "Unban" : "Ban commenter"}</button>{/if}
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
