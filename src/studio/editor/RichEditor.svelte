<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { Editor } from "@tiptap/core";
  import type { Node as PMNode } from "@tiptap/pm/model";
  import { EditorState, NodeSelection, type Transaction } from "@tiptap/pm/state";
  import StarterKit from "@tiptap/starter-kit";
  import { Placeholder } from "@tiptap/extensions";
  import { Markdown } from "tiptap-markdown";
  import type { Media } from "../api";
  import { uploadFiles } from "../images.svelte";
  import { toast } from "../state.svelte";
  import MediaPicker from "../ui/MediaPicker.svelte";
  import { Br, Caption, ImageText, PlainText, RawHtml, SideDrop, SizedImage, WRAP_DEFAULT_WIDTH, imageMarkdown, setSideZone, sideZoneAt, wrapBeside, type SideZone } from "./rich-extensions";
  import { roundTripProblems } from "./roundtrip";

  let {
    value = $bindable(""),
    articleId,
    articleMedia = [],
    disabled = false,
    onmediaadded,
    onmarkdown,
  }: {
    value?: string;
    articleId: string;
    articleMedia?: Media[];
    disabled?: boolean;
    onmediaadded?: (m: Media[]) => void;
    /** Switch the article to the markdown editor. */
    onmarkdown?: () => void;
  } = $props();

  let host: HTMLDivElement;
  let editor = $state<Editor | null>(null);
  let tick = $state(0); // bumps on every transaction so toolbar state re-renders
  let lastEmitted = "";
  let emitTimer: ReturnType<typeof setTimeout>;
  let pendingEmit = false;
  let destroyed = false;
  let picker = $state<null | "images" | "side" | "swap">(null);
  let pickerOpen = $state(false);
  // The document as loaded, and the markdown it came from. While the document is
  // still equal to it, the body is handed back byte-for-byte: opening, clicking or
  // undoing back to the start never rewrites the article.
  let baseDoc: PMNode | null = null;
  let baseValue = "";
  // Markdown this editor can't keep (see roundtrip.ts): editing stays off until the
  // writer switches to Markdown or explicitly chooses to edit here anyway.
  let problems = $state<string[]>([]);
  let editAnyway = $state(false);
  let locked = $derived(problems.length > 0 && !editAnyway);
  let off = $derived(disabled || locked);
  // Positions waiting on an upload, kept in step with every edit made meanwhile.
  type Tracked = { pos: number; gone: boolean; blockStart: boolean };
  const tracked = new Set<Tracked>();

  const markdownOf = (e: Editor) => (e.storage as any).markdown.getMarkdown() as string;

  onMount(() => {
    editor = new Editor({
      element: host,
      editable: false, // turned on by the effect below once the content has been checked
      extensions: [
        // No trailing-node plugin: it appends a paragraph on the first click, which counts as an edit.
        StarterKit.configure({ hardBreak: false, text: false, trailingNode: false, link: { openOnClick: false, autolink: true } }),
        PlainText,
        Br,
        SizedImage,
        ImageText,
        Caption,
        RawHtml,
        SideDrop,
        Placeholder.configure({ placeholder: "Start writing your review…" }),
        Markdown.configure({ html: true, tightLists: true, linkify: false, breaks: false, transformPastedText: true }),
      ],
      content: value,
      editorProps: {
        attributes: { class: "pt-rich prose prose-lg dark:prose-invert max-w-none focus:outline-none" },
        handleDrop: (view, event) => {
          const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (!files.length) return false;
          event.preventDefault();
          const zone = sideZoneAt(view, event.clientX, event.clientY);
          setSideZone(view, null);
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          uploadAndInsert(files, pos, zone);
          return true;
        },
        handlePaste: (view, event) => {
          const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (!files.length) return false;
          event.preventDefault();
          uploadAndInsert(files, view.state.selection.to);
          return true;
        },
      },
      onTransaction: ({ transaction, appendedTransactions }) => {
        mapTracked([transaction, ...(appendedTransactions ?? [])]);
        // untrack: a blur transaction can fire while Svelte is removing the editor's DOM.
        untrack(() => tick++);
      },
      onUpdate: () => {
        pendingEmit = true;
        clearTimeout(emitTimer);
        emitTimer = setTimeout(flush, 250);
      },
    });
    loaded(value);
  });

  /** Hand the latest edits to `value` now instead of after the 250ms debounce. */
  export function flush() {
    clearTimeout(emitTimer);
    if (!editor || editor.isDestroyed || !pendingEmit) return;
    pendingEmit = false;
    const md = baseDoc && editor.state.doc.eq(baseDoc) ? baseValue : markdownOf(editor);
    if (md !== lastEmitted) {
      lastEmitted = md;
      value = md;
    }
  }

  /** Remember what was just loaded and check whether this editor can keep it. */
  function loaded(v: string) {
    if (!editor) return;
    baseDoc = editor.state.doc;
    baseValue = v;
    lastEmitted = v;
    try {
      problems = roundTripProblems(v, markdownOf(editor), (editor.storage as any).markdown.parser.md);
    } catch {
      problems = ["formatting the visual editor can't read"];
    }
    editAnyway = false;
  }

  onDestroy(() => {
    destroyed = true;
    if (editor) {
      // Flush the last keystrokes before leaving.
      flush();
      editor.destroy();
    }
  });

  // Content changed from outside (restore, discard, someone else's version): load it.
  $effect(() => {
    const v = value;
    if (editor && v !== lastEmitted) untrack(() => reload(v));
  });

  function reload(v: string) {
    if (!editor) return;
    clearTimeout(emitTimer);
    pendingEmit = false;
    for (const t of tracked) t.gone = true;
    editor.commands.setContent(v, { emitUpdate: false });
    // Not an edit: start a fresh undo history, so Ctrl+Z can't bring the replaced text back.
    const s = editor.state;
    editor.view.updateState(EditorState.create({ doc: s.doc, plugins: s.plugins }));
    tick++;
    loaded(v);
  }

  $effect(() => {
    editor?.setEditable(!off, false); // false: changing editability is not an edit
  });

  function mapTracked(trs: readonly Transaction[]) {
    if (!tracked.size) return;
    for (const tr of trs) {
      if (!tr.docChanged) continue;
      for (const t of tracked) {
        if (t.gone) continue;
        const r = tr.mapping.mapResult(t.pos);
        t.pos = r.pos;
        if (t.blockStart ? r.deletedAfter : r.deleted) t.gone = true;
      }
    }
  }

  function track(pos: number, blockStart = false): Tracked {
    const t = { pos, gone: false, blockStart };
    tracked.add(t);
    return t;
  }

  // ---- Selection helpers ---------------------------------------------------
  function selectedImage() {
    void tick;
    const sel = editor?.state.selection;
    return sel instanceof NodeSelection && sel.node.type.name === "image" ? sel : null;
  }

  function sideBlock(): { pos: number; node: any } | null {
    void tick;
    if (!editor) return null;
    const rf = editor.state.selection.$from;
    for (let d = rf.depth; d > 0; d--) {
      const n = rf.node(d);
      if (n.type.name === "imageText") return { pos: rf.before(d), node: n };
    }
    const sel = editor.state.selection;
    if (sel instanceof NodeSelection && sel.node.type.name === "imageText") return { pos: sel.from, node: sel.node };
    return null;
  }

  const is = (name: string, attrs?: Record<string, unknown>) => {
    void tick;
    return editor?.isActive(name, attrs) ?? false;
  };

  // ---- Commands ------------------------------------------------------------
  function setImageHeight(height: number | null) {
    const sel = selectedImage();
    if (!sel || !editor || off) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, height }));
  }

  /** Text flows around the image (side = where the image sits), or back to a normal image. */
  function setWrap(wrap: "left" | "right" | null) {
    const sel = selectedImage();
    if (!sel || !editor || off) return;
    const width = wrap ? sel.node.attrs.width || WRAP_DEFAULT_WIDTH : null;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, wrap, width, height: null }));
  }

  function setWrapWidth(width: number) {
    const sel = selectedImage();
    if (!sel || !editor || off) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, width }));
  }

  /** Wrap the selected image + the block after it into a two-column block. */
  function putBesideText(side: "left" | "right" = "right") {
    const sel = selectedImage();
    if (!sel || !editor || off) return;
    const { state } = editor;
    const schema = state.schema;
    const imgEnd = sel.from + sel.node.nodeSize;
    const next = state.doc.nodeAt(imgEnd);
    const allowed = ["paragraph", "heading", "bulletList", "orderedList", "blockquote"];
    const content = next && allowed.includes(next.type.name) ? [next] : [schema.nodes.paragraph.create()];
    const block = schema.nodes.imageText.create({ src: sel.node.attrs.src, alt: sel.node.attrs.alt, side }, content);
    const to = next && allowed.includes(next.type.name) ? imgEnd + next.nodeSize : imgEnd;
    editor.view.dispatch(state.tr.replaceWith(sel.from, to, block));
    editor.commands.focus();
  }

  function flipSide() {
    const b = sideBlock();
    if (!b || !editor || off) return;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, side: b.node.attrs.side === "left" ? "right" : "left" }),
    );
  }

  /** Back to a normal image followed by the text. */
  function unwrapSide() {
    const b = sideBlock();
    if (!b || !editor || off) return;
    const schema = editor.state.schema;
    const nodes = [schema.nodes.image.create({ src: b.node.attrs.src, alt: b.node.attrs.alt })];
    b.node.forEach((child: any) => nodes.push(child));
    editor.view.dispatch(editor.state.tr.replaceWith(b.pos, b.pos + b.node.nodeSize, nodes));
  }

  /** Columns block -> image the text wraps around. */
  function sideToWrap() {
    const b = sideBlock();
    if (!b || !editor || off) return;
    const schema = editor.state.schema;
    const nodes = [schema.nodes.image.create({ src: b.node.attrs.src, alt: b.node.attrs.alt, wrap: b.node.attrs.side, width: WRAP_DEFAULT_WIDTH })];
    b.node.forEach((child: any) => nodes.push(child));
    editor.view.dispatch(editor.state.tr.replaceWith(b.pos, b.pos + b.node.nodeSize, nodes));
  }

  function removeSelectedImage() {
    if (off) return;
    editor?.chain().focus().deleteSelection().run();
  }

  function setLink() {
    if (!editor || off) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = prompt("Link address (leave empty to remove)", prev || "https://");
    if (url === null) return;
    if (!url.trim() || url === "https://") editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  }

  function insertImages(media: Media[], at?: number) {
    if (!editor || !media.length) return;
    const nodes = media.map((m) => ({ type: "image", attrs: { src: m.url, alt: m.alt || "" } }));
    const sel = editor.state.selection;
    // A selected image or block stays: the new ones go after it instead of replacing it.
    if (typeof at !== "number" && sel instanceof NodeSelection) at = sel.to;
    if (typeof at === "number") editor.chain().focus().insertContentAt(Math.max(0, Math.min(at, editor.state.doc.content.size)), nodes).run();
    else editor.chain().focus().insertContent(nodes).run();
  }

  /** Image with text wrapping around it, placed at the start of the block the cursor is in. */
  function insertSide(m: Media) {
    if (!editor) return;
    const sel = editor.state.selection;
    const rf = sel.$from;
    const node = { type: "image", attrs: { src: m.url, alt: m.alt || "", wrap: "right", width: WRAP_DEFAULT_WIDTH } };
    if (rf.depth >= 1 && rf.node(1).type.name !== "imageText") editor.chain().focus().insertContentAt(rf.before(1), node).run();
    else if (sel instanceof NodeSelection) editor.chain().focus().insertContentAt(sel.to, node).run();
    else editor.chain().focus().insertContent(node).run();
  }

  function swapSideImage(m: Media) {
    const b = sideBlock();
    if (!b || !editor) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, src: m.url, alt: m.alt || b.node.attrs.alt }));
  }

  async function uploadAndInsert(files: File[], at?: number, zone?: SideZone | null) {
    // Uploads take a while; keep the drop/paste spot in step with edits made meanwhile.
    const atT = typeof at === "number" ? track(at) : null;
    const zoneT = zone ? track(zone.pos, true) : null;
    let media: Media[] = [];
    try {
      media = await uploadFiles(files, articleId);
    } finally {
      if (atT) tracked.delete(atT);
      if (zoneT) tracked.delete(zoneT);
    }
    if (!media.length) return;
    onmediaadded?.(media);
    const n = `${media.length} image${media.length === 1 ? "" : "s"}`;
    if (destroyed || !editor || editor.isDestroyed) {
      // The visual editor closed while uploading (mode or tab switch): add them to the end of the text.
      value = `${value.replace(/\s+$/, "")}\n\n${media.map((m) => imageMarkdown(m.url, m.alt)).join("\n\n")}\n`;
      toast(`Added ${n} to the end of the article`, "success");
      return;
    }
    const z = zone && zoneT && !zoneT.gone ? { pos: zoneT.pos, side: zone.side } : null;
    // Dropped on a paragraph's edge: the first image goes beside it, any others after the paragraph.
    if (z && wrapBeside(editor.view, z, { src: media[0].url, alt: media[0].alt || "" })) {
      if (media.length > 1) {
        const doc = editor.state.doc;
        const blockPos = z.pos + doc.nodeAt(z.pos)!.nodeSize; // the paragraph, now just after the image
        const block = doc.nodeAt(blockPos);
        insertImages(media.slice(1), block ? blockPos + block.nodeSize : undefined);
      }
    } else insertImages(media, atT && !atT.gone ? atT.pos : undefined);
    toast(`Inserted ${n}`, "success");
  }

  let words = $derived.by(() => {
    void tick;
    const t = editor?.state.doc.textContent ?? "";
    return t.split(/\s+/).filter(Boolean).length;
  });

  const btn =
    "min-w-8 rounded-md px-2 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white";
  const on = "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300";
  const accent =
    "rounded-md px-2 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-40 dark:text-indigo-400 dark:hover:bg-indigo-500/10";
