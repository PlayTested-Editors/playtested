import type { PagesFunction } from "@cloudflare/workers-types";

export const onRequestPost: PagesFunction = async ({ request, env }: { request: Request; env: { OPENROUTER_API_KEY: string } }) => {
  const body = await request.json().catch(() => ({}));
  const gameNames = Array.isArray(body?.gameNames) ? body.gameNames : [];

  if (gameNames.length < 2) {
    return new Response(JSON.stringify({ error: "Please provide at least two games to compare." }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }

  const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;

  const prompt = `Compare these games briefly in 1-2 paragraphs: ${gameNames.join(", ")}. Focus on key differences in gameplay, story, and vibe. Be concise.`;

  const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://playtested.net/ai/compare",
      "X-Title": "PlayTested.Net - Comparator",
    },
    body: JSON.stringify({
      model: "google/gemma-3-27b-it:free",
      messages: [
        { role: "system", content: "You are a concise gaming expert. Give brief, helpful comparisons in 1-2 paragraphs max." },
        { role: "user", content: prompt },
      ],
      max_tokens: 400,
    }),
  });

  const json = await aiResponse.json();
  const result = json.choices?.[0]?.message?.content ?? "No response.";
  return new Response(JSON.stringify({ result }), { headers: { "Content-Type": "application/json" } });
};
