<script lang="ts">
  /**
   * The editor tour: a spotlight that steps through the editor's real controls
   * (elements marked data-tour="…"). The dim stays on for the whole tour and
   * only the cut-out moves, so nothing flashes. Stops whose control isn't on
   * screen (no preview on phones, Publish instead of Submit for the chief) are
   * skipped. Esc ends it; ←/→ step through.
   */
  import { tick } from "svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const STOPS = [
    { key: "title", h: "Start with the title", p: 'Use "Review Title | Game Name Review". The part before | is the headline, the part after names the game.' },
    { key: "ai", h: "Write with AI (optional)", p: "Got rough notes? This gives you a ready prompt for ChatGPT, Gemini or any AI. Paste its reply back and it's formatted for you. Then make it your own." },
    { key: "tidy", h: "Tidy formatting", p: "Pasted from Google Docs or an AI? One click fixes Pros & Cons lists and strips stray colours and fonts. You can undo it." },
    { key: "images", h: "Add images (optional)", p: "Upload your own, or open Find screenshots for official ones from Steam or RAWG. Skip it if you like: the chief editor can add images." },
    { key: "details", h: "Details", p: "Game name, score, a short description and the thumbnail live here. Filling in the game name helps Find screenshots." },
    { key: "preview", h: "Live preview", p: "Exactly how it will look on PlayTested.net, updated as you type. Switch to Phone to check the mobile view." },
    { key: "history", h: "Autosave and History", p: "Everything saves as you go. History keeps every version, so nothing you write is lost." },
    { key: "submit", h: "Submit for review", p: "When it's ready, send it to the chief editor. They publish it or leave notes, which show at the top of this page." },
  ];

  const target = (key: string) => {
    const el = document.querySelector<HTMLElement>(`[data-tour="${key}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? el : null;
  };

  let stops = $state<typeof STOPS>([]);
  let i = $state(0);
  let spot = $state({ left: 0, top: 0, width: 0, height: 0 });
  let pop = $state({ left: 0, top: 0, side: "below" as "below" | "above" | "beside", arrow: 0 });
  let card = $state<HTMLDivElement>();
  let nextBtn = $state<HTMLButtonElement>();
  const narrow = () => innerWidth <= 640;

  $effect(() => {
    if (open) start();
  });

  async function start() {
    await tick(); // the editor switches to the Write tab first
    stops = STOPS.filter((s) => target(s.key));
    i = 0;
    if (!stops.length) {
      open = false;
      return;
    }
    place();
  }

  async function place() {
    const el = target(stops[i]?.key ?? "");
    if (!el) {
      // The layout changed under us (window resized): recompute the stops.
      stops = STOPS.filter((s) => target(s.key));
      i = Math.min(i, stops.length - 1);
      if (i < 0) return end();
      return place();
    }
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const pad = 6;
    const top = Math.max(r.top - pad, 4);
    const bottom = Math.min(r.bottom + pad, innerHeight - 8);
    spot = { left: r.left - pad, top, width: r.width + pad * 2, height: bottom - top };
    await tick();
    if (narrow() || !card) return;
    const pw = card.offsetWidth, ph = card.offsetHeight, gap = 14;
    if (r.height > innerHeight * 0.5) {
      // Tall target (the preview pane): the card sits beside it.
      pop = { left: Math.max(12, r.left - pw - gap), top: Math.max(top + 20, 70), side: "beside", arrow: 0 };
    } else {
      const below = bottom + gap + ph < innerHeight;
      const left = Math.min(Math.max(12, r.left + r.width / 2 - pw / 2), innerWidth - pw - 12);
      pop = { left, top: below ? bottom + gap : top - gap - ph, side: below ? "below" : "above", arrow: Math.min(Math.max(14, r.left + r.width / 2 - left - 6), pw - 26) };
    }
    nextBtn?.focus({ preventScroll: true });
  }

  function end() {
    open = false;
  }
  function go(d: number) {
    if (i + d >= stops.length) return end();
    i = Math.max(0, i + d);
    place();
  }
  function onkeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      end();
    } else if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft" && i) go(-1);
  }
  function relayout() {
    if (open && stops.length) place();
  }
</script>

<svelte:window {onkeydown} onresize={relayout} />

{#if open && stops.length}
  {@const s = stops[i]}
  <!-- Blocks clicks on the page while the tour runs. -->
  <div class="fixed inset-0 z-[60]" aria-hidden="true"></div>
  <div
    class="tour-spot pointer-events-none fixed z-[61] rounded-xl"
    style="left:{spot.left}px; top:{spot.top}px; width:{spot.width}px; height:{spot.height}px"
    aria-hidden="true"
  ></div>
  <div
    bind:this={card}
    class="fixed z-[62] rounded-2xl bg-white px-4 pb-3 pt-3.5 shadow-2xl ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10
      {narrow() ? 'inset-x-3 bottom-3' : 'w-[320px]'}"
    style={narrow() ? "" : `left:${pop.left}px; top:${pop.top}px`}
    role="dialog"
    aria-label="Editor tour"
    aria-live="polite"
  >
    {#if !narrow() && pop.side !== "beside"}
      <i
        class="absolute h-3 w-3 rotate-45 bg-white ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10 {pop.side === 'below' ? '-top-1.5 [clip-path:polygon(0_0,100%_0,0_100%)]' : '-bottom-1.5 [clip-path:polygon(100%_0,100%_100%,0_100%)]'}"
        style="left:{pop.arrow}px"
      ></i>
    {/if}
    <p class="text-[11px] font-bold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">{i + 1} of {stops.length}</p>
    <h3 class="mt-0.5 text-base font-semibold">{s.h}</h3>
    <p class="mt-1 text-[13px] text-slate-500 dark:text-slate-400">{s.p}</p>
    <div class="mt-3 flex items-center gap-1.5">
      <button type="button" class="mr-auto text-xs text-slate-500 underline hover:text-slate-800 dark:hover:text-slate-200" onclick={end}>Skip tour</button>
      <button type="button" class="btn-ghost {i ? '' : 'invisible'}" onclick={() => go(-1)}>Back</button>
      <button type="button" class="btn-primary" bind:this={nextBtn} onclick={() => go(1)}>{i === stops.length - 1 ? "Done" : "Next"}</button>
    </div>
  </div>
{/if}

<style>
  /* One cut-out: a ring around the control and a dim over everything else. */
  .tour-spot {
    box-shadow:
      0 0 0 2px #818cf8,
      0 0 0 200vmax rgb(15 23 42 / 0.55);
    transition:
      left 0.18s ease,
      top 0.18s ease,
      width 0.18s ease,
      height 0.18s ease;
  }
  :global(.dark) .tour-spot {
    box-shadow:
      0 0 0 2px #a5b4fc,
      0 0 0 200vmax rgb(2 6 23 / 0.7);
  }
  @media (prefers-reduced-motion: reduce) {
    .tour-spot {
      transition: none;
    }
  }
</style>
