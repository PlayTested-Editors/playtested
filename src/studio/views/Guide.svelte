<script lang="ts">
  /**
   * Contributor guide: the site's principles and what people can write.
   * Approved from docs/mocks/PlayTested-Contributor-Guide-Mock.html; keep the
   * tone relaxed (suggestions, not rules) except where ethics are involved.
   */
  const ICON = {
    play: "M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 0 1-.657.643 48.39 48.39 0 0 1-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 0 1-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 0 0-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 0 1-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 0 0 .657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 0 1-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 0 0 5.427-.63 48.05 48.05 0 0 0 .582-4.717.532.532 0 0 0-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.96.401v0a.656.656 0 0 0 .658-.663 48.422 48.422 0 0 0-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 0 1-.61-.58v0Z",
    honest: "M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0 0 12 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 0 1-2.031.352 5.988 5.988 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971Zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 0 1-2.031.352 5.989 5.989 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971Z",
    story: "M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25",
    clock: "M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    voice: "M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z",
    spoiler: "M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88",
    smile: "M15.182 15.182a4.5 4.5 0 0 1-6.364 0M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9.75 9.75c0 .414-.168.75-.375.75S9 10.164 9 9.75 9.168 9 9.375 9s.375.336.375.75Zm-.375 0h.008v.015h-.008V9.75Zm5.625 0c0 .414-.168.75-.375.75s-.375-.336-.375-.75.168-.75.375-.75.375.336.375.75Zm-.375 0h.008v.015h-.008V9.75Z",
  };

  const principles = [
    ["Play it first", "Everything you write comes from your own time with the game. Please don't rewrite someone else's review or write a \"review\" from trailers alone. Trailer impressions are fine; just say so in the title.", ICON.play],
    ["Honest, and player-first", "Help the reader answer one question: is this worth my time and money? Be excited when it's earned and say plainly when something doesn't land. Liking a game enough to play it doesn't mean going easy on it.", ICON.honest],
    ["Story first, no checklists", "The main experience comes first. Side content is worth doing when it adds something, not because an achievement list says so. No need to grind just to say you did it.", ICON.story],
    ["Patient gamer... mostly", "There's no race to be first. Waiting for patches or a sale is fine, and so is jumping in on day one when something excites you. Either way, it helps to say which version you played.", ICON.clock],
    ["Your voice, your stories", "Specific moments beat generic praise. \"I threw my empty gun at the last guard and it worked\" tells readers more than \"combat is fun\". Write like you'd talk to a friend who games.", ICON.voice],
    ["No spoilers", "Try not to give away the ending, late twists or final bosses. Talking about how they made you feel works great instead: \"the last few hours hit hard\" is enough.", ICON.spoiler],
  ];

  // [name, chip, facts, description, title hint, example, bar colour, chip colour]
  const types = [
    {
      name: "First impressions",
      chip: "Most common",
      facts: ["300–500 words", "No score", "Category: Review"],
      text: "You've played a few hours, a demo, a beta or an early access build, and you have thoughts. Say how far in you are, what hooked you, what worries you, and whether it's worth keeping an eye on.",
      hint: "Titles usually end with First Impressions, or Demo / Early Access / Beta / Trailer Impressions.",
      eg: "16-Bit JRPGs Still Have a Place in This Modern Gaming World | Chained Echoes First Impressions",
      bar: "bg-sky-500",
      chipClass: "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
    },
    {
      name: "Short review",
      chip: "",
      facts: ["350–600 words", "Score optional", "Category: Review"],
      text: "You've finished it (or played enough to judge), but it doesn't need the full treatment. A small game, a quick verdict, or one big reason to play it or skip it. Pros and Cons and a verdict are usually enough.",
      hint: "Titles usually end with Short Review.",
      eg: "Finally, a Proper Kung Fu Game! | SIFU Short Review",
      bar: "bg-emerald-500",
      chipClass: "",
    },
    {
      name: "Full review",
      chip: "",
      facts: ["800–1,500 words", "Score", "Category: Review"],
      text: "The complete verdict on a game you've finished or played deeply. The shape below is a good starting point: hook, premise, Pros and Cons, score, themed sections and a conclusion.",
      hint: "Titles usually end with Review.",
      eg: "Short but Profound Musical Masterpiece | A Highland Song Review",
      bar: "bg-indigo-500",
      chipClass: "",
    },
    {
      name: "Articles and write-ups",
      chip: "",
      facts: ["Any length", "No score", "Category: Write-up or Tech"],
      text: "Anything that isn't about one game: your games of the year, top-10 lists, opinion pieces on industry news, hardware you've used, retrospectives, or tips for a game you know well.",
      hint: "Any title you like.",
      eg: "My 2025 Games of the Year · Instead of Fleeing PC, Sony Should Have Built a Day-One PlayStation Storefront",
      bar: "bg-violet-500",
      chipClass: "",
    },
  ];

  const talk = [
    ["Gameplay and level design.", "How it plays moment to moment, and whether the systems hold up over time."],
    ["Story, characters and world.", "Did you care? (Spoiler-free.)"],
    ["Art, graphics and sound.", "Style counts as much as resolution."],
    ["Performance on your setup.", "Real-world experience, not lab benchmarks. It helps to mention what you played on: PC specs, Steam Deck, PS5, phone."],
    ["Time-to-fun and value.", "How long before it gets good, how long it lasts, and whether it's worth the price, a sale or a subscription."],
  ];

  const shape = [
    ["Title", "A hook, then the game: <code>Your Hook | Game Name Review</code>. The score goes in the Score field rather than the title."],
    ["The hook", "One or two paragraphs about your history with the game: why you picked it up, what you expected."],
    ["The premise", "For someone who has never heard of it: the setting, the goal and what you actually do minute to minute. Readers new to the game really appreciate this part."],
    ["Pros and Cons", "Two lists under the headings <code>## Pros</code> and <code>## Cons</code>, 3–5 points each. Starting each point with an emoji is a fun house touch."],
    ["Score", "For example <code>## 8.5/10</code>, if you're scoring it."],
    ["Sections", "Two to four themed parts (combat, story, performance…) with <code>###</code> headings. Explaining how things work helps as much as saying whether you liked them."],
    ["Conclusion", "Under <code>### Conclusion</code>: is it worth playing, and who is it for?"],
  ];

  const scores = [
    ["9–10", "A masterclass.", "Recommended to almost everyone, and a must-buy for fans of the genre."],
    ["8–8.9", "Great.", "A strong buy for fans and an easy recommendation with minor caveats."],
    ["7–7.9", "Good.", "Fun but flawed, or niche. Wait for a sale or a subscription if you're unsure."],
    ["6–6.9", "Mixed.", "For specific audiences only. Consider a heavy discount or a freebie."],
    ["Below 6", "Skip,", "unless you love the series or one very specific mechanic."],
  ];

  const titles = [
    ["Faithful Retelling of a Gruesome Horror Game", "Dead Space Remake First Impressions"],
    ["Puzzle Your Way Through a City of Cardboard Boxes", "Boxville Demo First Impressions"],
    ["This Is What a TRUE Sandbox Detective Game Is Like", "Shadows of Doubt Early Access Impressions"],
    ["Hunt Vampires, With Style", "Evil West Short Review"],
  ];

  const steps = [
    ["New article", "Write in the editor. Everything saves automatically, and History keeps every version, so nothing is lost."],
    ["Fill in Details", "Game name, a one- or two-sentence description, category, tags (platform and genre), and a score if it has one. Writing up something older? Set the publish date to when you wrote it (backdating)."],
    ["Add images, if you like", "Upload your own or use Find screenshots in the Media tab. Skip this if you prefer."],
    ["Submit for review", "The chief editor and editors may edit it directly: fix or rephrase the wording, add or change images. Then the chief publishes it. If it needs more from you, it comes back with notes at the top of your article, under \"Changes requested\"."],
    ["Published under your byline", "It goes live right away, on a future date (scheduled), or with an earlier date if you backdated it. Dates are in Philippine time (UTC+8)."],
  ];

  const checklist = [
    "I played what I'm writing about",
    "The title says what kind of piece it is",
    "The game's name is spelled correctly",
    "No spoilers for the ending or late twists",
    "I mentioned what I played on and how far I got",
    "I mentioned how I got the game",
    "The score matches what I wrote (or there's no score)",
    "I read it through once, start to finish",
  ];

  const toc = [
    ["principles", "What we stand for"],
    ["types", "What you can write"],
    ["talk", "What to talk about"],
    ["shape", "Shape of a full review"],
    ["scores", "Scoring"],
    ["titles", "Titles"],
    ["images", "Images"],
    ["ai", "Using AI"],
    ["ethics", "Fairness and disclosure"],
    ["publishing", "Draft to published"],
    ["checklist", "Quick check"],
    ["help", "Questions?"],
  ];

  const card = "rounded-2xl bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800";
  const note = "rounded-xl bg-sky-50 px-4 py-3 text-sm text-slate-700 dark:bg-sky-500/10 dark:text-slate-200";
  const noteB = "font-semibold text-sky-700 dark:text-sky-300";
  const h2 = "font-brand text-2xl font-bold text-slate-900 dark:text-slate-100";
  const lead = "mt-1 mb-4 text-slate-500 dark:text-slate-400";
  const code = "rounded bg-slate-100 px-1 py-px font-mono text-[13px] ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700";

  function jump(e: MouseEvent, id: string) {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }
