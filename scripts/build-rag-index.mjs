
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, "../src/content");
const OUTPUT_PATH = path.resolve(__dirname, "../public/rag-index.json");

function parseFrontmatter(fileContent) {
    const match = fileContent.match(/^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/);
    if (!match) return { data: {}, body: fileContent };

    const frontmatterRaw = match[1];
    const body = match[2].trim();
    const data = {};

    let currentKey = null;
    frontmatterRaw.split("\n").forEach(line => {
        const listMatch = line.match(/^\s*-\s*(.*)/);
        if (listMatch && currentKey) {
            if (!Array.isArray(data[currentKey])) {
                data[currentKey] = [];
            }
            let val = listMatch[1].trim();
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
            data[currentKey].push(val);
            return;
        }

        const parts = line.split(":");
        if (parts.length >= 2) {
            const key = parts[0].trim();
            currentKey = key;
            let value = parts.slice(1).join(":").trim();
            
            if (value === "") {
                data[key] = "";
                return;
            }

            if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
            
            if (value.startsWith("[") && value.endsWith("]")) {
                value = value.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, ""));
                data[key] = value;
            } else {
                data[key] = value;
            }
        }
    });

    return { data, body };
}

// Clean body content: remove image references, HTML, and frontmatter residue
function cleanBodyContent(body) {
    return body
        // Remove any lines that look like frontmatter (key: value)
        .replace(/^[a-z]+:\s*.+$/gim, '')
        // Remove lines that are just dashes or bullet points with no meaningful content
        .replace(/^\s*-\s*$/gm, '')
        // Remove lines that start with dashes followed by tags/categories
        .replace(/^\s*-\s*[a-z0-9-]+\s*$/gim, '')
        // Remove markdown images: ![alt](path)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        // Remove HTML img tags
        .replace(/<img[^>]*>/gi, '')
        // Remove picture elements
        .replace(/<picture[^>]*>[\s\S]*?<\/picture>/gi, '')
        // Remove div elements with class attributes (often wrappers for images)
        .replace(/<div[^>]*class="[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
        // Remove avif/image path references (full paths and fragments)
        .replace(/\/images\/[^\s"'<>)]+\.(avif|png|jpg|jpeg|gif|webp)/gi, '')
        // Remove standalone image filenames like "review-0.avif" or "first-impre-0.avif"
        .replace(/[a-z0-9-]+-\d+\.avif/gi, '')
        .replace(/[a-z0-9_-]+\.(avif|png|jpg|jpeg|gif|webp)/gi, '')
        // Remove thumb: and gallery: lines and their content
        .replace(/thumb:\s*[^\n]+/gi, '')
        .replace(/gallery:\s*[^\n]+/gi, '')
        // Remove pubDate lines that leaked into body
        .replace(/pubDate:\s*[^\n]+/gi, '')
        // Remove tags lines that leaked into body  
        .replace(/tags:\s*[^\n]+/gi, '')
        // Remove empty HTML tags
        .replace(/<[^>]+>\s*<\/[^>]+>/g, '')
        // Remove br tags
        .replace(/<br\s*\/?>/gi, ' ')
        // Remove span tags but keep content
        .replace(/<span[^>]*>([^<]*)<\/span>/gi, '$1')
        // Clean up multiple newlines
        .replace(/\n{3,}/g, '\n\n')
        // Clean up lines that are just whitespace and dashes
        .replace(/^\s*[-\s]+\s*$/gm, '')
        // Clean up extra spaces
        .replace(/\s{3,}/g, ' ')
        .trim();
}

// Generate clean slug from game name
function generateCleanSlug(gameName) {
    return gameName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')  // Remove all non-alphanumeric
        .substring(0, 50);  // Limit length
}

// Recursively get all markdown files
function getFilesRecursive(dir) {
    if (!fs.existsSync(dir)) return [];
    let results = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
            results = results.concat(getFilesRecursive(fullPath));
        } else if (item.name.endsWith(".md") || item.name.endsWith(".mdx")) {
            results.push(fullPath);
        }
    }
    return results;
}

const buildRagIndex = () => {
    console.log("Building RAG index (Node.js version)...");

    const collections = ["article", "submissions"];
    let allPosts = [];
    const authorsSet = new Set();
    const categoryCounts = {};
    const seenSlugs = new Set();

    // 1. Process Content Collections (RECURSIVELY)
    collections.forEach(col => {
        const colDir = path.join(CONTENT_DIR, col);
        const files = getFilesRecursive(colDir);

        files.forEach(filePath => {
            const content = fs.readFileSync(filePath, "utf-8");
            const { data, body } = parseFrontmatter(content);

            // Skip future-scheduled posts (mirrors src/lib/content.ts isVisible)
            if (data.pubDate) {
                const _pub = new Date(data.pubDate);
                if (!isNaN(_pub.getTime()) && _pub.getTime() > Date.now()) return;
            }

            const filename = path.basename(filePath, path.extname(filePath));

            // Match the site's routing: Astro uses the frontmatter `slug` override when
            // present (see article/[slug].astro getStaticPaths -> content.slug), and only
            // falls back to the filename otherwise. Mirror that here so chatbot links
            // point at the real URL instead of the filename-derived one.
            const slug = (data.slug && String(data.slug).trim())
                ? String(data.slug).trim()
                : filename.replace(/-+/g, '-');

            // Track authors
            if (data.author) {
                authorsSet.add(data.author);
            }

            // Track categories
            const category = (data.category || "uncategorized").toLowerCase();
            categoryCounts[category] = (categoryCounts[category] || 0) + 1;

            // Clean the body content
            const cleanedBody = cleanBodyContent(body);

            // Generate a short, unique ID
            const shortId = crypto.createHash('md5').update(slug + filePath).digest('hex');

            // User requested to use 'game' frontmatter for the title if available
            const finalTitle = data.game || data.title || filename;

            // Ensure the original blog post title is searchable by adding it to the body
            const searchableBody = `Title: ${data.title || ''}\n${cleanedBody}`;

            allPosts.push({
                id: shortId,
                title: finalTitle,
                description: data.description || "",
                tags: Array.isArray(data.tags) ? data.tags.join(", ") : (data.tags || ""),
                author: data.author || "lyndonguitar",
                category: category,
                body: searchableBody,
                url: `/article/${slug}/`,
                pubDate: data.pubDate || new Date().toISOString(),
                game: data.game || "",
                rating: data.score || "N/A"
            });
        });
    });

    // 2. Build Author Info from actual data
    const authorsList = Array.from(authorsSet);
    const authorInfo = authorsList.length > 0
        ? `Authors: ${authorsList.join(", ")}. The main author and creator of PlayTested.net is Lyndon (lyndonguitar).`
        : "Main Author: Lyndon (lyndonguitar). He is the creator of PlayTested.net.";

    // 3. Build Category Stats
    const categoryStats = Object.entries(categoryCounts)
        .map(([cat, count]) => `- ${cat}: ${count} articles`)
        .join("\n");

    const totalArticles = allPosts.length;

    // Create a special document for Site Meta
    const siteMetaDoc = {
        id: "site-meta-info",
        title: "About PlayTested - Site Info & Stats",
        description: "Information about the website, authors, and statistics.",
        tags: "about, meta, authors, stats, lyndon, count, reviews, tech, write-up",
        author: "system",
        category: "meta",
        body: `
### About PlayTested
PlayTested is a no-nonsense gaming review platform and tech blog. Objective, honest reviews that cut through the noise. Created by Lyndon (lyndonguitar).

### Authors
${authorInfo}

### Statistics
- Total Articles: ${totalArticles} reviews and posts.
${categoryStats}
- Platform: Built with Astro, Tailwind, and Cloudflare.
        `.trim(),
        url: "/about/",
        pubDate: new Date().toISOString()
    };

    allPosts.push(siteMetaDoc);

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allPosts, null, 2));
    console.log(`✅ rag-index.json built with ${allPosts.length} entries (Including Site Meta).`);
    console.log(`📊 Categories: ${JSON.stringify(categoryCounts)}`);
    console.log(`👤 Authors found: ${authorsList.join(", ")}`);
};

buildRagIndex();
