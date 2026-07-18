
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, "../src/content");
const OUTPUT_PATH = path.resolve(__dirname, "../public/search-index.json");

function parseFrontmatter(fileContent) {
  const match = fileContent.match(/^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/);
  if (!match) return { data: {}, body: fileContent };

  const frontmatterRaw = match[1];
  const body = match[2].trim();
  const data = {};

  frontmatterRaw.split("\n").forEach(line => {
    const parts = line.split(":");
    if (parts.length >= 2) {
      const key = parts[0].trim();
      let value = parts.slice(1).join(":").trim();
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

function getFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".md") || f.endsWith(".mdx")).map(f => path.join(dir, f));
}

const buildSearchIndex = () => {
  console.log("Building Search index (Node.js version)...");

  const collections = ["article", "submissions"];
  let allPosts = [];

  collections.forEach(col => {
    const colDir = path.join(CONTENT_DIR, col);
    const files = getFiles(colDir);

    files.forEach(filePath => {
      const content = fs.readFileSync(filePath, "utf-8");
      const { data, body } = parseFrontmatter(content);

      // Skip future-scheduled posts (mirrors src/lib/content.ts isVisible)
      if (data.pubDate) {
        const _pub = new Date(data.pubDate);
        if (!isNaN(_pub.getTime()) && _pub.getTime() > Date.now()) return;
      }

      const filename = path.basename(filePath, path.extname(filePath));
      // Honor the frontmatter `slug` override when present so search links match the
      // site's routing (see build-rag-index.mjs); otherwise fall back to the filename.
      const slug = (data.slug && String(data.slug).trim())
        ? String(data.slug).trim()
        : filename.replace(/-+/g, '-');

      allPosts.push({
        id: slug,
        title: data.title || slug,
        description: data.description || "",
        tags: Array.isArray(data.tags) ? data.tags.join(", ") : (data.tags || ""),
        body: body.slice(0, 1000),
        url: `/article/${slug}/`,
        pubDate: data.pubDate || new Date().toISOString()
      });
    });
  });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allPosts, null, 2));
  console.log(`✅ search-index.json built with ${allPosts.length} entries.`);
};

buildSearchIndex();