</script>

{#snippet relax(title: string, text: string)}
  <div class="flex items-start gap-4 rounded-2xl bg-emerald-50 px-5 py-4 dark:bg-emerald-500/10">
    <svg class="mt-0.5 h-7 w-7 flex-none text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d={ICON.smile} /></svg>
    <div>
      <h3 class="font-brand text-lg font-bold text-emerald-700 dark:text-emerald-300">{title}</h3>
      <p class="mt-0.5 text-sm text-slate-700 dark:text-slate-200">{@html text}</p>
    </div>
  </div>
{/snippet}

{#snippet dodont(goodTitle: string, good: string[], badTitle: string, bad: string[])}
  <div class="grid gap-3 sm:grid-cols-2">
    <div class={card}>
      <h3 class="font-brand mb-2 text-lg font-bold">{goodTitle}</h3>
      <ul class="space-y-1.5 text-sm">
        {#each good as g}<li class="relative pl-6"><span class="absolute left-0 font-bold text-emerald-600 dark:text-emerald-400" aria-hidden="true">✓</span>{@html g}</li>{/each}
      </ul>
    </div>
    <div class={card}>
      <h3 class="font-brand mb-2 text-lg font-bold">{badTitle}</h3>
      <ul class="space-y-1.5 text-sm">
        {#each bad as b}<li class="relative pl-6"><span class="absolute left-0 font-bold text-rose-500 dark:text-rose-400" aria-hidden="true">✕</span>{@html b}</li>{/each}
      </ul>
    </div>
  </div>
{/snippet}

<div class="mx-auto grid max-w-6xl gap-10 px-4 py-8 sm:px-6 lg:px-8 xl:grid-cols-[minmax(0,1fr)_200px]">
  <article class="min-w-0 space-y-10 text-[15px] leading-relaxed text-slate-700 dark:text-slate-300">
    <header>
      <span class="inline-block rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-bold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">Contributor guide</span>
      <h1 class="font-brand mt-3 text-3xl font-bold text-slate-900 dark:text-slate-100 sm:text-4xl">How we write at PlayTested</h1>
      <p class="mt-3 max-w-[64ch] text-base text-slate-500 dark:text-slate-400">
        PlayTested is a no-nonsense game review site: honest takes from people who actually played the game. You don't need to be a professional writer. If you can explain why a game grabbed you (or didn't), you can write for us. This page covers what we value, what you can write, and how an article gets published.
      </p>
    </header>

    {@render relax("Totally no pressure", "This guide is here to help, not to test you. You don't need to memorise it or follow it strictly. <b>Tidy formatting</b> and <b>Write with AI</b> in the editor sort out most of the formatting automatically, and the chief editor fixes anything else before it goes live. Writing for fun is what matters most.")}

    <section id="principles" class="scroll-mt-20">
      <h2 class={h2}>What we stand for</h2>
      <p class={lead}>What we aim for in every article. If you remember just one, make it the first.</p>
      <div class="grid gap-3 sm:grid-cols-2">
        {#each principles as [t, d, icon]}
          <div class="{card} flex gap-4">
            <span class="grid h-9 w-9 flex-none place-items-center rounded-xl bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d={icon} /></svg>
            </span>
            <div>
              <h3 class="font-brand text-lg font-bold text-slate-900 dark:text-slate-100">{t}</h3>
              <p class="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{d}</p>
            </div>
          </div>
        {/each}
      </div>
    </section>

    <section id="types" class="scroll-mt-20">
      <h2 class={h2}>What you can write</h2>
      <p class={lead}>You can review practically any video game you like, on any platform. And not just games: tech and hardware count too, like a Steam Deck or a ROG Ally. Not every piece has to be a full review either. Most of the site is actually shorter writing. Pick whichever fits how much you've played and what you want to say.</p>
      <div class="grid gap-3 sm:grid-cols-2">
        {#each types as t}
          <div class="{card} relative overflow-hidden pl-6">
            <span class="absolute inset-y-0 left-0 w-1 {t.bar}" aria-hidden="true"></span>
            <div class="flex flex-wrap items-baseline gap-2">
              <h3 class="font-brand text-lg font-bold text-slate-900 dark:text-slate-100">{t.name}</h3>
              {#if t.chip}<span class="rounded-full px-2 py-0.5 text-[11px] font-bold {t.chipClass}">{t.chip}</span>{/if}
            </div>
            <div class="mt-2 mb-3 flex flex-wrap gap-1.5">
              {#each t.facts as f}<span class="rounded-md bg-slate-50 px-2 py-px text-xs text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:ring-slate-700">{f}</span>{/each}
            </div>
            <p class="text-sm">{t.text}</p>
            <p class="mt-3 border-t border-dashed border-slate-200 pt-3 text-[13px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
              {t.hint}<br />e.g. <b class="font-semibold text-slate-800 dark:text-slate-200">{t.eg}</b>
            </p>
          </div>
        {/each}
      </div>
      <div class="mt-3 space-y-2">
        <p class={note}><b class={noteB}>Games are mostly your own, for now.</b> The site is still new. We do get free game keys from time to time, but not nearly enough for everyone. So review the games you really want to play and would get on your own anyway. That also makes for the most honest reviews.</p>
        <p class={note}><b class={noteB}>Already reviewed on the site? Write yours anyway.</b> A game can have reviews from several authors. A second opinion, a different platform, or a look back after big patches all help readers. Reading the existing review first helps yours add something new.</p>
        <p class={note}><b class={noteB}>Have older reviews?</b> Bring them over. Reviews you wrote on your own blog, Steam, Facebook or a forum are welcome, as long as you wrote them. Set <b>Details → Publish date</b> to when you first wrote it, and it appears in the right place on the site's timeline instead of looking brand new. If it was posted somewhere else first, mention where in a note to the chief editor.</p>
        <p class={note}><b class={noteB}>Not sure which one it is?</b> Write what you have and submit it. The chief editor can help pick the right label, and a first impression can always grow into a full review later.</p>
      </div>
    </section>

    <section id="talk" class="scroll-mt-20">
      <h2 class={h2}>What to talk about</h2>
      <p class={lead}>You don't need to cover all of these. Write about what stood out to you.</p>
      <ul class="{card} list-disc space-y-1.5 pl-10 text-sm">
        {#each talk as [b, d]}<li><b class="text-slate-900 dark:text-slate-100">{b}</b> {d}</li>{/each}
      </ul>
    </section>

    <section id="shape" class="scroll-mt-20">
      <h2 class={h2}>The shape of a full review</h2>
      <p class={lead}>A shape that works well, so readers know where to look. Treat it as a starting point, not a rule: <b>Write with AI</b> and <b>Tidy formatting</b> set most of it up for you, and shorter pieces can skip parts.</p>
      <ol class="{card} divide-y divide-slate-200 !py-1 dark:divide-slate-800">
        {#each shape as [t, d], k}
          <li class="grid grid-cols-[30px_1fr] gap-3 py-3">
            <span class="grid h-7 w-7 place-items-center rounded-lg bg-slate-50 text-xs font-bold text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">{k + 1}</span>
            <span class="text-sm"><b class="block text-slate-900 dark:text-slate-100">{t}</b><span class="text-slate-500 dark:text-slate-400">{@html d.replaceAll("<code>", `<code class="${code}">`)}</span></span>
          </li>
        {/each}
      </ol>
      <p class="{note} mt-3"><b class={noteB}>Tip:</b> the game's name in <b>bold</b> when you mention it is a nice touch. <b>Tidy formatting</b> in the editor does it for you, and fixes Pros and Cons lists pasted from Google Docs or an AI chat.</p>
    </section>

    <section id="scores" class="scroll-mt-20">
      <h2 class={h2}>Scoring</h2>
      <p class={lead}>Scores go from 0 to 10 in 0.1 steps. It helps when your words and your score agree: a 7.5 reads like a fun game with real flaws, not a masterpiece. Score what you've played enough of; first impressions usually skip the score.</p>
      <div class="{card} space-y-2">
        {#each scores as [n, b, d]}
          <div class="grid grid-cols-[72px_1fr] items-center gap-4">
            <span class="font-brand rounded-xl bg-slate-50 py-1.5 text-center font-bold text-slate-900 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700">{n}</span>
            <p class="text-sm"><b class="text-slate-900 dark:text-slate-100">{b}</b> {d}</p>
          </div>
        {/each}
      </div>
    </section>

    <section id="titles" class="scroll-mt-20">
      <h2 class={h2}>Titles</h2>
      <p class={lead}>The part before <code class={code}>|</code> is the headline readers see first. A catchy line about the game works better than just "A Review". Some from the site:</p>
      <ul class="{card} divide-y divide-slate-200 !py-1 text-sm dark:divide-slate-800">
        {#each titles as [hook, game]}<li class="py-2"><b class="font-semibold text-slate-900 dark:text-slate-100">{hook}</b> <span class="text-slate-500 dark:text-slate-400">| {game}</span></li>{/each}
      </ul>
      <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">Title Case and the game's exact name are nice to have, and the chief editor tidies titles anyway. Just keep "The" or "A" when it's part of the name (<i>The Last of Us</i>, <i>A Highland Song</i>).</p>
    </section>

    <section id="images" class="scroll-mt-20">
      <h2 class={h2}>Images</h2>
      <p class={lead}>Images are optional. If you'd rather not deal with them, submit without any and the chief editor or an editor will add some.</p>
      {@render dodont(
        "Good",
        [
          "Your own screenshots. They're the best choice and show you played it (Steam: F12; consoles: the Share/Capture button).",
          "Official screenshots from <b>Media → Find screenshots</b> (Steam, or RAWG for console games). RAWG is credited automatically.",
          "A short alt text on each image describing what's in it.",
        ],
        "Please avoid",
        ["Images from Google search or other review sites. We don't have the rights to them.", "Screenshots that spoil the ending or a late-game boss.", "Phone photos of your screen, when a real screenshot is possible."],
      )}
    </section>

    <section id="ai" class="scroll-mt-20">
      <h2 class={h2}>Using AI</h2>
      <p class={lead}><b>Write with AI</b> in the editor has three levels: <b>Low</b> only fixes grammar, <b>Medium</b> also smooths a few sentences, and <b>High</b> turns rough notes into a full draft. Whichever you pick, the opinions are yours.</p>
      {@render dodont(
        "Great uses",
        ["Checking the grammar of something you wrote, or turning your notes, chat logs and brain-dumps into a first draft.", "Fixing grammar, flow and structure.", "Reading it through afterwards and rewriting anything that doesn't sound like you."],
        "Please avoid",
        ["Asking AI to review a game you haven't played.", "Keeping details you didn't experience, or \"facts\" you haven't checked.", "Pasting the reply without reading it. The final article should sound like you."],
      )}
    </section>

    <section id="ethics" class="scroll-mt-20">
      <h2 class={h2}>Fairness and disclosure</h2>
      <p class={lead}>The few things we're firm about, because readers trust us on them.</p>
      <ul class="{card} list-disc space-y-1.5 pl-10 text-sm">
        <li><b class="text-slate-900 dark:text-slate-100">Mention how you got the game:</b> bought it, review copy from the publisher, or a subscription such as Game Pass. A sentence in the article is enough.</li>
        <li><b class="text-slate-900 dark:text-slate-100">Mention what you played on,</b> and roughly how far you got or how many hours.</li>
        <li><b class="text-slate-900 dark:text-slate-100">No paid positive coverage.</b> If anyone offers you something in exchange for a better score, decline and tell the chief editor.</li>
        <li><b class="text-slate-900 dark:text-slate-100">Be fair to people.</b> Criticise the game, not the developers or other players.</li>
      </ul>
    </section>

    <section id="publishing" class="scroll-mt-20">
      <h2 class={h2}>From draft to published</h2>
      <p class={lead}>Your drafts are private. Nobody else sees them until you submit.</p>
      <ol class="{card} space-y-3">
        {#each steps as [t, d], k}
          <li class="grid grid-cols-[34px_1fr] gap-3">
            <span class="font-brand grid h-[34px] w-[34px] place-items-center rounded-full bg-indigo-600 font-bold text-white">{k + 1}</span>
            <span class="text-sm"><b class="block text-slate-900 dark:text-slate-100">{t}</b><span class="text-slate-500 dark:text-slate-400">{d}</span></span>
          </li>
        {/each}
      </ol>
    </section>

    <section id="checklist" class="scroll-mt-20">
      <h2 class={h2}>Quick check before you submit</h2>
      <p class={lead}>Optional, for anyone who likes checklists. Miss a few? The chief editor has you covered.</p>
      <ul class="{card} gap-x-6 text-sm sm:columns-2">
        {#each checklist as c}
          <li class="mb-2 flex break-inside-avoid items-start gap-2.5"><span class="mt-[3px] h-[15px] w-[15px] flex-none rounded border-[1.5px] border-slate-400 dark:border-slate-600" aria-hidden="true"></span>{c}</li>
        {/each}
      </ul>
    </section>

    {@render relax("And again: no pressure", "Missed something on this page? That's completely fine. Formatting gets fixed automatically, and the chief editor corrects anything else before publishing. No need to be strict about any of this. Just write about the games you love (or don't), and have fun with it.")}

    <section id="help" class="scroll-mt-20">
      <h2 class={h2}>Questions?</h2>
      <p class="mt-1 text-slate-500 dark:text-slate-400">Any of these work:</p>
      <ul class="mt-2 list-disc space-y-1 pl-6 text-slate-500 dark:text-slate-400">
        <li>Leave a note on your article. The chief editor will see it.</li>
        <li>Email <a class="font-medium text-indigo-600 underline dark:text-indigo-400" href="mailto:lyndon@playtested.net">lyndon@playtested.net</a>.</li>
        <li>If you already chat with Lyndon directly (Messenger, Discord or anywhere else), just message him there.</li>
      </ul>
      <p class="mt-3 text-slate-500 dark:text-slate-400">Welcome aboard, and happy writing.</p>
    </section>
  </article>

  <nav class="sticky top-8 hidden self-start text-[13px] xl:block" aria-label="On this page">
    <p class="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">On this page</p>
    {#each toc as [id, label]}
      <a href={`#${id}`} class="block border-l-2 border-slate-200 py-1 pl-3 text-slate-500 hover:border-slate-400 hover:text-slate-900 dark:border-slate-800 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-100" onclick={(e) => jump(e, id)}>{label}</a>
    {/each}
  </nav>
</div>
