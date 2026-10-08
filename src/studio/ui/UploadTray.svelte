<script lang="ts">
  import { fly, slide } from "svelte/transition";
  import { clearFinishedUploads, dismissUpload, uploads } from "../images.svelte";
  import { bytes } from "../format";

  const label = { queued: "Waiting", compressing: "Compressing", uploading: "Uploading", done: "Done", error: "Failed" };
  let active = $derived(uploads.filter((u) => u.status !== "done" && u.status !== "error").length);
  let finished = $derived(uploads.length - active);
  let collapsed = $state(false);
</script>

<!-- On phones the tray sits at the top so it never covers a bottom-sheet dialog's buttons. -->
{#if uploads.length}
  <div class="fixed left-4 top-4 z-[55] w-[min(92vw,340px)] overflow-hidden rounded-xl bg-white dark:bg-slate-900 shadow-xl ring-1 ring-slate-900/10 dark:ring-white/10 sm:top-auto sm:bottom-4" transition:fly={{ y: 20, duration: 200 }}>
    <div class="flex items-center justify-between gap-2 px-4 py-2.5 {collapsed ? '' : 'border-b border-slate-100 dark:border-slate-800'}">
      <p class="flex-1 text-xs font-semibold text-slate-700 dark:text-slate-200">
        {active ? `Uploading ${active} image${active === 1 ? "" : "s"}…` : "Uploads"}
      </p>
      {#if finished}
        <button class="text-[11px] font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200" onclick={clearFinishedUploads}>Clear</button>
      {/if}
      <button class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" aria-label={collapsed ? "Expand uploads" : "Collapse uploads"} aria-expanded={!collapsed} onclick={() => (collapsed = !collapsed)}>
        <svg class="h-4 w-4 transition-transform {collapsed ? 'rotate-180' : ''}" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
      </button>
    </div>
    <ul class="max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 {collapsed ? 'hidden' : ''}">
      {#each uploads as u (u.key)}
        <li class="flex items-center gap-3 px-4 py-2" transition:slide={{ duration: 150 }}>
          <img src={u.previewUrl} alt="" class="h-9 w-9 shrink-0 rounded-md object-cover bg-slate-100 dark:bg-slate-800" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-slate-800 dark:text-slate-100">{u.name}</p>
            <p class="text-[11px] {u.status === 'error' ? 'text-rose-600' : 'text-slate-500 dark:text-slate-400'}">
              {u.status === "error" ? u.error : label[u.status]}
              {#if u.status === "done" && u.finalBytes}· {bytes(u.originalBytes)} → {bytes(u.finalBytes)}{/if}
            </p>
            {#if u.status === "compressing" || u.status === "uploading" || u.status === "queued"}
              <div class="mt-1 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div class="h-full rounded-full bg-indigo-500 transition-all duration-500 {u.status === 'queued' ? 'w-[8%]' : u.status === 'compressing' ? 'w-1/2 animate-pulse' : 'w-[85%] animate-pulse'}"></div>
              </div>
            {/if}
          </div>
          {#if u.status === "error" || u.status === "done"}
            <button class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" aria-label={`Dismiss ${u.name}`} onclick={() => dismissUpload(u.key)}>✕</button>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}
