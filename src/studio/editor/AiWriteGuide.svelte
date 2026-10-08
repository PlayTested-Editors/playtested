<script lang="ts">
  import Modal from "../ui/Modal.svelte";
  import { toast } from "../state.svelte";
  import { AI_SERVICES, buildPrompt, parseReply } from "./ai-prompt";

  let {
    open = $bindable(false),
    hasBody = false,
    hasTitle = false,
    onuse,
  }: {
    open?: boolean;
    hasBody?: boolean;
    hasTitle?: boolean;
    onuse: (draft: { title: string | null; score: number | null; body: string; mode: "replace" | "append" }) => void;
  } = $props();

  let game = $state("");
  let score = $state("");
  let notes = $state("");
  let reply = $state("");
  let useTitle = $state(true);
  let copied = $state(false);

  let prompt = $derived(buildPrompt({ game, score, notes }));
  let parsed = $derived(reply.trim() ? parseReply(reply) : null);

  $effect(() => {
    if (open) useTitle = !hasTitle;
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

  function use(mode: "replace" | "append") {
    if (!parsed?.body) return;
    onuse({ title: useTitle && parsed.title ? parsed.title : null, score: parsed.score, body: parsed.body, mode });
    reply = "";
    open = false;
  }

  const step = "grid h-6 w-6 shrink-0 place-items-center rounded-full bg-indigo-600 text-xs font-bold text-white";
</script>

<Modal bind:open title="Write with AI" size="lg">
  <div class="space-y-6 text-sm">
    <p class="text-slate-600 dark:text-slate-300">
      Turn your raw notes into a structured first draft with the AI you already use (ChatGPT, Gemini, Claude…). It writes; <b>you stay the reviewer</b>: read it, fix
      what's wrong, and make it sound like you before you submit.
    </p>

    <!-- 1. Notes -->
    <section class="space-y-3">
      <h3 class="flex items-center gap-2 font-semibold"><span class={step}>1</span> Your notes</h3>
      <div class="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <div>
          <label class="label" for="ai-game">Game</label>
          <input id="ai-game" class="input" placeholder="e.g. 007 First Light" bind:value={game} />
        </div>
        <div>
          <label class="label" for="ai-score">Score (optional)</label>
          <input id="ai-score" class="input" inputmode="decimal" placeholder="8.5" bind:value={score} />
        </div>
      </div>
      <div>
        <label class="label" for="ai-notes">Your thoughts, in any order</label>
        <textarea
          id="ai-notes"
          class="input min-h-[140px]"
          placeholder="What you loved, what annoyed you, moments you remember, what you played on, how long… Bullet points, chat logs, half sentences: all fine."
          bind:value={notes}
        ></textarea>
      </div>
    </section>

    <!-- 2. Copy + open AI -->
    <section class="space-y-3">
      <h3 class="flex items-center gap-2 font-semibold"><span class={step}>2</span> Copy the prompt and paste it into your AI</h3>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn-primary" onclick={copyPrompt}>{copied ? "Copied ✓" : "Copy prompt"}</button>
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
        <li>Not happy? Ask follow-ups in the same chat, like "more about the combat" or "shorter intro", then copy its final version.</li>
        <li>Check facts it adds (names, dates, prices, platforms). AI sometimes makes those up.</li>
      </ul>
    </section>

    <!-- 3. Paste back -->
    <section class="space-y-3">
      <h3 class="flex items-center gap-2 font-semibold"><span class={step}>3</span> Paste the AI's reply here</h3>
      <textarea class="input min-h-[140px] font-mono text-xs" placeholder="Paste the whole reply (the title line and everything after it)" bind:value={reply}></textarea>
      {#if parsed}
        <div class="rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
          {#if parsed.title}
            <label class="flex items-start gap-2">
              <input type="checkbox" class="mt-0.5" bind:checked={useTitle} />
              <span>Use its title: <b>{parsed.title}</b>{hasTitle ? " (replaces your current title)" : ""}</span>
            </label>
          {/if}
          {#if parsed.score !== null}<p class="mt-1">Score found: <b>{parsed.score}</b> (filled in if the article has no score yet)</p>{/if}
          <p class="mt-1 text-slate-500">{parsed.body.split(/\s+/).filter(Boolean).length} words of article text.</p>
        </div>
      {/if}
    </section>
  </div>

  {#snippet footer()}
    <button type="button" class="btn-secondary" onclick={() => (open = false)}>Close</button>
    {#if hasBody}
      <button type="button" class="btn-secondary" disabled={!parsed?.body} onclick={() => use("append")}>Add below my text</button>
      <button type="button" class="btn-primary" disabled={!parsed?.body} onclick={() => use("replace")}>Replace my text</button>
    {:else}
      <button type="button" class="btn-primary" disabled={!parsed?.body} onclick={() => use("replace")}>Use this draft</button>
    {/if}
  {/snippet}
</Modal>
