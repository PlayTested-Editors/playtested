<script lang="ts">
  import { tick } from "svelte";
  import type { Media } from "../api";
  import { uploadFiles } from "../images.svelte";
  import { toast } from "../state.svelte";
  import MediaPicker from "../ui/MediaPicker.svelte";

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

  let ta: HTMLTextAreaElement;
  let picker = $state<null | "image" | "side" | "sized">(null);
  let pickerOpen = $state(false);
  let dragging = $state(false);

  let words = $derived(value.replace(/<[^>]+>/g, " ").replace(/[#*_>`\[\]()!-]/g, " ").split(/\s+/).filter(Boolean).length);

  async function replaceSelection(fn: (selected: string) => { text: string; selectFrom?: number; selectTo?: number }) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.slice(start, end);
    const { text, selectFrom, selectTo } = fn(selected);
    ta.focus();
    ta.setRangeText(text, start, end, "end");
    value = ta.value;
    await tick();
    if (selectFrom !== undefined) ta.setSelectionRange(start + selectFrom, start + (selectTo ?? selectFrom));
    resize();
  }

  const wrap = (before: string, after = before, placeholder = "text") =>
    replaceSelection((s) => ({ text: `${before}${s || placeholder}${after}`, selectFrom: before.length, selectTo: before.length + (s || placeholder).length }));

  function linePrefix(prefix: string) {
    replaceSelection((s) => {
      const lines = (s || "").split("\n");
      const text = lines.map((l, i) => (prefix === "1. " ? `${i + 1}. ` : prefix) + l).join("\n");
      return { text: s ? text : prefix, selectFrom: s ? undefined : prefix.length };
    });
  }

  function heading(level: number) {
    // Make sure the heading starts on its own line.
    const start = ta.selectionStart;
    const atLineStart = start === 0 || value[start - 1] === "\n";
    replaceSelection((s) => {
      const p = `${atLineStart ? "" : "\n\n"}${"#".repeat(level)} `;
      return { text: `${p}${s || "Heading"}`, selectFrom: p.length, selectTo: p.length + (s || "Heading").length };
    });
  }

  function link() {
    replaceSelection((s) => ({ text: `[${s || "link text"}](https://)`, selectFrom: (s || "link text").length + 3, selectTo: (s || "link text").length + 11 }));
  }

  const block = (text: string) => {
    const start = ta.selectionStart;
    const before = value.slice(0, start);
    const pad = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
    return `${pad}${text}\n\n`;
  };

  function insertImages(media: Media[], kind: "image" | "side" | "sized" = "image") {
    if (!media.length) return;
    const alt = (m: Media) => (m.alt || m.filename.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ")).replace(/"/g, "'");
    let text: string;
    if (kind === "side") {
      const m = media[0];
      text = `<div class="flex flex-col md:flex-row-reverse items-center gap-6 mb-12 pb-6 border-b border-slate-700">
  <img src="${m.url}" alt="${alt(m)}" class="w-full md:w-2/5 rounded shadow" />
  <div class="flex-1 w-full">

Write the text that sits beside the image here.

  </div>
</div>`;
    } else if (kind === "sized") {
      const m = media[0];
      text = `<div class="image-sized-wrapper" style="--img-height:600px;">
  <img src="${m.url}" alt="${alt(m)}" class="mx-auto block rounded shadow" style="max-height: 600px;" />
</div>`;
    } else {
      text = media.map((m) => `![${alt(m)}](${m.url})`).join("\n\n");
    }
    replaceSelection(() => ({ text: block(text) }));
  }

  async function uploadAndInsert(files: File[]) {
    if (!files.length) return;
    const media = await uploadFiles(files, articleId);
    if (media.length) {
      onmediaadded?.(media);
      insertImages(media);
      toast(`Inserted ${media.length} image${media.length === 1 ? "" : "s"}`, "success");
    }
  }

  function resize() {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(ta.scrollHeight, 480)}px`;
  }

  $effect(() => {
    void value;
    resize();
  });

  function onkeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      wrap("**");
    } else if (mod && e.key.toLowerCase() === "i") {
      e.preventDefault();
      wrap("_");
    } else if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      link();
    } else if (e.key === "Tab" && !e.shiftKey && !mod) {
      e.preventDefault();
      replaceSelection(() => ({ text: "  " }));
    }
  }

  const tools: { label: string; title: string; run: () => void; icon: string }[] = [
    { label: "H2", title: "Heading", run: () => heading(2), icon: "" },
    { label: "H3", title: "Subheading", run: () => heading(3), icon: "" },
    { label: "B", title: "Bold (Ctrl+B)", run: () => wrap("**"), icon: "" },
    { label: "I", title: "Italic (Ctrl+I)", run: () => wrap("_"), icon: "" },
    { label: "Link", title: "Link (Ctrl+K)", run: link, icon: "M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" },
    { label: "Quote", title: "Quote", run: () => linePrefix("> "), icon: "M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" },
    { label: "List", title: "Bulleted list", run: () => linePrefix("- "), icon: "M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" },
    { label: "1.", title: "Numbered list", run: () => linePrefix("1. "), icon: "" },
    { label: "—", title: "Divider", run: () => replaceSelection(() => ({ text: block("---") })), icon: "" },
  ];
</script>

<div class="relative rounded-xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 transition {dragging ? 'ring-2 ring-indigo-500' : ''}">
  <div class="sticky top-[57px] z-10 flex flex-wrap items-center gap-0.5 rounded-t-xl border-b border-slate-100 bg-white/95 px-2 py-1.5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
    {#each tools as t}
      <button
        type="button"
        class="min-w-8 rounded-md px-2 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white {t.label === 'B' ? 'font-black' : ''} {t.label === 'I' ? 'italic font-serif' : ''}"
        title={t.title}
        {disabled}
        onclick={t.run}
      >
        {#if t.icon}
          <svg class="mx-auto h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d={t.icon} /></svg>
        {:else}{t.label}{/if}
      </button>
    {/each}
    <span class="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700"></span>
    <button type="button" class="rounded-md px-2 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10" {disabled} onclick={() => { picker = "image"; pickerOpen = true; }}>+ Images</button>
    <button type="button" class="rounded-md px-2 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10" {disabled} onclick={() => { picker = "side"; pickerOpen = true; }} title="Image beside text">+ Image & text</button>
    <button type="button" class="rounded-md px-2 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10" {disabled} onclick={() => { picker = "sized"; pickerOpen = true; }} title="Image with a maximum height">+ Sized image</button>
    <span class="ml-auto pr-1 text-[11px] tabular-nums text-slate-400">{words.toLocaleString()} words · {Math.max(1, Math.round(words / 230))} min read</span>
  </div>
  <textarea
    bind:this={ta}
    bind:value
    {disabled}
    spellcheck="true"
    placeholder="Start writing your review… Markdown works: ## headings, **bold**, _italic_, > quotes, - lists. Drop or paste images anywhere."
    class="block w-full resize-none rounded-b-xl border-0 bg-transparent px-5 py-4 font-[ui-serif,Georgia,serif] text-[16px] leading-7 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-0 dark:text-slate-200"
    {onkeydown}
    oninput={resize}
    ondragover={(e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        dragging = true;
      }
    }}
    ondragleave={() => (dragging = false)}
    ondrop={(e) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        dragging = false;
        uploadAndInsert(files);
      }
    }}
    onpaste={(e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        uploadAndInsert(files);
      }
    }}
  ></textarea>
  {#if dragging}
    <div class="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-indigo-500/10 text-sm font-semibold text-indigo-700 dark:text-indigo-300">Drop to upload and insert</div>
  {/if}
</div>

<MediaPicker
  bind:open={pickerOpen}
  {articleId}
  {articleMedia}
  multiple={picker === "image"}
  title={picker === "side" ? "Image beside text" : picker === "sized" ? "Sized image" : "Insert images"}
  onpick={(m) => {
    onmediaadded?.(m);
    insertImages(m, picker ?? "image");
  }}
/>
