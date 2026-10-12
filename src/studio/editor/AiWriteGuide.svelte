<script lang="ts">
  import { untrack } from "svelte";
  import Modal from "../ui/Modal.svelte";
  import { toast } from "../state.svelte";
  import { AI_LEVELS, AI_SERVICES, buildPrompt, parseReply, type AiLevel } from "./ai-prompt";

  let {
    open = $bindable(false),
    hasBody = false,
    hasTitle = false,
    articleTitle = "",
    articleBody = "",
    articleGame = "",
    onuse,
  }: {
    open?: boolean;
    hasBody?: boolean;
    hasTitle?: boolean;
    /** The article as it is now: Low and Medium work on this text. */
    articleTitle?: string;
    articleBody?: string;
    articleGame?: string;
    onuse: (draft: { title: string | null; score: number | null; body: string; mode: "replace" | "append"; level: AiLevel }) => void;
  } = $props();

  const readLevel = (): AiLevel => {
    try {
      const v = localStorage.getItem("studio.aiLevel");
      return v === "low" || v === "medium" ? v : "high";
    } catch {
      return "high";
    }
  };

  let level = $state<AiLevel>(readLevel());
  let game = $state("");
  let score = $state("");
  let notes = $state(""); // High: rough notes
  let text = $state(""); // Low / Medium: the review to correct
  let reply = $state("");
  let useTitle = $state(true);
  let copied = $state(false);

  let fixing = $derived(level !== "high");
  let prompt = $derived(buildPrompt({ game, score, notes: fixing ? text : notes, level }));
  let parsed = $derived(reply.trim() ? parseReply(reply, game) : null);

  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  // The text sent for correcting, without its "# Title" line, to compare lengths.
  let sentWords = $derived(words(text.replace(/^\s*#{1,2}\s+.*\n?/, "")));
  let change = $derived(parsed && sentWords ? (words(parsed.body) - sentWords) / sentWords : 0);

  function fillFromArticle() {
    text = (articleTitle.trim() ? `# ${articleTitle.trim()}\n\n` : "") + articleBody.trim();
  }

  function setLevel(l: AiLevel) {
    level = l;
    try {
      localStorage.setItem("studio.aiLevel", l);
    } catch {
      /* remembered for this visit only */
    }
    if (l !== "high" && !text.trim()) fillFromArticle();
    useTitle = l === "high" ? !hasTitle : true;
  }

  // Only when the dialog opens: never while someone is editing inside it.
  $effect(() => {
    if (open)
      untrack(() => {
        useTitle = fixing ? true : !hasTitle;
        if (!game.trim()) game = articleGame;
        if (fixing) fillFromArticle(); // always start from the latest text
      });
  });

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      copied = true;
      setTimeout(() => (copied = false), 2500);
    } catch {
      toast("Couldn't copy automatically. Select the prompt text and copy it.", "error");
    }
  }

  /**
   * Text selected on the AI's page is copied as formatted HTML plus plain text
   * without any markdown. Convert the HTML back to markdown so headings and
   * lists survive.
   */
  async function pasteReply(e: ClipboardEvent) {
    const html = e.clipboardData?.getData("text/html");
    if (!html || !/<(h[1-6]|li|p|strong|b)\b/i.test(html)) return; // plain text: let it paste normally
    e.preventDefault();
    const el = e.currentTarget as HTMLTextAreaElement;
    const { default: TurndownService } = await import("turndown");
    const md = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", emDelimiter: "*", strongDelimiter: "**", codeBlockStyle: "fenced" })
      .turndown(html)
      .trim();
    const start = el.selectionStart ?? reply.length;
    const end = el.selectionEnd ?? reply.length;
    reply = reply.slice(0, start) + md + reply.slice(end);
  }

  function use(mode: "replace" | "append") {
    if (!parsed?.body) return;
    onuse({ title: useTitle && parsed.title ? parsed.title : null, score: parsed.score, body: parsed.body, mode, level });
    reply = "";
    open = false;
  }

  const step = "grid h-6 w-6 shrink-0 place-items-center rounded-full bg-indigo-600 text-xs font-bold text-white";
</script>

<Modal bind:open title="Write with AI" size="lg">
  <div class="space-y-6 text-sm">
    <!-- How much the AI may change -->
    <section class="space-y-2">
      <h3 class="font-semibold">How much should the AI change?</h3>
      <div class="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="How much the AI may change">
        {#each AI_LEVELS as l}
          <button
            type="button"
            role="radio"
            aria-checked={level === l.key}
            class="rounded-xl p-3 text-left ring-1 transition-colors {level === l.key
              ? 'bg-indigo-50 ring-2 ring-indigo-500 dark:bg-indigo-500/10 dark:ring-indigo-400'
              : 'ring-slate-200 hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800/60'}"
            onclick={() => setLevel(l.key)}
          >
            <span class="flex items-baseline gap-2">
              <span class="text-[10px] font-bold uppercase tracking-wider {level === l.key ? 'text-indigo-600 dark:text-indigo-300' : 'text-slate-400'}">{l.name}</span>
              <b class="text-slate-900 dark:text-slate-100">{l.label}</b>
            </span>
            <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">{l.hint}</span>
          </button>
        {/each}
      </div>
    </section>

    {#if fixing}
      <p class="text-slate-600 dark:text-slate-300">
        Checks the text you've already written with the AI you use (ChatGPT, Gemini, Claude…). {level === "low"
          ? "It only fixes mistakes, so it still reads exactly like you."
          : "It smooths awkward sentences but keeps your voice and opinions."}
      </p>
    {:else}
      <p class="text-slate-600 dark:text-slate-300">
        Turn your raw notes into a structured first draft with the AI you already use (ChatGPT, Gemini, Claude…). It writes; <b>you stay the reviewer</b>: read it,
        fix what's wrong, and make it sound like you before you submit.
      </p>
    {/if}

    <!-- 1. Notes, or the text to check -->
    <section class="space-y-3">
      <h3 class="flex items-center gap-2 font-semibold"><span class={step}>1</span> {fixing ? "Your text" : "Your notes"}</h3>
      <div class="grid gap-3 {fixing ? '' : 'sm:grid-cols-[1fr_8rem]'}">
        <div>
          <label class="label" for="ai-game">Game</label>
          <input id="ai-game" class="input" placeholder="e.g. 007 First Light" bind:value={game} />
        </div>
        {#if !fixing}
          <div>
            <label class="label" for="ai-score">Score (optional)</label>
            <input id="ai-score" class="input" inputmode="decimal" placeholder="8.5" bind:value={score} />
          </div>
        {/if}
      </div>
      {#if fixing}
        <div>
          <div class="mb-1.5 flex items-end justify-between gap-2">
            <label class="label !mb-0" for="ai-text">The review to check</label>
            <button type="button" class="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400" onclick={fillFromArticle}>Reload from my article</button>
          </div>
          <textarea
            id="ai-text"
            class="input min-h-[140px] font-mono text-xs"
            placeholder="Your article is empty. Write it first, or paste the text you want checked here."
            bind:value={text}
          ></textarea>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Filled in from your article. Edit it here if you only want part of it checked.</p>
        </div>
      {:else}
        <div>
          <label class="label" for="ai-notes">Your thoughts, in any order</label>
          <textarea
            id="ai-notes"
            class="input min-h-[140px]"
            placeholder="What you loved, what annoyed you, moments you remember, what you played on, how long… Bullet points, chat logs, half sentences: all fine."
            bind:value={notes}
          ></textarea>
        </div>
      {/if}
    </section>

    <!-- 2. Copy + open AI -->
    <section class="space-y-3">
      <h3 class="flex items-center gap-2 font-semibold"><span class={step}>2</span> Copy the prompt and paste it into your AI</h3>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn-primary" disabled={fixing && !text.trim()} onclick={copyPrompt}>{copied ? "Copied ✓" : "Copy prompt"}</button>
        <span class="text-xs text-slate-500">then open:</span>
        {#each AI_SERVICES as s}
          <a class="btn-secondary !py-1.5" href={s.url} target="_blank" rel="noopener noreferrer">{s.name} ↗</a>
        {/each}
      </div>
      <details class="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
        <summary class="cursor-pointer text-xs font-semibold text-slate-600 dark:text-slate-300">See the prompt</summary>
        <pre class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-600 select-all dark:text-slate-400">{prompt}</pre>
      </details>
      <ul class="list-disc space-y-1 pl-5 text-xs text-slate-500 dark:text-slate-400">
        <li>Start a <b>new chat</b>, paste with Ctrl+V and send.</li>
        {#if fixing}
          <li>Long review? If the AI stops halfway, ask it to "continue", then copy the whole corrected text.</li>
        {:else}
          <li>Not happy? Ask follow-ups in the same chat, like "more about the combat" or "shorter intro", then copy its final version.</li>
          <li>Check facts it adds (names, dates, prices, platforms). AI sometimes makes those up.</li>
        {/if}
      </ul>
    </section>

    <!-- 3. Paste back -->
    <section class="space-y-3">
      <h3 class="flex items-center gap-2 font-semibold"><span class={step}>3</span> Paste the AI's reply here</h3>
      <textarea
        class="input min-h-[140px] font-mono text-xs"
        placeholder="Paste the whole reply (the title line and everything after it)"
        bind:value={reply}
        onpaste={pasteReply}
      ></textarea>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        Tip: use the AI's own <b>Copy</b> button under its reply. Selecting the text by hand works too; headings and lists are converted back.
      </p>
      {#if parsed}
        <div class="rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
          {#if parsed.title}
            <label class="flex items-start gap-2">
              <input type="checkbox" class="mt-0.5" bind:checked={useTitle} />
              <span>{fixing ? "Use the corrected title" : "Use its title"}: <b>{parsed.title}</b>{hasTitle ? " (replaces your current title)" : ""}</span>
            </label>
          {/if}
          {#if parsed.score !== null && !fixing}<p class="mt-1">Score found: <b>{parsed.score}</b> (filled in if the article has no score yet)</p>{/if}
          {#if fixing}
            <p class="mt-1 text-slate-500">{sentWords} words sent, {words(parsed.body)} words back.</p>
            {#if Math.abs(change) > (level === "low" ? 0.05 : 0.15)}
              <p class="mt-1 font-medium text-amber-700 dark:text-amber-300">
                That's {Math.round(Math.abs(change) * 100)}% {change > 0 ? "longer" : "shorter"}: more than a {level === "low" ? "grammar check" : "light polish"} should change. Check nothing was cut or added.
              </p>
            {/if}
            <p class="mt-1 text-slate-500">After replacing, check that your images and links are still in place.</p>
          {:else}
            <p class="mt-1 text-slate-500">{words(parsed.body)} words of article text.</p>
          {/if}
        </div>
      {/if}
    </section>
  </div>

  {#snippet footer()}
    <button type="button" class="btn-secondary" onclick={() => (open = false)}>Close</button>
    {#if fixing}
      <button type="button" class="btn-primary" disabled={!parsed?.body} onclick={() => use("replace")}>Replace my text</button>
    {:else if hasBody}
      <button type="button" class="btn-secondary" disabled={!parsed?.body} onclick={() => use("append")}>Add below my text</button>
      <button type="button" class="btn-primary" disabled={!parsed?.body} onclick={() => use("replace")}>Replace my text</button>
    {:else}
      <button type="button" class="btn-primary" disabled={!parsed?.body} onclick={() => use("replace")}>Use this draft</button>
    {/if}
  {/snippet}
</Modal>
