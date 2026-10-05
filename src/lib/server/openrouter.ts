/** OpenRouter chat completions, labelled per feature in OpenRouter's activity log. */
import type { Env } from "./env";

export const AI_MODEL = "google/gemini-2.5-flash-lite";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function openRouterHeaders(env: Env, feature: string): Record<string, string> {
  const site = env.SITE_ENV === "production" ? "PlayTested.Net" : `PlayTested.Net (${env.SITE_ENV})`;
  return {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY ?? ""}`,
    "Content-Type": "application/json",
    "HTTP-Referer": `https://playtested.net/ai/${feature}`,
    "X-Title": `${site} - ${feature}`,
  };
}

export async function complete(
  env: Env,
  feature: string,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; model?: string } = {},
): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw new Error("AI is not configured (OPENROUTER_API_KEY missing).");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: openRouterHeaders(env, feature),
    body: JSON.stringify({
      model: opts.model ?? AI_MODEL,
      messages,
      max_tokens: opts.maxTokens ?? 512,
      temperature: opts.temperature ?? 0.4,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Streaming completion; returns OpenRouter's SSE response body. */
export async function completeStream(
  env: Env,
  feature: string,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<Response> {
  if (!env.OPENROUTER_API_KEY) throw new Error("AI is not configured (OPENROUTER_API_KEY missing).");
  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: openRouterHeaders(env, feature),
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      max_tokens: opts.maxTokens ?? 1500,
      temperature: opts.temperature ?? 0.3,
      stream: true,
    }),
  });
}
