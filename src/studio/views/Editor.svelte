<script lang="ts">
  import { onMount } from "svelte";
  import { fade, slide } from "svelte/transition";
  import { api, ApiError, type ArticleData, type ArticleDetail, type Media } from "../api";
  import { navigate, session, toast, toastError } from "../state.svelte";
  import { deploys, refreshDeploys, watchCommit } from "../deploys.svelte";
  import { bytes, relTime, slugify } from "../format";
  import StateBadge from "../ui/StateBadge.svelte";
  import Modal from "../ui/Modal.svelte";
  import Dropzone from "../ui/Dropzone.svelte";
  import MarkdownField from "../editor/MarkdownField.svelte";
  import DetailsPanel from "../editor/DetailsPanel.svelte";
  import HistoryPanel from "../editor/HistoryPanel.svelte";
  import NotesPanel from "../editor/NotesPanel.svelte";
  import PreviewPane from "../editor/PreviewPane.svelte";
  import PublishDialog from "../editor/PublishDialog.svelte";

  let { id }: { id: string } = $props();

  let detail = $state<ArticleDetail | null>(null);
  let data = $state<ArticleData | null>(null);
  let savedJson = $state("");
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let lastSavedAt = $state<number | null>(null);
  let conflict = $state<{ updatedBy: string | null; updatedAt: number; rev: number } | null>(null);
  let lockedBy = $state<{ id: string; name: string } | null>(null);
  let tab = $state<"write" | "details" | "media">("write");
  let panel = $state<"none" | "history" | "notes">("none");
  let showPreview = $state(true);
  let publishOpen = $state(false);
  let review = $state<null | "submit" | "request_changes" | "approve">(null);
  let reviewNote = $state("");
  let confirm = $state<null | "unpublish" | "delete" | "discard">(null);
  let busy = $state(false);
  let slugAuto = $state(false);
  let menuOpen = $state(false);
  let meta = $state({ categories: [] as string[], tags: [] as string[], authors: [] as string[] });

  // Key order differs between client and server copies; compare canonically.
  const stable = (d: ArticleData | null) => (d ? JSON.stringify(d, Object.keys(d).sort()) : "");
  let dirty = $derived(Boolean(data) && stable(data) !== savedJson);
  let canEdit = $derived(Boolean(detail?.permissions.edit));
  let isChiefUser = $derived(session.user?.role === "chief");
  let openNotes = $derived(detail?.notes.filter((n) => !n.resolvedAt).length ?? 0);
  let future = $derived(data ? Date.parse(data.pubDate) > Date.now() : false);
  let state = $derived(detail?.article.state ?? "draft");
  let building = $derived(Boolean(detail?.article.isLive && detail.article.publishCommit && !detail.built));

  function apply(d: ArticleDetail, replace: boolean) {
    detail = d;
    lockedBy = d.lockedBy;
    if (replace || !data) data = structuredClone($state.snapshot(d.draft)) as ArticleData;
    savedJson = stable(d.draft);
  }

  async function load() {
    try {
      const d = await api.get<ArticleDetail>(`/articles/${id}`);
      apply(d, true);
      conflict = null;
      slugAuto = !d.live && (!d.draft.slug || d.draft.slug.startsWith("untitled-") || d.draft.slug === slugify(d.draft.title));
    } catch (e) {
      toastError(e);
      if (e instanceof ApiError && e.status === 404) navigate("/studio/articles/", true);
    }
  }

  // ---- Saving -------------------------------------------------------------
  let timer: ReturnType<typeof setTimeout>;

  async function save(manual = false, force = false) {
    if (!data || !detail || !canEdit) return;
    if (saving || (conflict && !force)) return;
    if (!manual && !dirty) return;
    clearTimeout(timer);
    saving = true;
    saveError = null;
    const sent = stable(data);
    const payload = $state.snapshot(data);
    try {
      const d = await api.put<ArticleDetail>(`/articles/${id}`, { data: payload, rev: detail.article.rev, autosave: !manual });
      // Keep whatever was typed while the request was in flight.
      apply(d, stable(data) === sent);
      lastSavedAt = Date.now();
      conflict = null;
      if (manual) toast("Saved", "success", undefined, 1800);
    } catch (e) {
      if (e instanceof ApiError && e.data.code === "conflict") {
        conflict = { updatedBy: e.data.updatedBy, updatedAt: e.data.updatedAt, rev: e.data.rev };
      } else {
        saveError = (e as Error).message;
        if (manual) toastError(e);
      }
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    // Autosave 3s after the last change.
    if (!data) return;
    void stable(data);
    if (!dirty || conflict) return;
    clearTimeout(timer);
    timer = setTimeout(() => save(false), 3000);
  });

  $effect(() => {
    // Keep the slug following the title until it's edited by hand (never once live).
    if (data && slugAuto && !detail?.live) {
      const s = slugify(data.title);
      if (s && s !== data.slug) data.slug = s;
    }
  });

  async function overwrite() {
    if (!conflict || !detail) return;
    detail.article.rev = conflict.rev;
    conflict = null;
    await save(true, true);
  }

  // ---- Presence lock ------------------------------------------------------
  async function heartbeat() {
    try {
      const r = await api.post<{ ok: boolean; lockedBy?: { id: string; name: string } }>(`/articles/${id}/lock`);
      lockedBy = r.ok ? null : (r.lockedBy ?? null);
    } catch {
      /* ignore */
    }
  }

  onMount(() => {
    load();
    heartbeat();
    api
      .get<{ categories: { value: string }[]; tags: { value: string }[]; authors: { value: string }[] }>("/meta")
      .then((m) => (meta = { categories: m.categories.map((c) => c.value), tags: m.tags.map((t) => t.value), authors: m.authors.map((a) => a.value) }))
      .catch(() => undefined);
    try {
      showPreview = localStorage.getItem("studio.preview") !== "0";
    } catch {
      /* storage blocked */
    }
    const hb = setInterval(heartbeat, 30_000);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save(true);
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty || saving) e.preventDefault();
    };
    const onHide = () => document.visibilityState === "hidden" && dirty && save(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(hb);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onHide);
      if (dirty) save(false);
      fetch(`/api/studio/articles/${id}/unlock`, { method: "POST", keepalive: true, credentials: "same-origin" }).catch(() => undefined);
    };
  });

  $effect(() => {
    try {
      localStorage.setItem("studio.preview", showPreview ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  });

  // Once the build we were waiting for lands, refresh "built" state.
  $effect(() => {
    if (building && deploys.build?.commit && deploys.build.commit === detail?.article.publishCommit) load();
  });

  // ---- Workflow -----------------------------------------------------------
  async function ensureSaved() {
    if (dirty) await save(true);
    if (conflict) throw new Error("Resolve the editing conflict first.");
  }

  async function runReview() {
    if (!review) return;
    busy = true;
    try {
      await ensureSaved();
      const path = review === "submit" ? "submit" : review === "approve" ? "approve" : "request-changes";
      apply(await api.post<ArticleDetail>(`/articles/${id}/${path}`, { note: reviewNote, rev: detail!.article.rev }), false);
      toast(review === "submit" ? "Submitted for review" : review === "approve" ? "Approved" : "Changes requested", "success");
      review = null;
      reviewNote = "";
    } catch (e) {
      toastError(e);
    } finally {
      busy = false;
    }
  }

  async function startPublish() {
    try {
      await ensureSaved();
      publishOpen = true;
    } catch (e) {
      toastError(e);
    }
  }

  function onPublished(d: ArticleDetail) {
    apply(d, true);
    if (d.commit) watchCommit(d.commit.sha);
    refreshDeploys();
    toast(future ? "Scheduled ✓" : "Published ✓ — the article is viewable at its link now", "success", { label: "View", href: `/article/${d.draft.slug}/` }, 7000);
  }

  async function runConfirm() {
    const what = confirm;
    busy = true;
    try {
      if (what === "unpublish") {
        apply(await api.post<ArticleDetail>(`/articles/${id}/unpublish`), true);
        toast("Unpublished — it disappears from the site after the next build (~1–2 min)", "success");
      } else if (what === "delete") {
        await api.del(`/articles/${id}`);
        toast("Draft deleted", "success");
        navigate("/studio/articles/", true);
      } else if (what === "discard" && detail?.live) {
        data = structuredClone($state.snapshot(detail.live)) as ArticleData;
        await save(true);
        toast("Back to the published version", "success");
      }
      confirm = null;
    } catch (e) {
      toastError(e);
    } finally {
      busy = false;
    }
  }

  async function restore(revisionId: number) {
    try {
      await ensureSaved();
      apply(await api.post<ArticleDetail>(`/articles/${id}/restore`, { revisionId, rev: detail!.article.rev }), true);
      toast("Version restored as your working copy", "success");
    } catch (e) {
      toastError(e);
    }
  }

  function addMedia(m: Media[]) {
    if (!detail) return;
    const known = new Set(detail.media.map((x) => x.id));
    detail.media = [...m.filter((x) => !known.has(x.id)), ...detail.media];
  }

  async function setAlt(m: Media, alt: string) {
    try {
      await api.patch(`/media/${m.id}`, { alt });
      m.alt = alt;
    } catch (e) {
      toastError(e);
    }
  }

  async function deleteMedia(m: Media) {
    try {
      await api.del(`/media/${m.id}`);
      detail!.media = detail!.media.filter((x) => x.id !== m.id);
    } catch (e) {
      toastError(e);
    }
  }

  const saveLabel = $derived(
    conflict ? "Conflict" : saving ? "Saving…" : saveError ? "Not saved" : dirty ? "Unsaved changes" : lastSavedAt ? `Saved ${relTime(lastSavedAt)}` : "All changes saved",
  );
</script>

{#if !detail || !data}
  <div class="flex h-[70vh] items-center justify-center">
    <div class="h-8 w-8 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"></div>
  </div>
{:else}
  <!-- Top bar -->
  <div class="sticky top-0 z-30 border-b border-slate-200/70 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-900/85">
    <div class="flex flex-wrap items-center gap-2 px-4 py-2.5">
      <a href="/studio/articles/" class="btn-ghost !px-2" title="All articles">
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clip-rule="evenodd" /></svg>
      </a>
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <StateBadge {state} live={detail.article.isLive} pending={detail.article.hasPendingChanges} />
        <span class="hidden truncate text-xs sm:inline {saveError || conflict ? 'text-rose-600' : 'text-slate-500'}" title={saveError ?? ""}>
          {#if saving}<span class="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400"></span>{/if}{saveLabel}
        </span>
        {#if building}
          <span class="hidden items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200 md:inline-flex dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30" in:fade>
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500"></span>Site building…
          </span>
        {/if}
      </div>

      <button class="btn-ghost relative !px-2.5" onclick={() => (panel = panel === "notes" ? "none" : "notes")} title="Review notes">
        Notes{#if openNotes}<span class="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">{openNotes}</span>{/if}
      </button>
      <button class="btn-ghost !px-2.5" onclick={() => (panel = panel === "history" ? "none" : "history")}>History</button>
      <button class="btn-ghost hidden !px-2.5 lg:inline-flex" onclick={() => (showPreview = !showPreview)}>{showPreview ? "Hide preview" : "Preview"}</button>
      {#if canEdit}
        <button class="btn-secondary" disabled={saving || (!dirty && !conflict)} onclick={() => save(true)}>Save</button>
      {/if}

      {#if isChiefUser}
        {#if state === "in_review" || state === "approved"}
          <button class="btn-secondary" onclick={() => (review = "request_changes")}>Request changes</button>
        {/if}
        {#if state === "in_review"}
          <button class="btn-secondary" onclick={() => (review = "approve")}>Approve</button>
        {/if}
        {#if state !== "published" || !detail.article.isLive}
          <button class="btn-success" onclick={startPublish}>{detail.live ? "Publish changes" : future ? "Schedule" : "Publish"}</button>
        {/if}
      {:else if detail.permissions.submit && (state === "draft" || state === "changes_requested")}
        <button class="btn-primary" onclick={() => (review = "submit")}>Submit for review</button>
      {:else if state === "in_review"}
        <span class="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">Waiting for the chief editor</span>
      {:else if state === "approved"}
        <span class="rounded-lg bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">Approved — awaiting publish</span>
      {/if}

      <div class="relative">
        <button class="btn-ghost !px-2" aria-label="More actions" onclick={() => (menuOpen = !menuOpen)}>⋯</button>
        {#if menuOpen}
          <button class="fixed inset-0 z-10 cursor-default" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>
          <div class="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl bg-white py-1 text-sm shadow-xl ring-1 ring-slate-900/10 dark:bg-slate-800 dark:ring-white/10" transition:slide={{ duration: 120 }}>
            <a class="block px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700" href={`/live/preview/?id=${detail.article.id}`} target="_blank" onclick={() => (menuOpen = false)}>Open preview in new tab ↗</a>
            {#if detail.article.isLive}
              <a class="block px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700" href={`/article/${detail.live?.slug ?? data.slug}/`} target="_blank" onclick={() => (menuOpen = false)}>View live article ↗</a>
            {/if}
            {#if detail.live && state !== "published" && canEdit}
              <button class="block w-full px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700" onclick={() => { menuOpen = false; confirm = "discard"; }}>Discard unpublished changes</button>
            {/if}
            {#if !isChiefUser && detail.permissions.submit && state !== "in_review" && detail.live && state !== "published"}
              <button class="block w-full px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700" onclick={() => { menuOpen = false; review = "submit"; }}>Submit changes for review</button>
            {/if}
            {#if detail.permissions.unpublish}
              <button class="block w-full px-4 py-2 text-left text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10" onclick={() => { menuOpen = false; confirm = "unpublish"; }}>Unpublish</button>
            {/if}
            {#if detail.permissions.delete}
              <button class="block w-full px-4 py-2 text-left text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10" onclick={() => { menuOpen = false; confirm = "delete"; }}>Delete draft</button>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    {#if conflict}
      <div class="flex flex-wrap items-center gap-3 border-t border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200" transition:slide>
        <span class="flex-1"><strong>{conflict.updatedBy ?? "Someone"}</strong> saved a newer version {relTime(conflict.updatedAt)}. Your latest edits aren't saved.</span>
        <button class="btn-secondary !py-1" onclick={load}>Load their version</button>
        <button class="btn-danger !py-1" onclick={overwrite}>Keep mine</button>
      </div>
    {:else if lockedBy}
      <div class="border-t border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200" transition:slide>
        <strong>{lockedBy.name}</strong> is editing this article right now. Your changes still save, but you may overwrite each other.
      </div>
    {/if}
  </div>

  <div class="flex">
    <!-- Editor column -->
    <div class="min-w-0 flex-1 {showPreview ? 'lg:max-w-[52%] xl:max-w-[50%]' : ''}">
      <div class="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        {#if detail.notes.some((n) => !n.resolvedAt) && state === "changes_requested"}
          <button class="mb-5 w-full rounded-xl bg-rose-50 p-4 text-left ring-1 ring-rose-200 transition hover:bg-rose-100 dark:bg-rose-500/10 dark:ring-rose-500/30" onclick={() => (panel = "notes")}>
            <p class="text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">Changes requested</p>
            <p class="mt-1 line-clamp-2 text-sm text-rose-900 dark:text-rose-100">{detail.notes.filter((n) => !n.resolvedAt).at(-1)?.body}</p>
          </button>
        {/if}

        <textarea
          class="w-full resize-none border-0 bg-transparent p-0 text-3xl font-bold leading-tight tracking-tight text-slate-900 [field-sizing:content] placeholder:text-slate-300 focus:outline-none focus:ring-0 dark:text-white dark:placeholder:text-slate-700"
          rows="1"
          placeholder="Article title"
          disabled={!canEdit}
          bind:value={data.title}
        ></textarea>
        <p class="mb-5 text-xs text-slate-400">Tip: use "Game Name | Review headline" — the part before | becomes the first line of the title.</p>

        <div class="mb-5 flex gap-1 border-b border-slate-200 dark:border-slate-800">
          {#each [["write", "Write"], ["details", "Details"], ["media", `Media${detail.media.length ? ` (${detail.media.length})` : ""}`]] as [key, label]}
            <button
              class="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition {tab === key ? 'border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}"
              onclick={() => (tab = key as typeof tab)}>{label}</button
            >
          {/each}
        </div>

        {#if tab === "write"}
          <MarkdownField bind:value={data.body} articleId={detail.article.id} articleMedia={detail.media} disabled={!canEdit} onmediaadded={addMedia} />
        {:else if tab === "details"}
          <DetailsPanel bind:data bind:slugAuto articleId={detail.article.id} articleMedia={detail.media} {meta} isLive={Boolean(detail.live)} disabled={!canEdit} onmediaadded={addMedia} />
        {:else}
          <div class="space-y-4">
            <Dropzone articleId={detail.article.id} onuploaded={addMedia} />
            {#if !detail.media.length}
              <p class="py-6 text-center text-sm text-slate-500">No images uploaded for this article yet.</p>
            {:else}
              <ul class="grid gap-3 sm:grid-cols-2">
                {#each detail.media as m (m.id)}
                  <li class="card flex gap-3 p-2.5" in:fade={{ duration: 150 }}>
                    <img src={m.url} alt={m.alt ?? ""} loading="lazy" class="h-20 w-28 shrink-0 rounded-lg bg-slate-100 object-cover dark:bg-slate-800" />
                    <div class="min-w-0 flex-1 space-y-1.5">
                      <p class="truncate text-xs font-medium" title={m.filename}>{m.filename}</p>
                      <p class="text-[11px] text-slate-500">{m.width ? `${m.width}×${m.height} · ` : ""}{bytes(m.bytes)}{m.committed ? " · on site" : ""}</p>
                      <input class="input !py-1 !text-xs" placeholder="Alt text (describe the image)" value={m.alt ?? ""} onchange={(e) => setAlt(m, e.currentTarget.value)} />
                      <div class="flex flex-wrap gap-1">
                        <button class="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700" onclick={() => { data!.body = `${data!.body.replace(/\s+$/, "")}\n\n![${m.alt || ""}](${m.url})\n`; toast("Added to the end of the article", "info", undefined, 2000); }}>Insert</button>
                        <button class="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700" onclick={() => (data!.thumb = m.url)}>Thumbnail</button>
                        <button class="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700" onclick={() => (data!.large = m.url)}>Hero</button>
                        <button class="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700" onclick={() => (data!.gallery = [...(data!.gallery ?? []).filter((g) => g !== m.url), m.url])}>Gallery</button>
                        {#if !m.committed}
                          <button class="rounded px-1.5 py-0.5 text-[11px] font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10" onclick={() => deleteMedia(m)}>Delete</button>
                        {/if}
                      </div>
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    {#if showPreview}
      <div class="sticky top-[57px] hidden h-[calc(100vh-57px)] flex-1 border-l border-slate-200/70 dark:border-slate-800 lg:block" transition:fade={{ duration: 150 }}>
        <PreviewPane {data} />
      </div>
    {/if}
  </div>

  {#if panel === "history"}
    <HistoryPanel articleId={detail.article.id} current={data} canRestore={canEdit} onrestore={restore} onclose={() => (panel = "none")} />
  {:else if panel === "notes"}
    <NotesPanel articleId={detail.article.id} notes={detail.notes} onupdate={(d) => apply(d, false)} onclose={() => (panel = "none")} />
  {/if}

  <PublishDialog bind:open={publishOpen} {detail} {data} onpublished={onPublished} />

  <Modal
    open={review !== null}
    title={review === "submit" ? "Submit for review" : review === "approve" ? "Approve article" : "Request changes"}
    onclose={() => (review = null)}
  >
    <div class="space-y-3 text-sm">
      <p class="text-slate-600 dark:text-slate-300">
        {#if review === "submit"}The chief editor will be able to review, request changes or publish it.{:else if review === "approve"}Marks the article as ready. You can publish it any time.{:else}The writer sees your note at the top of the article.{/if}
      </p>
      <textarea class="input min-h-[110px]" placeholder={review === "request_changes" ? "What needs to change? (required)" : "Add a note (optional)"} bind:value={reviewNote}></textarea>
    </div>
    {#snippet footer()}
      <button class="btn-secondary" onclick={() => (review = null)}>Cancel</button>
      <button class={review === "request_changes" ? "btn-danger" : "btn-primary"} disabled={busy || (review === "request_changes" && !reviewNote.trim())} onclick={runReview}>
        {review === "submit" ? "Submit" : review === "approve" ? "Approve" : "Request changes"}
      </button>
    {/snippet}
  </Modal>

  <Modal open={confirm !== null} title={confirm === "unpublish" ? "Unpublish article?" : confirm === "delete" ? "Delete draft?" : "Discard unpublished changes?"} size="sm" onclose={() => (confirm = null)}>
    <p class="text-sm text-slate-600 dark:text-slate-300">
      {#if confirm === "unpublish"}It's removed from the site after the next build. The article and its history stay in the studio.{:else if confirm === "delete"}This permanently deletes the draft and its unpublished images.{:else}Your working copy goes back to what's live on the site. You can still find these edits in History.{/if}
    </p>
    {#snippet footer()}
      <button class="btn-secondary" onclick={() => (confirm = null)}>Cancel</button>
      <button class="btn-danger" disabled={busy} onclick={runConfirm}>{confirm === "unpublish" ? "Unpublish" : confirm === "delete" ? "Delete" : "Discard"}</button>
    {/snippet}
  </Modal>
{/if}
