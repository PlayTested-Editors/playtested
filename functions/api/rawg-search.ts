export const onRequestGet: PagesFunction = async ({ request, env }) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("query");
  if (!query) {
    return new Response(JSON.stringify({ results: [], error: "Missing search term" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }

  const key = env.RAWG_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ results: [], error: "RAWG_API_KEY is missing on this environment" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  const apiUrl = `https://api.rawg.io/api/games?key=${encodeURIComponent(key)}&search=${encodeURIComponent(query)}&page_size=10`;

  const r = await fetch(apiUrl, {
    headers: {
      "User-Agent": "PlayTested/1.0 (lyndon@playtested.net)",
      // If your RAWG dashboard restricts to certain domains, these help locally:
      "Referer": "https://playtested.net",
      "Origin":  "https://playtested.net",
      "Accept":  "application/json"
    }
  });

  const text = await r.text();
  if (!r.ok) {
    console.error("RAWG search failed", r.status, text);
    return new Response(JSON.stringify({ results: [], error: `RAWG error ${r.status}`, detail: text }), {
      status: r.status, headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(text, { headers: { "Content-Type": "application/json" } });
};