</script>

{#if locked && !disabled}
  <div class="mb-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-100 dark:ring-amber-500/25" role="status">
    <p>
      <span class="font-semibold">This article uses formatting the visual editor can't keep</span> — {problems.join("; ")}. Edit it in Markdown so nothing is lost.
    </p>
    <div class="mt-2 flex flex-wrap gap-2">
      {#if onmarkdown}
        <button type="button" class="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-amber-700" onclick={() => onmarkdown?.()}>Switch to Markdown</button>
      {/if}
      <button type="button" class="rounded-md px-2.5 py-1 text-xs font-semibold ring-1 ring-amber-300 transition hover:bg-amber-100 dark:ring-amber-500/40 dark:hover:bg-amber-500/20" onclick={() => (editAnyway = true)}>Edit here anyway (that formatting may change)</button>
    </div>
  </div>
{/if}

<div class="rounded-xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
  <div class="sticky top-[57px] z-10 rounded-t-xl border-b border-slate-100 bg-white/95 px-2 py-1.5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
    <div class="flex flex-wrap items-center gap-0.5">
      <button type="button" class="{btn} {is('paragraph') ? on : ''}" title="Normal text" disabled={off} onclick={() => editor?.chain().focus().setParagraph().run()}>¶</button>
      <button type="button" class="{btn} {is('heading', { level: 2 }) ? on : ''}" title="Heading" disabled={off} onclick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
      <button type="button" class="{btn} {is('heading', { level: 3 }) ? on : ''}" title="Subheading" disabled={off} onclick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>H3</button>
      <span class="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700"></span>
      <button type="button" class="{btn} font-black {is('bold') ? on : ''}" title="Bold (Ctrl+B)" disabled={off} onclick={() => editor?.chain().focus().toggleBold().run()}>B</button>
      <button type="button" class="{btn} italic font-serif {is('italic') ? on : ''}" title="Italic (Ctrl+I)" disabled={off} onclick={() => editor?.chain().focus().toggleItalic().run()}>I</button>
      <button type="button" class="{btn} line-through {is('strike') ? on : ''}" title="Strikethrough" disabled={off} onclick={() => editor?.chain().focus().toggleStrike().run()}>S</button>
      <button type="button" class="{btn} {is('link') ? on : ''}" title="Link" disabled={off} onclick={setLink}>Link</button>
      <span class="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700"></span>
      <button type="button" class="{btn} {is('bulletList') ? on : ''}" title="Bulleted list" disabled={off} onclick={() => editor?.chain().focus().toggleBulletList().run()}>• List</button>
      <button type="button" class="{btn} {is('orderedList') ? on : ''}" title="Numbered list" disabled={off} onclick={() => editor?.chain().focus().toggleOrderedList().run()}>1. List</button>
      <button type="button" class="{btn} {is('blockquote') ? on : ''}" title="Quote" disabled={off} onclick={() => editor?.chain().focus().toggleBlockquote().run()}>“ ”</button>
      <button type="button" class={btn} title="Divider" disabled={off} onclick={() => editor?.chain().focus().setHorizontalRule().run()}>—</button>
      <span class="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700"></span>
      <button type="button" class={accent} disabled={off} onclick={() => { picker = "images"; pickerOpen = true; }}>+ Images</button>
      <button type="button" class={accent} disabled={off} title="Image with the text wrapping around it" onclick={() => { picker = "side"; pickerOpen = true; }}>+ Image beside text</button>
      <span class="ml-auto pr-1 text-[11px] tabular-nums text-slate-400">{words.toLocaleString()} words · {Math.max(1, Math.round(words / 230))} min read</span>
    </div>

    {#if selectedImage() && !off}
      {@const a = selectedImage()!.node.attrs}
      <div class="mt-1.5 flex flex-wrap items-center gap-1 rounded-lg bg-indigo-50/80 px-2 py-1.5 text-xs dark:bg-indigo-500/10">
        <span class="mr-1 font-semibold text-indigo-800 dark:text-indigo-200">Text:</span>
        <button type="button" class="{btn} {!a.wrap ? on : ''}" title="Image on its own line" onclick={() => setWrap(null)}>Above &amp; below</button>
        <button type="button" class="{btn} {a.wrap === 'left' ? on : ''}" title="Image on the left, text wraps around it" onclick={() => setWrap("left")}>Wrap · image left</button>
        <button type="button" class="{btn} {a.wrap === 'right' ? on : ''}" title="Image on the right, text wraps around it" onclick={() => setWrap("right")}>Wrap · image right</button>
        <span class="mx-1 h-4 w-px bg-indigo-200 dark:bg-indigo-500/30"></span>
        <span class="mr-1 font-semibold text-indigo-800 dark:text-indigo-200">Size:</span>
        {#if a.wrap}
          {#each [["S", 30], ["M", 40], ["L", 50]] as [label, pct]}
            <button type="button" class="{btn} {(a.width || WRAP_DEFAULT_WIDTH) === pct ? on : ''}" onclick={() => setWrapWidth(pct as number)}>{label}</button>
          {/each}
        {:else}
          {#each [["S", 300], ["M", 450], ["L", 600]] as [label, px]}
            <button type="button" class="{btn} {a.height === px ? on : ''}" onclick={() => setImageHeight(px as number)}>{label}</button>
          {/each}
          <button type="button" class="{btn} {!a.height ? on : ''}" onclick={() => setImageHeight(null)}>Full</button>
        {/if}
        <span class="mx-1 h-4 w-px bg-indigo-200 dark:bg-indigo-500/30"></span>
        <button type="button" class={btn} title="Image and text in two separate columns" onclick={() => putBesideText(a.wrap === "left" ? "left" : "right")}>Columns</button>
        <button type="button" class="{btn} ml-auto text-rose-600" onclick={removeSelectedImage}>Remove</button>
        <span class="w-full text-[11px] text-indigo-700/70 dark:text-indigo-300/70">Tip: drag the corner handle to resize. Drag the image onto the left or right edge of a paragraph to wrap the text around it. On phones it sits above the text.</span>
      </div>
    {:else if sideBlock() && !off}
      <div class="mt-1.5 flex flex-wrap items-center gap-1 rounded-lg bg-indigo-50/80 px-2 py-1.5 text-xs dark:bg-indigo-500/10">
        <span class="mr-1 font-semibold text-indigo-800 dark:text-indigo-200">Columns:</span>
        <button type="button" class={accent} onclick={sideToWrap}>Wrap text around the image instead</button>
        <button type="button" class={accent} onclick={flipSide}>Move image to the {sideBlock()?.node.attrs.side === "left" ? "right" : "left"}</button>
        <button type="button" class={accent} onclick={() => { picker = "swap"; pickerOpen = true; }}>Change image</button>
        <button type="button" class="{btn} ml-auto" onclick={unwrapSide}>Undo side-by-side</button>
      </div>
    {/if}
  </div>

  <div class="px-5 py-4" bind:this={host}></div>
</div>

<MediaPicker
  bind:open={pickerOpen}
  {articleId}
  {articleMedia}
  multiple={picker === "images"}
  title={picker === "side" ? "Image beside text" : picker === "swap" ? "Change image" : "Insert images"}
  onpick={(m) => {
    onmediaadded?.(m);
    if (off) return;
    if (picker === "images") insertImages(m);
    else if (picker === "side" && m[0]) insertSide(m[0]);
    else if (picker === "swap" && m[0]) swapSideImage(m[0]);
  }}
/>

<style>
  :global(.pt-rich) {
    min-height: 480px;
  }
  :global(.pt-rich p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
    color: rgb(148 163 184);
  }
  :global(.pt-img) {
    position: relative;
    display: block;
    width: fit-content;
    max-width: 100%;
    margin: 1.25rem auto;
    border-radius: 0.5rem;
    outline: 2px solid transparent;
    transition: outline-color 0.15s;
  }
  :global(.pt-img img) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 !important;
    border-radius: 0.5rem;
  }
  :global(.pt-img.pt-selected),
  :global(.pt-img.pt-resizing) {
    outline-color: rgb(99 102 241);
  }
  :global(.pt-img-handle) {
    position: absolute;
    right: -7px;
    bottom: -7px;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    background: rgb(99 102 241);
    border: 2px solid white;
    cursor: nwse-resize;
    touch-action: none;
    opacity: 0;
    transition: opacity 0.15s;
  }
  :global(.ProseMirror[contenteditable="false"] .pt-img-handle) {
    display: none;
  }
  :global(.pt-img-badge) {
    position: absolute;
    left: 8px;
    top: 8px;
    padding: 1px 6px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    color: white;
    background: rgb(15 23 42 / 0.7);
    opacity: 0;
    transition: opacity 0.15s;
  }
  :global(.pt-img:hover .pt-img-handle),
  :global(.pt-img.pt-selected .pt-img-handle),
  :global(.pt-img.pt-selected .pt-img-badge),
  :global(.pt-img.pt-resizing .pt-img-badge) {
    opacity: 1;
  }
  :global(.pt-img.pt-wrap-left),
  :global(.pt-img.pt-wrap-right) {
    margin-top: 0.35rem;
    margin-bottom: 0.75rem;
  }
  :global(.pt-img.pt-wrap-left) {
    float: left;
    margin-right: 1.75rem;
    margin-left: 0;
  }
  :global(.pt-img.pt-wrap-right) {
    float: right;
    margin-left: 1.75rem;
    margin-right: 0;
  }
  :global(.pt-img.pt-will-stack) {
    outline-style: dashed;
    opacity: 0.85;
  }
  :global(.pt-img.pt-wrap-left img),
  :global(.pt-img.pt-wrap-right img) {
    width: 100%;
  }
  /* The resize handle sits on the edge facing the text. */
  :global(.pt-img.pt-wrap-right .pt-img-handle) {
    left: -7px;
    right: auto;
    cursor: nesw-resize;
  }
  :global(.pt-rich h1),
  :global(.pt-rich h2),
  :global(.pt-rich h3),
  :global(.pt-rich hr),
  :global(.pt-rich .pt-side) {
    clear: both;
  }
  :global(.pt-rich::after) {
    content: "";
    display: table;
    clear: both;
  }
  @media (max-width: 767px) {
    :global(.pt-img.pt-wrap-left),
    :global(.pt-img.pt-wrap-right) {
      float: none;
      width: 100% !important;
      margin: 1rem 0;
    }
  }
  :global(.pt-side) {
    display: flex;
    gap: 1.5rem;
    align-items: center;
    margin: 1.5rem 0;
    padding: 0.75rem;
    border-radius: 0.75rem;
    border: 1px dashed rgb(203 213 225);
  }
  :global(.pt-side-right) {
    flex-direction: row-reverse;
  }
  :global(.pt-side-img) {
    width: 40%;
    flex-shrink: 0;
    margin: 0 !important;
    border-radius: 0.5rem;
  }
  :global(.pt-side-text) {
    flex: 1;
    min-width: 0;
  }
  :global(.pt-raw) {
    position: relative;
    margin: 1.25rem 0;
    padding: 1.5rem 0.75rem 0.75rem;
    border-radius: 0.75rem;
    border: 1px dashed rgb(203 213 225);
  }
  :global(.pt-raw-label) {
    position: absolute;
    top: 4px;
    left: 8px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(148 163 184);
  }
  :global(.pt-raw-comment) {
    font-size: 0.85em;
    font-style: italic;
    color: rgb(100 116 139);
    white-space: pre-wrap;
  }
  :global(.dark .pt-side),
  :global(.dark .pt-raw) {
    border-color: rgb(51 65 85);
  }
  :global(.pt-drop) {
    position: relative;
    border-radius: 0.5rem;
    background: rgb(99 102 241 / 0.08);
  }
  :global(.pt-drop-left) {
    box-shadow: inset 4px 0 0 rgb(99 102 241);
  }
  :global(.pt-drop-right) {
    box-shadow: inset -4px 0 0 rgb(99 102 241);
  }
  :global(.pt-drop::after) {
    position: absolute;
    top: -0.6rem;
    padding: 0 0.5rem;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2rem;
    color: white;
    background: rgb(99 102 241);
    pointer-events: none;
  }
  :global(.pt-drop-left::after) {
    content: "⇤ Image on the left, text wraps around";
    left: 0.5rem;
  }
  :global(.pt-drop-right::after) {
    content: "Image on the right, text wraps around ⇥";
    right: 0.5rem;
  }
  :global(.ProseMirror-selectednode.pt-side),
  :global(.ProseMirror-selectednode.pt-raw) {
    outline: 2px solid rgb(99 102 241);
  }
</style>
