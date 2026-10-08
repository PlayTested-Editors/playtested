/**
 * The "Write with AI" prompt: writers paste it, with their notes filled in,
 * into the AI service they use (ChatGPT, Gemini, …) and paste the reply back.
 * Edit the wording here; the guide in AiWriteGuide.svelte builds on it.
 */

import { tidyFormatting } from "./tidy";

export const AI_SERVICES = [
  { name: "ChatGPT", url: "https://chatgpt.com/" },
  { name: "Gemini", url: "https://gemini.google.com/app" },
  { name: "Claude", url: "https://claude.ai/new" },
  { name: "Copilot", url: "https://copilot.microsoft.com/" },
];

const PROMPT = `Role

You are an expert video game journalist and passionate gamer. Your task is to take my raw notes, chat logs, and brain-dumps about a video game and transform them into a highly engaging, well-structured, and professional review.

Tone & Style

Voice: Passionate, relatable, and opinionated. Use gaming terminology naturally (e.g., "milsim," "QTE," "I-frames," "aggro").

Tone Matching: Calibrate the overall tone to match the score I provide. (e.g., If I give a 7.5/10, ensure the review reflects a game that is fundamentally fun but dragged down by specific, frustrating flaws. If no score is provided, lean into the general vibe of my notes).

No Spoilers: NEVER spoil the ending, late-game twists, or final bosses. If my notes contain late-game details, translate them into vague emotional takeaways (e.g., "the emotional dread of the final hours" or "brilliant narrative pacing").

Authenticity: Keep my specific examples and anecdotes (e.g., "throwing an empty gun at an enemy" or "playing on Steam Deck"). Do not write generic filler.

Required Structure

Format the review exactly like this using Markdown:

Title: Catchy title with a subtitle summarizing my main takeaway. Add the score at the end if I provide one (e.g., Game Name Review: [Punchy Subtitle] (8.5/10)).

The Hook (1-2 Paragraphs): An engaging intro that details my personal history or journey with the game based on my notes.

The Premise for Newcomers (1-2 Paragraphs): Briefly explain the game's setting, core story goal, and moment-to-moment gameplay loop for someone who has never heard of it. Do not skip this!

Pros & Cons: 4-5 bullet points for Pros and 3-4 for Cons, summarizing my main praises and gripes. Start each bullet point with a relevant emoji.

Score (Optional): If a score is provided, put it here as an H2 header (e.g., ## 8.5/10).

Body Sections (2-4 Sections): Group my specific thoughts (combat, graphics, story, AI, etc.) into thematic sections with catchy H3 headers. Expand on my notes to explain how the mechanics work to the reader.

Conclusion (1 Paragraph): A final wrap-up summarizing if the game is worth playing and who it is for.

Reply with only the finished review in Markdown, starting with the title line, and no other commentary.

Input
`;

export function buildPrompt(input: { game: string; score: string; notes: string }): string {
  const lines = [PROMPT];
  if (input.game.trim()) lines.push(`Game: ${input.game.trim()}`);
  lines.push(input.score.trim() ? `My score: ${input.score.trim()}/10` : "My score: none given");
  lines.push("", "Here are my notes for the game:", input.notes.trim() || "[INSERT YOUR RAW NOTES HERE]");
  return lines.join("\n");
}

/** Splits an AI reply into title, score and body. */
export function parseReply(reply: string): { title: string; score: number | null; body: string } {
  let text = reply.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  // Copied as plain text from the AI's page: no markdown at all and one block
  // per line. Markdown would run those lines together, so separate them.
  const hasMarkdown = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)/m.test(text);
  if (!hasMarkdown && !/\n\s*\n/.test(text) && text.includes("\n")) text = text.split(/\n+/).join("\n\n");
  // Replies are often wrapped in a ```markdown code block.
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1].trim();

  const lines = text.split("\n");
  let title = "";
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0) {
    const m = /^(?:#{1,2}\s+|\*\*)?\s*(?:title\s*:\s*)?(.+?)(?:\*\*)?\s*$/i.exec(lines[first].trim());
    const firstLine = lines[first].trim();
    // Marked as a title, or (copied as plain text) a short line like "X Review: Subtitle (8/10)".
    const looksLikeTitle =
      /^(#{1,2}\s|title\s*:|\*\*)/i.test(firstLine) ||
      (firstLine.length <= 160 && !/[.!?]$/.test(firstLine) && /\breview\b|\(\d{1,2}(\.\d)?\s*\/\s*10\)\s*$/i.test(firstLine));
    if (m && looksLikeTitle) {
      title = m[1].replace(/^\*\*|\*\*$/g, "").trim();
      lines.splice(first, 1);
    }
  }
  let score: number | null = null;
  const s = /\((\d{1,2}(?:\.\d)?)\s*\/\s*10\)\s*$/.exec(title);
  if (s) {
    score = Number(s[1]);
    title = title.slice(0, s.index).trim();
  }
  // Pros / Cons in the site's usual "## Pros" + "- " bullets format.
  const body = tidyFormatting(lines.join("\n").trim()).text;
  return { title, score: score !== null && score >= 0 && score <= 10 ? score : null, body };
}
