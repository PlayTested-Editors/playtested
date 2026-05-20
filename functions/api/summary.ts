// Define types for the environment
interface Env {
    SUMMARY_CACHE: KVNamespace;
    OPENROUTER_API_KEY: string;
}

// Simple key for tracking daily usage
const getDailyKey = () => `usage-${new Date().toISOString().split('T')[0]}`;
const DAILY_LIMIT = 150; // Cap to ensure free tier safety

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
    try {
        const { slug, text, hash, author } = await request.json() as { slug: string; text: string; hash: string; author?: string };

        if (!slug || !text || !hash) {
            return new Response(JSON.stringify({ error: "Missing required fields: slug, text, hash" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        const cacheKey = `summary-${slug}-${hash}`;
        const authorName = author || 'lyndonguitar';

        // 1. Try to fetch from KV (Cache is free/cheap to read)
        try {
            const cached = await env.SUMMARY_CACHE.get(cacheKey);
            if (cached) {
                return new Response(JSON.stringify({ summary: cached, cached: true }), {
                    headers: { "Content-Type": "application/json" },
                });
            }
        } catch (e) {
            console.error("KV Read Error:", e);
        }

        // 2. Check Daily Usage Limit (to prevent costs)
        // We only increment on *misses* (generations)
        try {
            const countStr = await env.SUMMARY_CACHE.get(getDailyKey());
            const count = countStr ? parseInt(countStr) : 0;
            if (count >= DAILY_LIMIT) {
                return new Response(JSON.stringify({ error: "Daily AI summary limit reached. Please try again tomorrow." }), {
                    status: 429,
                    headers: { "Content-Type": "application/json" },
                });
            }
        } catch (e) {
            console.error("KV Usage Check Error:", e);
        }

        // 3. Generate Summary using OpenRouter
        const messages = [
            { role: "system", content: "You are a helpful assistant that summarizes game reviews and articles. Provide concise, objective summaries without mentioning the author's name." },
            {
                role: "user",
                content: `Please provide a concise summary (max 3 sentences) of the following game review and article. Capture the main sentiment and key pros/cons. Do NOT mention the author's name in your summary.\n\nReview Content:\n${text.substring(0, 6000)}`
            },
        ];

        let summary = "";
        try {
            const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://playtested.net", // Required by OpenRouter
                    "X-Title": "PlayTested", // Required by OpenRouter
                },
                body: JSON.stringify({
                    model: "google/gemini-2.5-flash-lite", // Cheap/Free model
                    messages: messages,
                    max_tokens: 250,
                }),
            });

            if (!aiRes.ok) {
                const errText = await aiRes.text();
                throw new Error(`OpenRouter API Error: ${aiRes.status} ${errText}`);
            }

            const aiJson = await aiRes.json();
            summary = aiJson.choices?.[0]?.message?.content || "";

            if (!summary) throw new Error("Empty response from AI");

            // Increment usage counter
            const currentUsage = await env.SUMMARY_CACHE.get(getDailyKey());
            await env.SUMMARY_CACHE.put(getDailyKey(), ((currentUsage ? parseInt(currentUsage) : 0) + 1).toString(), {
                expirationTtl: 60 * 60 * 24 * 2 // Keep for 2 days
            });

        } catch (aiError) {
            console.error("AI Generation Error:", aiError);
            return new Response(JSON.stringify({ error: "Failed to generate summary" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }

        // 4. Store in KV
        try {
            await env.SUMMARY_CACHE.put(cacheKey, summary, {
                expirationTtl: 60 * 60 * 24 * 30, // 30 days
            });
        } catch (kvError) {
            console.error("KV Write Error:", kvError);
        }

        return new Response(JSON.stringify({ summary, cached: false }), {
            headers: { "Content-Type": "application/json" },
        });

    } catch (err) {
        console.error("General API Error:", err);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
};
