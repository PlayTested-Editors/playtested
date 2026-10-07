<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Editor } from "@tiptap/core";
  import { NodeSelection } from "@tiptap/pm/state";
  import StarterKit from "@tiptap/starter-kit";
  import { Placeholder } from "@tiptap/extensions";
  import { Markdown } from "tiptap-markdown";
  import type { Media } from "../api";
  import { uploadFiles } from "../images.svelte";
  import { toast } from "../state.svelte";
  import MediaPicker from "../ui/MediaPicker.svelte";
  import { Br, Caption, ImageText, RawHtml, SideDrop, SizedImage, setSideZone, sideZoneAt, wrapBeside, type SideZone } from "./rich-extensions";

  let {
    value = $bindable(""),
    articleId,
    articleMedia = [],
    disabled = false,
    onmediaadded,
  }: {
    value?: string;
    articleId: string;
    articleMedia?: Media[];
    disabled?: boolean;
    onmediaadded?: (m: Media[]) => void;
  } = $props();

  let host: HTMLDivElement;
  let editor = $state<Editor | null>(null);
  let tick = $state(0); // bumps on every transaction so toolbar state re-renders
  let lastEmitted = "";
  let emitTimer: ReturnType<typeof setTimeout>;
  let picker = $state<null | "images" | "side" | "swap">(null);
  let pickerOpen = $state(false);

  const markdownOf = (e: Editor) => (e.storage as any).markdown.getMarkdown() as string;

  onMount(() => {
    editor = new Editor({
      element: host,
      editable: !disabled,
      extensions: [
        StarterKit.configure({ hardBreak: false, codeBlock: false, code: false, link: { openOnClick: false, autolink: true } }),
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
        handlePaste: (_view, event) => {
          const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (!files.length) return false;
          event.preventDefault();
          uploadAndInsert(files);
          return true;
        },
      },
      onTransaction: () => tick++,
      onUpdate: ({ editor: e }) => {
        clearTimeout(emitTimer);
        emitTimer = setTimeout(() => {
          lastEmitted = markdownOf(e);
          value = lastEmitted;
        }, 250);
      },
    });
    lastEmitted = value;
  });

  onDestroy(() => {
    clearTimeout(emitTimer);
    if (editor) {
      // Flush the last keystrokes before leaving.
      const md = markdownOf(editor);
      if (md !== lastEmitted) value = md;
      editor.destroy();
    }
  });

  // Content changed from outside (restore, switching modes): load it.
  $effect(() => {
    const v = value;
    if (editor && v !== lastEmitted) {
      lastEmitted = v;
      editor.commands.setContent(v, { emitUpdate: false });
    }
  });

  $effect(() => {
    editor?.setEditable(!disabled);
  });

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
    if (!sel || !editor) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, height }));
  }

  /** Wrap the selected image + the block after it into an image-beside-text block. */
  function putBesideText(side: "left" | "right" = "right") {
    const sel = selectedImage();
    if (!sel || !editor) return;
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
    if (!b || !editor) return;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, side: b.node.attrs.side === "left" ? "right" : "left" }),
    );
  }

  /** Back to a normal image followed by the text. */
  function unwrapSide() {
    const b = sideBlock();
    if (!b || !editor) return;
    const schema = editor.state.schema;
    const nodes = [schema.nodes.image.create({ src: b.node.attrs.src, alt: b.node.attrs.alt })];
    b.node.forEach((child: any) => nodes.push(child));
    editor.view.dispatch(editor.state.tr.replaceWith(b.pos, b.pos + b.node.nodeSize, nodes));
  }

  function removeSelectedImage() {
    editor?.chain().focus().deleteSelection().run();
  }

  function setLink() {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = prompt("Link address (leave empty to remove)", prev || "https://");
    if (url === null) return;
    if (!url.trim() || url === "https://") editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  }

  function insertImages(media: Media[], at?: number) {
    if (!editor || !media.length) return;
    const nodes = media.map((m) => ({ type: "image", attrs: { src: m.url, alt: m.alt || "" } }));
    if (typeof at === "number") editor.chain().focus().insertContentAt(at, nodes).run();
    else editor.chain().focus().insertContent(nodes).run();
  }

  /** Image beside text: wraps the paragraph the cursor is in, or adds a new one. */
  function insertSide(m: Media) {
    if (!editor) return;
    const { state } = editor;
    const rf = state.selection.$from;
    const para = rf.depth >= 1 ? rf.node(1) : null;
    const schema = state.schema;
    const allowed = ["paragraph", "heading", "bulletList", "orderedList", "blockquote"];
    if (para && allowed.includes(para.type.name) && para.textContent.trim()) {
      const pos = rf.before(1);
      const block = schema.nodes.imageText.create({ src: m.url, alt: m.alt || "", side: "right" }, [para]);
      editor.view.dispatch(state.tr.replaceWith(pos, pos + para.nodeSize, block));
    } else {
      editor
        .chain()
        .focus()
        .insertContent({ type: "imageText", attrs: { src: m.url, alt: m.alt || "", side: "right" }, content: [{ type: "paragraph" }] })
        .run();
    }
  }

  function swapSideImage(m: Media) {
    const b = sideBlock();
    if (!b || !editor) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, src: m.url, alt: m.alt || b.node.attrs.alt }));
  }

  async function uploadAndInsert(files: File[], at?: number, zone?: SideZone | null) {
    const media = await uploadFiles(files, articleId);
    if (media.length) {
      onmediaadded?.(media);
      // Dropped on a paragraph's edge: the first image goes beside it.
      if (zone && editor && wrapBeside(editor.view, zone, { src: media[0].url, alt: media[0].alt || "" })) {
        if (media.length > 1) insertImages(media.slice(1), zone.pos + editor.state.doc.nodeAt(zone.pos)!.nodeSize);
      } else insertImages(media, at);
      toast(`Inserted ${media.length} image${media.length === 1 ? "" : "s"}`, "success");
    }
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
    "rounded-md px-2 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10";
</script>

<div class="rounded-xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
  <div class="sticky top-[57px] z-10 rounded-t-xl border-b border-slate-100 bg-white/95 px-2 py-1.5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
    <div class="flex flex-wrap items-center gap-0.5">
      <button type="button" class="{btn} {is('paragraph') ? on : ''}" title="Normal text" {disabled} onclick={() => editor?.chain().focus().setParagraph().run()}>¶</button>
      <button type="button" class="{btn} {is('heading', { level: 2 }) ? on : ''}" title="Heading" {disabled} onclick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
      <button type="button" class="{btn} {is('heading', { level: 3 }) ? on : ''}" title="Subheading" {disabled} onclick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>H3</button>
      <span class="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700"></span>
      <button type="button" class="{btn} font-black {is('bold') ? on : ''}" title="Bold (Ctrl+B)" {disabled} onclick={() => editor?.chain().focus().toggleBold().run()}>B</button>
      <button type="button" class="{btn} italic font-serif {is('italic') ? on : ''}" title="Italic (Ctrl+I)" {disabled} onclick={() => editor?.chain().focus().toggleItalic().run()}>I</button>
      <button type="button" class="{btn} line-through {is('strike') ? on : ''}" title="Strikethrough" {disabled} onclick={() => editor?.chain().focus().toggleStrike().run()}>S</button>
      <button type="button" class="{btn} {is('link') ? on : ''}" title="Link" {disabled} onclick={setLink}>Link</button>
      <span class="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700"></span>
      <button type="button" class="{btn} {is('bulletList') ? on : ''}" title="Bulleted list" {disabled} onclick={() => editor?.chain().focus().toggleBulletList().run()}>• List</button>
      <button type="button" class="{btn} {is('orderedList') ? on : ''}" title="Numbered list" {disabled} onclick={() => editor?.chain().focus().toggleOrderedList().run()}>1. List</button>
      <button type="button" class="{btn} {is('blockquote') ? on : ''}" title="Quote" {disabled} onclick={() => editor?.chain().focus().toggleBlockquote().run()}>“ ”</button>
      <button type="button" class={btn} title="Divider" {disabled} onclick={() => editor?.chain().focus().setHorizontalRule().run()}>—</button>
      <span class="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700"></span>
      <button type="button" class={accent} {disabled} onclick={() => { picker = "images"; pickerOpen = true; }}>+ Images</button>
      <button type="button" class={accent} {disabled} title="Image next to text" onclick={() => { picker = "side"; pickerOpen = true; }}>+ Image beside text</button>
      <span class="ml-auto pr-1 text-[11px] tabular-nums text-slate-400">{words.toLocaleString()} words · {Math.max(1, Math.round(words / 230))} min read</span>
    </div>

    {#if selectedImage()}
      {@const h = selectedImage()?.node.attrs.height}
      <div class="mt-1.5 flex flex-wrap items-center gap-1 rounded-lg bg-indigo-50/80 px-2 py-1.5 text-xs dark:bg-indigo-500/10">
        <span class="mr-1 font-semibold text-indigo-800 dark:text-indigo-200">Image:</span>
        {#each [["S", 300], ["M", 450], ["L", 600]] as [label, px]}
          <button type="button" class="{btn} {h === px ? on : ''}" onclick={() => setImageHeight(px as number)}>{label}</button>
        {/each}
        <button type="button" class="{btn} {!h ? on : ''}" onclick={() => setImageHeight(null)}>Full</button>
        <span class="mx-1 h-4 w-px bg-indigo-200 dark:bg-indigo-500/30"></span>
        <button type="button" class={accent} onclick={() => putBesideText("right")}>Put beside text (image right)</button>
        <button type="button" class={accent} onclick={() => putBesideText("left")}>(image left)</button>
        <button type="button" class="{btn} ml-auto text-rose-600" onclick={removeSelectedImage}>Remove</button>
        <span class="w-full text-[11px] text-indigo-700/70 dark:text-indigo-300/70">Tip: drag the corner handle to resize, or drag the image onto the left or right edge of a paragraph to put it beside the text.</span>
      </div>
    {:else if sideBlock()}
      <div class="mt-1.5 flex flex-wrap items-center gap-1 rounded-lg bg-indigo-50/80 px-2 py-1.5 text-xs dark:bg-indigo-500/10">
        <span class="mr-1 font-semibold text-indigo-800 dark:text-indigo-200">Image beside text:</span>
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
    opacity: 0;
    transition: opacity 0.15s;
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
    content: "⇤ Image goes on the left";
    left: 0.5rem;
  }
  :global(.pt-drop-right::after) {
    content: "Image goes on the right ⇥";
    right: 0.5rem;
  }
  :global(.ProseMirror-selectednode.pt-side),
  :global(.ProseMirror-selectednode.pt-raw) {
    outline: 2px solid rgb(99 102 241);
  }
</style>
