/**
 * Can the visual editor rewrite this article without losing anything?
 *
 * The visual editor saves by re-serialising the whole document, so any markdown
 * it can't represent would silently disappear on the first edit. This compares
 * what the original and the re-serialised markdown render to (ignoring harmless
 * differences: whitespace, attribute quoting, wrapper divs, empty inline tags),
 * and also looks for GitHub-only syntax that the editor's parser doesn't know
 * about but the site does (footnotes, task lists, `~single~` strikethrough).
 */
type Renderer = { render(src: string): string };

/** Outside code, these only mean something on the site (remark-gfm). */
const GFM_ONLY: [RegExp, string][] = [
  [/^[ \t]{0,3}\[\^[^\]\s]+\]:/m, "footnotes"],
  [/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\](?=[ \t])/m, "task-list checkboxes"],
  [/(^|[^~\\])~(?=[^\s~])[^~\n]*[^\s~\\]~(?!~)/m, "~single tilde~ strikethrough"],
];

const INLINE_TAGS = new Set(["a", "strong", "em", "b", "i", "s", "del", "strike", "u", "span", "code", "sup", "sub", "mark", "small", "kbd", "abbr"]);

function withoutCode(src: string): string {
  return src.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*$|(?![\s\S]))/gm, "").replace(/(`+)[^`\n]*?\1/g, "");
}

/** Inline formatting, compared as a set on each run of text (so `<a><strong>` equals `<strong><a>`). */
const MARK_TAGS: Record<string, string> = { strong: "b", b: "b", em: "i", i: "i", s: "s", del: "s", strike: "s", u: "u", code: "code" };

/** A flat, whitespace-insensitive description of rendered HTML. */
export function canonicalHtml(html: string): string[] {
  const tpl = document.createElement("template"); // inert: nothing loads or runs
  tpl.innerHTML = html;
  const out: string[] = [];
  const marks: string[] = [];
  let text = "";
  let key = "";
  const flush = () => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t) out.push(key ? `[${key}]${t}` : t);
    text = "";
  };
  const addText = (s: string) => {
    const k = [...marks].sort().join(",");
    if (k !== key) {
      flush();
      key = k;
    }
    text += s;
  };
  const walk = (parent: globalThis.Node, inDiv: boolean) => {
    for (const c of Array.from(parent.childNodes)) {
      if (c.nodeType === 3) {
        // Loose text at the top level (inside an HTML block) reads as a paragraph.
        if (parent === tpl.content && c.textContent?.trim()) {
          flush();
          out.push("<p>", c.textContent.replace(/\s+/g, " ").trim(), "</p>");
          continue;
        }
        addText(c.textContent ?? "");
      } else if (c.nodeType === 8) {
        flush();
        out.push(`<!--${(c as Comment).data.trim()}-->`);
      } else if (c.nodeType === 1) {
        const el = c as Element;
        const tag = el.tagName.toLowerCase();
        const empty = !el.textContent?.trim() && !el.querySelector("img,br,hr,iframe,video,input,embed,object");
        // Empty inline tags and paragraphs render as nothing.
        if (empty && (INLINE_TAGS.has(tag) || tag === "p")) continue;
        const attrs = Array.from(el.attributes)
          .map((a) => `${a.name}="${a.value.replace(/\s+/g, " ").trim()}"`)
          .sort();
        const mark = MARK_TAGS[tag] && !attrs.length ? MARK_TAGS[tag] : tag === "a" || (tag === "span" && attrs.length === 1 && el.hasAttribute("style")) ? `${tag} ${attrs.join(" ")}` : null;
        if (mark) {
          marks.push(mark);
          walk(el, inDiv);
          marks.pop();
          continue;
        }
        const transparent = !attrs.length && (tag === "div" || tag === "span" || (tag === "p" && inDiv));
        if (transparent) {
          addText(" ");
          walk(el, inDiv || tag === "div");
          addText(" ");
          continue;
        }
        flush();
        out.push(`<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`);
        walk(tag === "template" ? (el as HTMLTemplateElement).content : el, inDiv || tag === "div");
        flush();
        out.push(`</${tag}>`);
      }
    }
  };
  walk(tpl.content, false);
  flush();
  return out;
}

/** Why rewriting `source` as `serialized` would change the article (empty when it wouldn't). */
export function roundTripProblems(source: string, serialized: string, md: Renderer): string[] {
  if (source === serialized || !source.trim()) return [];
  const problems: string[] = [];
  const plain = withoutCode(source);
  for (const [re, what] of GFM_ONLY) if (re.test(plain)) problems.push(what);
  let a: string[];
  let b: string[];
  try {
    a = canonicalHtml(md.render(source));
    b = canonicalHtml(md.render(serialized));
  } catch {
    return [...problems, "formatting the visual editor can't read"];
  }
  if (a.join("\u0001") !== b.join("\u0001")) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const near = (a[i] ?? "").replace(/\s+/g, " ").slice(0, 60);
    problems.push(near ? `formatting it can't keep (near “${near}”)` : "formatting it can't keep");
  }
  return problems;
}
