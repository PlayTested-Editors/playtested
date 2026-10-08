<script lang="ts">
  import { onMount, setContext, tick, untrack } from "svelte";
  import { fade, slide } from "svelte/transition";
  import { api, ApiError, type ArticleData, type ArticleDetail, type LockStatus, type Media } from "../api";
  import { navigate, refreshCounts, reloadForNewVersion, route, session, setLeaveGuard, toast, toastError, toggleTheme } from "../state.svelte";
  import { deploys, refreshDeploys, watchCommit } from "../deploys.svelte";
  import { STATE_LABEL, bytes, dateTime, relTime, slugify } from "../format";
  import StateBadge from "../ui/StateBadge.svelte";
  import Modal from "../ui/Modal.svelte";
  import Dropzone from "../ui/Dropzone.svelte";
  import MarkdownField from "../editor/MarkdownField.svelte";
  import DetailsPanel from "../editor/DetailsPanel.svelte";
  import HistoryPanel from "../editor/HistoryPanel.svelte";
  import NotesPanel from "../editor/NotesPanel.svelte";
  import PreviewPane from "../editor/PreviewPane.svelte";
  import PublishDialog from "../editor/PublishDialog.svelte";
  import AiWriteGuide from "../editor/AiWriteGuide.svelte";
  import EditorTour from "../ui/EditorTour.svelte";
  import { tidyFormatting } from "../editor/tidy";

  let { id }: { id: string } = $props();

  let detail = $state<ArticleDetail | null>(null);
  let data = $state<ArticleData | null>(null);
  // The image picker's "Find screenshots" searches for this game by default.
  setContext("studio.game", () => data?.game?.trim() || gameFromTitle(data?.title ?? ""));
  function gameFromTitle(title: string): string {
    // "Headline | Game Name Review" → "Game Name"
    const tail = title.includes("|") ? title.split("|").pop()! : title;
    return tail.replace(/\s*[-–:]?\s*(early access\s+)?(review|first impressions?|preview|demo)\b.*$/i, "").trim();
  }
  let savedJson = $state("");
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let lastSavedAt = $state<number | null>(null);
  let conflict = $state<{ updatedBy: string | null; updatedAt: number; rev: number } | null>(null);
  // Someone else saved a newer version than the one on screen (seen by the heartbeat,
  // or a review/publish refused as stale). Reloading shows it.
  let stale = $state<{ by: string | null; at: number } | null>(null);
  let lockedBy = $state<{ id: string; name: string } | null>(null);
  let tab = $state<"write" | "details" | "media">("write");
  let aiOpen = $state(false);

  // ---- Empty and brand-new drafts --------------------------------------------
  // "New article" creates a draft right away. Leaving it empty deletes it again,
  // and leaving a new one that has content asks whether to keep it.
  const isFresh = untrack(() => route.query.get("new") === "1");
  let draftDeleted = false;
  let leaveChoice = $state<null | ((choice: "keep" | "delete" | "stay") => void)>(null);
  const isBlank = (d: ArticleData) =>
    !d.title.trim() &&
    !d.body.trim() &&
    !d.description.trim() &&
    !d.game?.trim() &&
    !d.thumb &&
    !d.large &&
    !d.gallery?.length &&
    !d.tags.length &&
    (d.score === null || d.score === undefined);
  /** A never-published draft with nothing in it, that this user may delete. */
  const isEmptyDraft = () => Boolean(detail && data && !detail.live && detail.permissions.delete && !detail.media.length && isBlank(data));

  async function deleteThisDraft(quiet: boolean) {
    draftDeleted = true;
    clearTimeout(timer);
    try {
      await api.del(`/articles/${id}`);
      if (!quiet) toast("Draft deleted", "success");
    } catch (e) {
      if (!quiet) toastError(e);
    }
  }

  $effect(() => {
    if (!isFresh || !detail || !data || detail.live || !detail.permissions.delete || isBlank(data)) return;
    setLeaveGuard(async (to) => {
      if (draftDeleted || to.includes(`/articles/${id}/`)) return true;
      const choice = await new Promise<"keep" | "delete" | "stay">((resolve) => (leaveChoice = resolve));
      leaveChoice = null;
      if (choice === "stay") return false;
      if (choice === "delete") await deleteThisDraft(false);
      else await ensureSaved();
      return true;
    });
    return () => setLeaveGuard(null);
  });

  /** Pros / Cons sections in the site's usual format (only real, labelled lists). */
  function tidyBody() {
    if (!data) return;
    const { text, styles, sections } = tidyFormatting(data.body);
    if (!styles && !sections) return toast("Formatting already looks right. Nothing to change.", "info");
    const before = data.body;
    data.body = text;
    const parts = [sections ? `${sections} Pros/Cons section${sections === 1 ? "" : "s"}` : "", styles ? `removed pasted styling from ${styles} place${styles === 1 ? "" : "s"}` : ""].filter(Boolean);
    toast(`Tidied: ${parts.join(", ")}.`, "success", { label: "Undo", run: () => data && (data.body = before) }, 8000);
  }

  /** A draft from the "Write with AI" guide. The old text stays in History. */
  function useAiDraft(d: { title: string | null; score: number | null; body: string; mode: "replace" | "append" }) {
    if (!data) return;
    if (d.title) data.title = d.title;
    if (d.score !== null && (data.score === null || data.score === undefined)) data.score = d.score;
    data.body = d.mode === "append" && data.body.trim() ? `${data.body.trimEnd()}\n\n${d.body}` : d.body;
    toast(d.mode === "append" ? "Draft added below your text" : "Draft added. Now make it yours.", "success");
  }
  const readMode = () => {
    try {
      return localStorage.getItem("studio.editorMode") === "markdown" ? "markdown" : "visual";
    } catch {
      return "visual";
    }
  };
  let editorMode = $state<"visual" | "markdown">(readMode());
  // The visual editor is a big chunk; only load it when someone uses it.
  let richEditor: Promise<typeof import("../editor/RichEditor.svelte")> | null = null;
  // A failed load right after a deploy means this tab runs the old build: reload
  // once (the beforeunload handler backs up unsaved text first).
  const loadRich = () =>
    (richEditor ??= import("../editor/RichEditor.svelte").catch((e) => {
      richEditor = null;
      if (!reloadForNewVersion()) throw e;
      return new Promise<never>(() => {});
    }));
  // Never spin forever: after 15s offer a reload.
  let richSlow = $state(false);
  $effect(() => {
    if (editorMode !== "visual") return;
    const t = setTimeout(() => (richSlow = true), 15_000);
    void loadRich().then(() => clearTimeout(t), () => clearTimeout(t));
    return () => clearTimeout(t);
  });
  // The mounted visual editor: it holds back keystrokes for 250ms, flush() hands them over now.
  let rich = $state<{ flush: () => void } | null>(null);
  function setMode(m: "visual" | "markdown") {
    editorMode = m;
    try {
      localStorage.setItem("studio.editorMode", m);
    } catch {}
  }
  let panel = $state<"none" | "history" | "notes">("none");
  // History opens on "compare with the live version" (from the banner / publish dialog).
  let historyLive = $state(false);
  let historyKey = $state(0); // remounts the panel so it opens on the comparison again
  function compareWithLive() {
    publishOpen = false;
    historyLive = true;
    historyKey++;
    panel = "history";
  }
  let showPreview = $state(true);
  let publishOpen = $state(false);
  let review = $state<null | "submit" | "request_changes" | "approve">(null);
  let reviewNote = $state("");
  let confirm = $state<null | "unpublish" | "delete" | "discard">(null);
  let busy = $state(false);
  let slugAuto = $state(false);
  // Numbering for an auto slug that another article already uses ("title-2").
  let slugDedupe = $state<{ base: string; n: number } | null>(null);
  let menuOpen = $state(false);
  let meta = $state({ categories: [] as string[], tags: [] as string[], authors: [] as string[] });
  // Unsaved edits found in this browser from an earlier visit (session expired, tab closed…).
  let recovered = $state<{ data: ArticleData; at: number } | null>(null);
  let destroyed = false;

  // Key order differs between client and server copies; compare canonically.
  const stable = (d: ArticleData | null) => (d ? JSON.stringify(d, Object.keys(d).sort()) : "");
  let dirty = $derived(Boolean(data) && stable(data) !== savedJson);
  let canEdit = $derived(Boolean(detail?.permissions.edit));

  // ---- Editor tour (ui/EditorTour.svelte) ----------------------------------
  // Offered once to people who joined in the last 30 days (the welcome tour's
  // newcomers); anyone can replay it from the ⋯ menu.
  let tourOpen = $state(false);
  let tourOffer = $state(false);
  const tourKey = () => `studio.editorTour.seen:${session.user?.id}`;
  function tourSeen(): boolean {
    try {
      return localStorage.getItem(tourKey()) === "1";
    } catch {
      return true;
    }
  }
  function markTourSeen() {
    tourOffer = false;
    try {
      localStorage.setItem(tourKey(), "1");
    } catch {
      /* storage blocked */
    }
  }
  async function startTour() {
    markTourSeen();
    menuOpen = false;
    tab = "write";
    await tick();
    tourOpen = true;
  }
  $effect(() => {
    const u = session.user;
    if (!detail || !canEdit || !u || u.realRole || !u.onboardedAt || Date.now() - u.onboardedAt > 30 * 86_400_000) return;
    if (!untrack(tourSeen)) tourOffer = true;
  });
  let isChiefUser = $derived(session.user?.role === "chief");
  let openNotes = $derived(detail?.notes.filter((n) => !n.resolvedAt).length ?? 0);
  let future = $derived(data ? Date.parse(data.pubDate) > Date.now() : false);
  let articleState = $derived(detail?.article.state ?? "draft");
  // A live article whose working copy differs from what readers see.
  let liveEdited = $derived(Boolean(detail?.live) && canEdit && (articleState !== "published" || dirty));
  // Who made the pending changes, when it wasn't you.
  let pendingBy = $derived.by(() => {
    const by = detail?.article.updatedBy;
    if (!detail || articleState === "published" || !by || by === session.user?.id) return null;
    return detail.names[by] ?? "Someone";
  });
  // The chief's request, shown to the writer at the top of the article.
  let changeRequest = $derived(
    articleState === "changes_requested" && detail?.review?.kind === "request_changes" && detail.review.note ? detail.review : null,
  );
  let building = $derived(Boolean(detail?.article.isLive && detail.article.publishCommit && !detail.built));

  const flushEditor = () => rich?.flush();

  function apply(d: ArticleDetail, replace: boolean) {
    detail = d;
    lockedBy = d.lockedBy;
    if (replace || !data) data = structuredClone($state.snapshot(d.draft)) as ArticleData;
    savedJson = stable(d.draft);
  }

  /**
   * Take notes, workflow state, media and permissions from a response, but never
   * the draft or its rev: those only change through our own saves and loads. (If
   * someone else saved meanwhile, our next save gets a proper conflict instead of
   * silently overwriting them.)
   */
  function applyMeta(d: ArticleDetail) {
    if (!detail) return apply(d, true);
    detail = { ...d, draft: detail.draft, article: { ...d.article, rev: detail.article.rev } };
    lockedBy = d.lockedBy;
  }

  async function load() {
    try {
      const d = await api.get<ArticleDetail>(`/articles/${id}`);
      apply(d, true);
      conflict = null;
      stale = null;
      slugAuto = !d.live && (!d.draft.slug || d.draft.slug.startsWith("untitled-") || d.draft.slug === slugify(d.draft.title) || d.draft.slug === autoSlugBase(d.draft));
      checkBackup(d);
    } catch (e) {
      toastError(e);
      if (e instanceof ApiError && e.status === 404) navigate("/studio/articles/", true);
    }
  }

  // ---- Local backup ---------------------------------------------------------
  // Unsaved edits are mirrored to this browser until the server has them, so a
  // signed-out session, a crash or a closed tab can't lose them.
  const backupKey = () => `studio.backup.${id}`;
  let backupTimer: ReturnType<typeof setTimeout>;

  function writeBackup() {
    if (!data || !detail) return;
    try {
      localStorage.setItem(backupKey(), JSON.stringify({ data: $state.snapshot(data), rev: detail.article.rev, at: Date.now() }));
    } catch {
      /* storage full or blocked */
    }
  }

  function clearBackup() {
    clearTimeout(backupTimer);
    try {
      localStorage.removeItem(backupKey());
    } catch {
      /* storage blocked */
    }
  }

  function checkBackup(d: ArticleDetail) {
    try {
      const raw = localStorage.getItem(backupKey());
      if (!raw) return;
      const b = JSON.parse(raw) as { data?: ArticleData; rev?: number; at?: number };
      if (!b?.data || typeof b.at !== "number") return clearBackup();
      // Only offer it when it's newer than the saved draft and actually different.
      if (b.at > d.article.updatedAt && stable(b.data) !== stable(d.draft)) recovered = { data: b.data, at: b.at };
      else clearBackup();
    } catch {
      /* unreadable backup: ignore */
    }
  }

  function restoreBackup() {
    if (!recovered || !data) return;
    data = $state.snapshot(recovered.data) as ArticleData;
    recovered = null;
    toast("Recovered your unsaved changes", "success");
  }

  function dropBackup() {
    recovered = null;
    clearBackup();
  }

  $effect(() => {
    // Mirror unsaved edits locally (debounced), drop the copy once they're saved.
    if (!data) return;
    void stable(data);
    if (!dirty) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(writeBackup, 800);
  });

  // ---- Saving -------------------------------------------------------------
  let timer: ReturnType<typeof setTimeout>;
  let inflight: Promise<"ok" | "failed" | "slug"> | null = null;
  // The last save error already shown as a toast (autosave retries don't repeat it).
  let toastedError: string | null = null;

  /** Wait for a save already on its way. */
  async function settle() {
    while (inflight) await inflight;
  }

  /**
   * Save the working copy. A save already in flight is waited for (then whatever
   * changed since is saved), never dropped. Resolves true when it's all saved.
   */
  async function save(manual = false, force = false): Promise<boolean> {
    flushEditor();
    await settle();
    for (let attempt = 0; ; attempt++) {
      if (!data || !detail || !canEdit) return false;
      if (conflict && !force) return false;
      if (!manual && !dirty) return true;
      clearTimeout(timer);
      const run = put(manual);
      inflight = run;
      let result: "ok" | "failed" | "slug";
      try {
        result = await run;
      } finally {
        if (inflight === run) inflight = null;
      }
      if (result === "ok") {
        // Edits made while that request was out: autosave them too.
        if (dirty && !conflict && !destroyed) {
          clearTimeout(timer);
          timer = setTimeout(() => save(false), 3000);
        } else if (!dirty) clearBackup();
        return true;
      }
      if (result === "failed" || attempt >= 20) return false;
      // The title's slug belongs to another article: number this one and try again.
      bumpSlug();
      await tick();
    }
  }

  async function put(manual: boolean): Promise<"ok" | "failed" | "slug"> {
    saving = true;
    saveError = null;
    const sent = stable(data);
    const payload = $state.snapshot(data);
    try {
      const d = await api.put<ArticleDetail>(`/articles/${id}`, { data: payload, rev: detail!.article.rev, autosave: !manual });
      // Keep whatever was typed while the request was in flight.
      apply(d, stable(data) === sent);
      lastSavedAt = Date.now();
      conflict = null;
      stale = null;
      toastedError = null;
      if (manual) toast("Saved", "success", undefined, 1800);
      return "ok";
    } catch (e) {
      if (e instanceof ApiError && e.data.code === "conflict") {
        conflict = { updatedBy: e.data.updatedBy, updatedAt: e.data.updatedAt, rev: e.data.rev };
        return "failed";
      }
      if (e instanceof ApiError && e.data.code === "slug_taken" && slugAuto && !detail?.live) return "slug";
      saveError =
        e instanceof ApiError && e.data.code === "slug_taken"
          ? `${e.message} Change the URL slug under Details — nothing else saves until then.`
          : (e as Error).message;
      // Autosave failures are loud too: a toast the first time, then the banner stays up.
      if (manual || toastedError !== saveError) toastError(e);
      toastedError = saveError;
      return "failed";
    } finally {
      saving = false;
    }
  }

  /** The slug a new article gets: from the game name, or the title if there is no game. */
  const autoSlugBase = (d: ArticleData) => slugify(d.game?.trim() || d.title);

  function bumpSlug() {
    if (!data) return;
    const base = autoSlugBase(data);
    if (base) {
      slugDedupe = { base, n: slugDedupe?.base === base ? slugDedupe.n + 1 : 2 };
    } else {
      // No title to follow: number the current slug directly.
      const m = /^(.*?)-(\d+)$/.exec(data.slug);
      data.slug = m ? `${m[1]}-${Number(m[2]) + 1}` : `${data.slug}-2`;
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
    // Keep the slug following the game name (or title) until it's edited by hand (never once live).
    if (data && slugAuto && !detail?.live) {
      const base = autoSlugBase(data);
      const s = base && slugDedupe?.base === base ? `${base}-${slugDedupe.n}` : base;
      if (s && s !== data.slug) data.slug = s;
    }
  });

  async function overwrite() {
    if (!conflict || !detail) return;
    detail.article.rev = conflict.rev;
    conflict = null;
    await save(true, true);
  }

  // ---- Presence lock & live status ------------------------------------------
  // The presence lock is only taken once you've edited here (reading an article
  // never shows you as "editing"). Every heartbeat also brings the workflow
  // state, the latest rev and the open-note count, so reviews and other people's
  // saves show up without a reload.
  let editedHere = $state(false);
  let refreshingMeta = false;

  $effect(() => {
    if (dirty && !editedHere) {
      editedHere = true;
      untrack(() => void heartbeat());
    }
  });

  async function heartbeat() {
    try {
      const r = await api.post<LockStatus>(`/articles/${id}/lock`, { hold: editedHere });
      lockedBy = r.lockedBy;
      if (!detail || destroyed) return;
      // A newer version than ours, saved while no save of ours was on its way.
      if (r.rev > detail.article.rev && !inflight && !saving && !conflict) {
        stale = { by: r.updatedByName, at: r.updatedAt };
      }
      // Submitted, approved, changes requested, notes added…: refresh state and notes
      // (never the draft or its rev).
      if ((r.state !== detail.article.state || r.openNotes !== openNotes) && !refreshingMeta) {
        const before = detail.article.state;
        refreshingMeta = true;
        try {
          const d = await api.get<ArticleDetail>(`/articles/${id}`);
          if (destroyed || !detail) return;
          applyMeta(d);
          if (d.article.state !== before) {
            const by = d.review?.byName;
            const msg =
              d.article.state === "changes_requested"
                ? `${by ?? "The chief editor"} requested changes`
                : d.article.state === "approved"
                  ? "Approved by the chief editor"
                  : d.article.state === "in_review"
                    ? `${by ?? "Someone"} submitted this for review`
                    : `Status changed: ${STATE_LABEL[d.article.state]}`;
            toast(msg, "info", undefined, 7000);
            refreshCounts();
          }
        } finally {
          refreshingMeta = false;
        }
      }
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
      flushEditor();
      if (dirty || saving) {
        writeBackup();
        e.preventDefault();
      }
    };
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      flushEditor();
      if (dirty) {
        writeBackup();
        save(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      // The visual editor has already flushed its last keystrokes (children unmount first).
      destroyed = true;
      clearInterval(hb);
      clearTimeout(timer);
      clearTimeout(builtTimer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onHide);
      const unlock = () => fetch(`/api/studio/articles/${id}/unlock`, { method: "POST", keepalive: true, credentials: "same-origin" }).catch(() => undefined);
      if (draftDeleted) return;
      if (isEmptyDraft()) {
        // Nothing was written: don't leave an "Untitled" draft behind.
        void deleteThisDraft(true);
        return;
      }
      if (dirty || inflight) {
        if (dirty) writeBackup();
        // Saving re-takes the lock, so release it afterwards.
        save(false).finally(unlock);
      } else unlock();
    };
  });

  $effect(() => {
    try {
      localStorage.setItem("studio.preview", showPreview ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  });

  // ---- Waiting for the site build ---------------------------------------
  // When a new build lands, ask the server once whether it includes our publish
  // (it compares commit times, so a later build counts too). Only the "built" flag
  // is taken from the answer: never the draft, so nothing typed meanwhile is lost.
  let checkedBuild = "";
  let builtTimer: ReturnType<typeof setTimeout>;
  let publishedAt: { sha: string; time: number } | null = null;

  $effect(() => {
    const b = deploys.build;
    if (!building || !b || !detail) return;
    const sha = detail.article.publishCommit;
    const key = `${b.commit ?? ""}@${b.commitTime ?? b.builtAt}`;
    untrack(() => {
      // A live build from a commit at least as new as ours includes it.
      if (publishedAt && publishedAt.sha === sha && b.commitTime && b.commitTime >= Math.floor(publishedAt.time / 1000) * 1000) {
        detail!.built = true;
        return;
      }
      if (key === checkedBuild) return;
      checkedBuild = key;
      checkBuilt(0);
    });
  });

  async function checkBuilt(tries: number) {
    clearTimeout(builtTimer);
    try {
      const d = await api.get<ArticleDetail>(`/articles/${id}`);
      if (destroyed || !detail) return;
      if (d.built) detail.built = true;
      // The server caches build info for up to a minute: ask again a few times.
      else if (tries < 4) builtTimer = setTimeout(() => checkBuilt(tries + 1), 20_000);
    } catch {
      /* next build change asks again */
    }
  }

  // ---- Workflow -----------------------------------------------------------
  /** Everything typed so far is on the server (waits for a save in flight, flushes the visual editor). */
  async function ensureSaved() {
    flushEditor();
    await settle();
    if (dirty) await save(true);
    if (conflict) throw new Error("Resolve the editing conflict first.");
    if (dirty) throw new Error(saveError ? `Your changes couldn't be saved: ${saveError}` : "Your latest changes aren't saved yet. Try again.");
  }

  async function runReview() {
    if (!review) return;
    busy = true;
    try {
      await ensureSaved();
      const path = review === "submit" ? "submit" : review === "approve" ? "approve" : "request-changes";
      applyMeta(await api.post<ArticleDetail>(`/articles/${id}/${path}`, { note: reviewNote, rev: detail!.article.rev }));
      toast(review === "submit" ? "Submitted for review" : review === "approve" ? "Approved" : "Changes requested", "success");
      review = null;
      reviewNote = "";
      refreshCounts();
    } catch (e) {
      if (e instanceof ApiError && e.data.code === "conflict") {
        // The text changed since this copy was loaded: review the latest one first.
        stale = { by: e.data.updatedBy ?? null, at: e.data.updatedAt };
        review = null;
        toast(`${e.data.updatedBy ?? "Someone"} saved a newer version. Reload to review what's there now — your note is kept.`, "error", undefined, 8000);
      } else toastError(e);
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
    // Anything typed after the publish started stays (and autosaves).
    flushEditor();
    apply(d, !dirty);
    if (!dirty) clearBackup();
    if (d.commit) {
      publishedAt = { sha: d.commit.sha, time: d.commit.time };
      watchCommit(d.commit.sha, d.commit.time);
    }
    refreshDeploys();
    refreshCounts();
    // A scheduled article isn't on the site until its date: no "View" link then.
    const scheduled = Date.parse(d.live?.pubDate ?? d.draft.pubDate) > Date.now();
    if (scheduled) toast(`Scheduled ✓ — it appears on the site on ${dateTime(d.live?.pubDate ?? d.draft.pubDate)}`, "success", undefined, 7000);
    else toast("Published ✓ — the article is viewable at its link now", "success", { label: "View", href: `/article/${d.draft.slug}/` }, 7000);
  }

  async function runConfirm() {
    const what = confirm;
    busy = true;
    try {
      if (what === "unpublish") {
        await ensureSaved();
        apply(await api.post<ArticleDetail>(`/articles/${id}/unpublish`), true);
        toast("Unpublished — it disappears from the site after the next build (~1–2 min)", "success");
      } else if (what === "delete") {
        await api.del(`/articles/${id}`);
        draftDeleted = true;
        setLeaveGuard(null);
        clearBackup();
        data = null; // nothing left to save on the way out
        refreshCounts();
        toast("Article deleted", "success");
        navigate("/studio/articles/", true);
      } else if (what === "discard" && detail?.live) {
        // Save what's typed first: the server keeps the replaced copy in History.
        await ensureSaved();
        data = structuredClone($state.snapshot(detail.live)) as ArticleData;
        if (!(await save(true))) throw new Error(saveError ? `Couldn't save: ${saveError}` : "Couldn't save the published version. Try again.");
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
      clearBackup();
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
        <StateBadge state={articleState} live={detail.article.isLive} pending={detail.article.hasPendingChanges} />
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
      <button class="btn-ghost !px-2.5" data-tour="history" onclick={() => { historyLive = false; panel = panel === "history" ? "none" : "history"; }}>History</button>
      <button class="btn-ghost hidden !px-2.5 lg:inline-flex" onclick={() => (showPreview = !showPreview)}>{showPreview ? "Hide preview" : "Preview"}</button>
      {#if canEdit}
        <button class="btn-secondary" disabled={saving || (!dirty && !conflict)} onclick={() => save(true)}>Save</button>
      {/if}

      {#if isChiefUser}
        {#if articleState === "in_review" || articleState === "approved"}
          <button class="btn-secondary" onclick={() => (review = "request_changes")}>Request changes</button>
        {/if}
        {#if articleState === "in_review"}
          <button class="btn-secondary" onclick={() => (review = "approve")}>Approve</button>
        {/if}
        {#if articleState !== "published" || !detail.article.isLive}
          <button class="btn-success" onclick={startPublish}>{detail.live ? "Publish changes" : future ? "Schedule" : "Publish"}</button>
        {/if}
      {:else if detail.permissions.submit && (articleState === "draft" || articleState === "changes_requested")}
        <button class="btn-primary" data-tour="submit" onclick={() => (review = "submit")}>Submit for review</button>
      {:else if articleState === "in_review"}
        <span class="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">Waiting for the chief editor</span>
      {:else if articleState === "approved"}
        <span class="rounded-lg bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">Approved — awaiting publish</span>
      {/if}

      <button class="btn-ghost !px-2" title="Light / dark mode" aria-label="Toggle light or dark mode" onclick={toggleTheme}>
        <svg class="h-4 w-4 dark:hidden" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" /></svg>
        <svg class="hidden h-4 w-4 dark:block" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" /></svg>
      </button>
      <div class="relative">
        <button class="btn-ghost !px-2" aria-label="More actions" onclick={() => (menuOpen = !menuOpen)}>⋯</button>
        {#if menuOpen}
          <button class="fixed inset-0 z-10 cursor-default" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>
          <div class="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl bg-white py-1 text-sm shadow-xl ring-1 ring-slate-900/10 dark:bg-slate-800 dark:ring-white/10" transition:slide={{ duration: 120 }}>
            <button class="block w-full px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700" onclick={startTour}>Editor tour</button>
            <a class="block px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700" href={`/live/preview/?id=${detail.article.id}`} target="_blank" onclick={() => (menuOpen = false)}>Open preview in new tab ↗</a>
            {#if detail.article.isLive}
              <a class="block px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700" href={`/article/${detail.live?.slug ?? data.slug}/`} target="_blank" onclick={() => (menuOpen = false)}>View live article ↗</a>
            {/if}
            {#if liveEdited}
              <button class="block w-full px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700" onclick={() => { menuOpen = false; confirm = "discard"; }}>Discard unpublished changes</button>
            {/if}
            {#if detail.live && detail.article.state !== "published"}
              <button class="block w-full px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700" onclick={() => { menuOpen = false; compareWithLive(); }}>Compare with live version</button>
            {/if}
            {#if detail.permissions.unpublish}
              <button class="block w-full px-4 py-2 text-left text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10" onclick={() => { menuOpen = false; confirm = "unpublish"; }}>Unpublish</button>
            {/if}
            {#if detail.permissions.delete}
              <button class="block w-full px-4 py-2 text-left text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10" onclick={() => { menuOpen = false; confirm = "delete"; }}>Delete article…</button>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    {#if conflict}
      <div class="flex flex-wrap items-center gap-3 border-t border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200" transition:slide>
        <span class="flex-1"><strong>{conflict.updatedBy ?? "Someone"}</strong> saved a newer version {relTime(conflict.updatedAt)}. Your latest edits aren't saved.</span>
        <button class="btn-secondary !py-1" onclick={load}>Load their version</button>
        <button class="btn-danger !py-1" onclick={overwrite} title="Their version stays in History">Keep mine</button>
      </div>
    {:else if stale}
      <div class="flex flex-wrap items-center gap-3 border-t border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100" role="status" transition:slide>
        <span class="flex-1"><strong>{stale.by ?? "Someone"}</strong> saved a newer version {relTime(stale.at)}. You're looking at an older copy.</span>
        <button class="btn-secondary !py-1" onclick={load}>Reload</button>
      </div>
    {:else if saveError && canEdit}
      <div class="flex flex-wrap items-center gap-3 border-t border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200" role="alert" transition:slide>
        <span class="flex-1"><strong>Your latest changes aren't saved.</strong> {saveError}</span>
        <button class="btn-secondary !py-1" disabled={saving} onclick={() => save(true)}>Try again</button>
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
        {#if changeRequest}
          <button class="mb-5 w-full rounded-xl bg-rose-50 p-4 text-left ring-1 ring-rose-200 transition hover:bg-rose-100 dark:bg-rose-500/10 dark:ring-rose-500/30" onclick={() => (panel = "notes")}>
            <p class="text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
              Changes requested{changeRequest.byName ? ` by ${changeRequest.byName}` : ""} · {relTime(changeRequest.at)}
            </p>
            <p class="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-rose-900 dark:text-rose-100">{changeRequest.note}</p>
            {#if detail.permissions.submit}
              <p class="mt-2 text-xs text-rose-700 dark:text-rose-300">Make the changes, then use <b>Submit for review</b> again.</p>
            {/if}
          </button>
        {/if}

        {#if articleState === "in_review" && detail.review?.kind === "submit" && detail.review.editedSince}
          <div class="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-100 dark:ring-amber-500/25">
            <span class="font-semibold">Edited since it was submitted</span>
            {#if detail.article.updatedBy}— last by {detail.article.updatedBy === session.user?.id ? "you" : (detail.names[detail.article.updatedBy] ?? "someone")}, {relTime(detail.article.updatedAt)}{/if}.
            <button type="button" class="ml-1 font-semibold underline" onclick={() => { historyLive = false; panel = "history"; }}>See History</button>
          </div>
        {/if}

        {#if recovered && canEdit}
          <div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-100 dark:ring-sky-500/25" transition:slide={{ duration: 150 }}>
            <span><span class="font-semibold">Unsaved changes from {relTime(recovered.at)} were found in this browser.</span> Restoring them replaces the current draft.</span>
            <span class="ml-auto flex gap-2">
              <button type="button" class="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-sky-700" onclick={restoreBackup}>Restore them</button>
              <button type="button" class="rounded-md px-2.5 py-1 text-xs font-semibold ring-1 ring-sky-300 transition hover:bg-sky-100 dark:ring-sky-500/40 dark:hover:bg-sky-500/20" onclick={dropBackup}>Discard</button>
            </span>
          </div>
        {/if}

        {#if liveEdited}
          <div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-100 dark:ring-amber-500/25" transition:slide={{ duration: 150 }}>
            <span>
              <span class="font-semibold">{pendingBy ? `Unpublished changes by ${pendingBy}, ${relTime(detail.article.updatedAt)}.` : "You have unpublished changes."}</span>
              Readers still see the published version.
            </span>
            <span class="ml-auto flex gap-2">
              <button type="button" class="rounded-md px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300 transition hover:bg-amber-100 dark:text-amber-100 dark:ring-amber-500/40 dark:hover:bg-amber-500/20" onclick={compareWithLive}>Compare with live</button>
              <button type="button" class="rounded-md px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300 transition hover:bg-amber-100 dark:text-amber-100 dark:ring-amber-500/40 dark:hover:bg-amber-500/20" onclick={() => (confirm = "discard")}>Discard unpublished changes</button>
            </span>
          </div>
        {/if}

        <div class="mb-5 flex gap-1 border-b border-slate-200 dark:border-slate-800">
          {#each [["write", "Write"], ["details", "Details"], ["media", `Media${detail.media.length ? ` (${detail.media.length})` : ""}`]] as [key, label]}
            <button
              class="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition {tab === key ? 'border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}"
              data-tour={key === "details" ? "details" : undefined}
              onclick={() => (tab = key as typeof tab)}>{label}</button
            >
          {/each}
        </div>

        {#if tab === "write"}
          <div class="mb-4">
            <label for="article-title" class="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Title</label>
            <textarea
              id="article-title"
              data-tour="title"
              class="w-full resize-none rounded-xl border border-slate-300 bg-white px-4 py-3 text-2xl font-bold leading-tight tracking-tight text-slate-900 shadow-sm transition [field-sizing:content] placeholder:font-semibold placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-70 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:placeholder:text-slate-500"
              rows="1"
              placeholder="Review Title | Game Name Review"
              disabled={!canEdit}
              bind:value={data.title}
            ></textarea>
            <p class="mt-1.5 text-xs text-slate-500 dark:text-slate-400">Review Title | Game Name Review (e.g. <i>Best Game Ever | Half-Life Review</i>). The part before <b>|</b> is the first line of the title on the site.</p>
          </div>
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            {#if canEdit}
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:from-indigo-600 hover:to-purple-700"
                onclick={() => (aiOpen = true)}
                data-tour="ai"
                title="Turn your notes into a first draft with ChatGPT, Gemini or another AI"
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                Write with AI
              </button>
              <button
                type="button"
                class="mr-auto rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-100 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800"
                onclick={tidyBody}
                data-tour="tidy"
                title="Pros/Cons like the rest of the site (## Pros, ## Cons, - bullets), and remove styling pasted from Google Docs, Word or web pages"
              >Tidy formatting</button>
            {:else}
              <span></span>
            {/if}
            <div class="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-semibold dark:bg-slate-800">
              {#each [["visual", "Visual"], ["markdown", "Markdown"]] as [key, label]}
                <button
                  type="button"
                  class="rounded-md px-3 py-1 transition {editorMode === key ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}"
                  onclick={() => setMode(key as "visual" | "markdown")}>{label}</button
                >
              {/each}
            </div>
          </div>
          {#if editorMode === "visual"}
            {#await loadRich()}
              <div class="grid h-64 place-items-center rounded-xl bg-white text-sm text-slate-400 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
                {#if richSlow}
                  <div class="text-center">
                    <p>The editor is taking a while. The studio may have just been updated.</p>
                    <button type="button" class="btn-secondary mt-3" onclick={() => location.reload()}>Reload</button>
                  </div>
                {:else}
                  Loading editor…
                {/if}
              </div>
            {:then { default: RichEditor }}
              <RichEditor bind:this={rich} bind:value={data.body} articleId={detail.article.id} articleMedia={detail.media} disabled={!canEdit} onmediaadded={addMedia} onmarkdown={() => setMode("markdown")} />
            {:catch}
              <div class="rounded-xl bg-rose-50 p-4 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">The visual editor failed to load. Switch to Markdown, or reload the page.</div>
            {/await}
          {:else}
            <MarkdownField bind:value={data.body} articleId={detail.article.id} articleMedia={detail.media} disabled={!canEdit} onmediaadded={addMedia} />
          {/if}
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
      <div data-tour="preview" class="sticky top-[57px] hidden h-[calc(100vh-57px)] flex-1 border-l border-slate-200/70 dark:border-slate-800 lg:block" transition:fade={{ duration: 150 }}>
        <PreviewPane {data} />
      </div>
    {/if}
  </div>

  {#if panel === "history"}
    {#key historyKey}
    <HistoryPanel
      articleId={detail.article.id}
      current={data}
      live={detail.live}
      liveAt={detail.article.publishedAt}
      startWithLive={historyLive}
      canRestore={canEdit}
      onrestore={restore}
      onclose={() => {
        panel = "none";
        historyLive = false;
      }}
    />
    {/key}
  {:else if panel === "notes"}
    <NotesPanel articleId={detail.article.id} notes={detail.notes} canResolveAll={detail.permissions.resolveNotes} onupdate={applyMeta} onclose={() => (panel = "none")} />
  {/if}

  <PublishDialog bind:open={publishOpen} {detail} {data} onpublished={onPublished} onreload={load} oncompare={compareWithLive} />
  <EditorTour bind:open={tourOpen} />
  {#if tourOffer && !tourOpen}
    <div class="fixed bottom-5 right-5 z-40 w-[min(340px,calc(100vw-2rem))] rounded-2xl bg-white p-4 shadow-2xl ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10" role="dialog" aria-labelledby="tour-offer-h" transition:fade={{ duration: 150 }}>
      <h4 id="tour-offer-h" class="font-semibold">New to the editor?</h4>
      <p class="mb-3 mt-1 text-[13px] text-slate-500 dark:text-slate-400">Take a 1-minute tour of where everything is. You can replay it later from the ⋯ menu.</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn-ghost" onclick={markTourSeen}>No thanks</button>
        <button type="button" class="btn-primary" onclick={startTour}>Show me around</button>
      </div>
    </div>
  {/if}
  <AiWriteGuide bind:open={aiOpen} hasBody={Boolean(data.body.trim())} hasTitle={Boolean(data.title.trim())} onuse={useAiDraft} />

  <Modal open={leaveChoice !== null} title="Keep this draft?" size="sm" onclose={() => leaveChoice?.("stay")}>
    <p class="text-sm text-slate-600 dark:text-slate-300">
      You started a new article. Keep it as a draft to finish later, or delete it? It isn't published either way.
    </p>
    {#snippet footer()}
      <button class="btn-secondary" onclick={() => leaveChoice?.("stay")}>Keep editing</button>
      <button class="btn-danger" onclick={() => leaveChoice?.("delete")}>Delete</button>
      <button class="btn-primary" onclick={() => leaveChoice?.("keep")}>Keep draft</button>
    {/snippet}
  </Modal>

  <Modal
    open={review !== null}
    title={review === "submit" ? "Submit for review" : review === "approve" ? "Approve article" : "Request changes"}
    onclose={() => (review = null)}
  >
    <div class="space-y-3 text-sm">
      <p class="text-slate-600 dark:text-slate-300">
        {#if review === "submit"}The chief editor will be able to review, request changes or publish it.{:else if review === "approve"}Marks the article as ready. You can publish it any time.{:else}The writer sees your note at the top of the article.{/if}
      </p>
      {#if review === "submit" && data && !data.thumb && !data.gallery?.length && !data.body.includes("<img") && !data.body.includes("![")}
        <p class="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:bg-sky-500/10 dark:text-sky-200">No images yet? That's fine. The chief editor can add the thumbnail and screenshots before publishing.</p>
      {/if}
      <textarea class="input min-h-[110px]" placeholder={review === "request_changes" ? "What needs to change? (required)" : "Add a note (optional)"} bind:value={reviewNote}></textarea>
    </div>
    {#snippet footer()}
      <button class="btn-secondary" onclick={() => (review = null)}>Cancel</button>
      <button class={review === "request_changes" ? "btn-danger" : "btn-primary"} disabled={busy || (review === "request_changes" && !reviewNote.trim())} onclick={runReview}>
        {review === "submit" ? "Submit" : review === "approve" ? "Approve" : "Request changes"}
      </button>
    {/snippet}
  </Modal>

  <Modal open={confirm !== null} title={confirm === "unpublish" ? "Unpublish article?" : confirm === "delete" ? "Delete article?" : "Discard unpublished changes?"} size="sm" onclose={() => (confirm = null)}>
    <p class="text-sm text-slate-600 dark:text-slate-300">
      {#if confirm === "unpublish"}
        It's removed from the site after the next build. The article and its history stay in the studio.
      {:else if confirm === "delete"}
        This permanently deletes the article, its history and its notes. It can't be undone. Uploaded images aren't deleted: they stay in the Media library.
      {:else}
        The working copy goes back to the version that's live on the site{pendingBy ? `, replacing ${pendingBy}'s changes` : ""}. The current changes are saved in History first, so they can be restored.
      {/if}
    </p>
    {#snippet footer()}
      <button class="btn-secondary" onclick={() => (confirm = null)}>Cancel</button>
      <button class="btn-danger" disabled={busy} onclick={runConfirm}>{confirm === "unpublish" ? "Unpublish" : confirm === "delete" ? "Delete" : "Discard"}</button>
    {/snippet}
  </Modal>
{/if}
