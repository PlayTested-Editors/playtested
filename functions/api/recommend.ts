export const onRequestPost: PagesFunction = async ({ request, env }) => {
  const body = await request.json().catch(() => ({}));
  const gameNames = Array.isArray(body?.gameNames) ? body.gameNames : [];

  if (gameNames.length === 0) {
    return new Response(JSON.stringify({ error: "No games provided." }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }

  const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  const RAWG_API_KEY = env.RAWG_API_KEY;

  const prompt = `The user enjoys these games: ${gameNames.join(", ")}.

Recommend exactly 3 modern games they might love. Respond STRICTLY with ONLY a plain comma-separated list of titles like: Game Title A, Game Title B, Game Title C
No explanations, no numbers, no periods, no extra text whatsoever. Just the titles separated by commas.`;

  const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://playtested.net/ai/recommend",
      "X-Title": "PlayTested.Net - Recommender",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-lite",
      messages: [
        { role: "system", content: "You are a game recommendation expert. Respond EXACTLY as instructed, with only the comma-separated game titles. No other output." },
        { role: "user", content: prompt },
      ],
      max_tokens: 512,
    }),
  });

  if (!aiRes.ok) {
    return new Response(JSON.stringify({ error: "AI recommendation failed." }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  const aiJson = await aiRes.json();
  const titleLine = aiJson.choices?.[0]?.message?.content?.trim() ?? "";
  const titles = titleLine
    .split(",")
    .map((t: string) => t.trim().replace(/^\d+\.?\s*/, "").replace(/[.!?]$/, ""))
    .filter(Boolean)
    .slice(0, 3);

  if (titles.length < 3) {
    return new Response(JSON.stringify({ error: "Unable to generate sufficient recommendations.", rawResponse: titleLine }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  async function fetchGame(title: string) {
    const r = await fetch(`https://api.rawg.io/api/games?key=${RAWG_API_KEY}&search=${encodeURIComponent(title)}`);
    if (!r.ok) return { title, name: title, released: "Unknown", image: null, slug: null, url: null };
    const j = await r.json();
    const g = j.results?.[0];
    return {
      title,
      name: g?.name || title,
      released: g?.released || "Unknown",
      image: g?.background_image || null,
      slug: g?.slug || null,
      url: g?.slug ? `https://rawg.io/games/${g.slug}` : null,
    };
  }

  const enriched = await Promise.all(titles.map(fetchGame));

  const explainPrompt = `The user enjoys: ${gameNames.join(", ")}. Based on that, you recommended: ${titles.join(", ")}.

Now explain in 3 paragraphs — one per game — why the user would enjoy each title. Mention gameplay, story, style, or similarities to their favorites. No bullet points or markdown. Use full sentences.`;

  const explainRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://playtested.net/ai/recommend",
      "X-Title": "PlayTested.Net - Recommender",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-lite",
      messages: [
        { role: "system", content: "You are a helpful game recommendation analyst." },
        { role: "user", content: explainPrompt },
      ],
      max_tokens: 1024,
    }),
  });

  if (!explainRes.ok) {
    return new Response(JSON.stringify({ error: "AI explanation failed.", recommended: enriched }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  const explainJson = await explainRes.json();
  const explanation = explainJson.choices?.[0]?.message?.content?.trim() ?? "";

  return new Response(JSON.stringify({ recommended: enriched, explanation }), {
    headers: { "Content-Type": "application/json" },
  });
};