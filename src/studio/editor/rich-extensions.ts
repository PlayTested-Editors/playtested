/**
 * TipTap extensions for the studio's visual editor. Each one reads and writes
 * the exact markup the site already uses, so articles round-trip between the
 * visual and markdown editors (and render the same on the site):
 *
 *  - SizedImage   `![alt](src)`, or the `.image-sized-wrapper` block when resized
 *  - ImageText    the "image beside text" block (`div.flex … md:flex-row(-reverse)`)
 *  - Caption      `<span style="font-size…; color…">` captions in older articles
 *  - RawHtml      any other block HTML, kept verbatim and shown as a preview
 *  - SideDrop     drop an image on a paragraph's left/right edge to wrap the text around it
 */
import { Extension, Mark, Node, mergeAttributes } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import Image from "@tiptap/extension-image";
import HardBreak from "@tiptap/extension-hard-break";
import { sanitizeHtml } from "../../lib/sanitize";

const attr = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const maxHeightOf = (el: HTMLElement | null) => {
  const m = /max-height:\s*(\d+)px/.exec(el?.getAttribute("style") || "");
  return m ? Number(m[1]) : null;
};

const widthOf = (el: HTMLElement | null) => {
  const m = /(?:^|;)\s*width:\s*(\d+)%/.exec(el?.getAttribute("style") || "");
  return m ? Number(m[1]) : null;
};
const wrapOf = (el: HTMLElement | null) => {
  const cls = el?.getAttribute("class") || "";
  return /\bimg-wrap-left\b/.test(cls) ? "left" : /\bimg-wrap-right\b/.test(cls) ? "right" : null;
};
export const WRAP_DEFAULT_WIDTH = 40;
export const WRAP_MAX_WIDTH = 50;
/** Dragging a wrapped image wider than this turns the wrap off (image on its own line). */
const WRAP_STACK_AT = 58;

/**
 * Images: plain markdown, the sized wrapper when given a height, or an image
 * the text wraps around (`img.img-wrap-left/right`, width in %; it stacks
 * above the text on phones). Drag the corner to resize.
 */
export const SizedImage = Image.extend({
  name: "image",
  draggable: true,

  addAttributes() {
    return {
      ...this.parent?.(),
      height: { default: null },
      wrap: { default: null }, // "left" | "right": text flows around the image
      width: { default: null }, // % of the column, for wrapped images
    };
  },

  parseHTML() {
    return [
      {
        tag: "div.image-sized-wrapper",
        priority: 100,
        getAttrs: (el) => {
          const img = (el as HTMLElement).querySelector("img");
          if (!img) return false;
          return { src: img.getAttribute("src"), alt: img.getAttribute("alt") || "", height: maxHeightOf(img) };
        },
      },
      {
        tag: "img[src]",
        getAttrs: (el) => {
          const img = el as HTMLElement;
          const wrap = wrapOf(img);
          return {
            src: img.getAttribute("src"),
            alt: img.getAttribute("alt") || "",
            title: img.getAttribute("title"),
            height: wrap ? null : maxHeightOf(img),
            wrap,
            width: wrap ? widthOf(img) ?? WRAP_DEFAULT_WIDTH : null,
          };
        },
      },
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const { src, alt, height, wrap, width } = node.attrs;
          if (wrap) {
            state.write(
              `<img src="${attr(src)}" alt="${attr(alt)}" class="img-wrap img-wrap-${wrap} rounded shadow" style="width: ${width || WRAP_DEFAULT_WIDTH}%;" />`,
            );
          } else if (height) {
            state.write(
              `<div class="image-sized-wrapper" style="--img-height:${height}px;">\n  <img src="${attr(src)}" alt="${attr(alt)}" class="mx-auto block rounded shadow" style="max-height: ${height}px;" />\n</div>`,
            );
          } else {
            state.write(`![${String(alt || "").replace(/[\[\]]/g, "")}](${src})`);
          }
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("div");
      dom.className = "pt-img";
      const img = document.createElement("img");
      img.draggable = false;
      const handle = document.createElement("span");
      handle.className = "pt-img-handle";
      handle.title = "Drag to resize";
      const badge = document.createElement("span");
      badge.className = "pt-img-badge";
      dom.appendChild(img);
      dom.appendChild(handle);
      dom.appendChild(badge);

      let current = node;
      const label = (n: typeof node, w?: number, h?: number) => {
        if (n.attrs.wrap) return `Text wraps · ${w ?? n.attrs.width ?? WRAP_DEFAULT_WIDTH}% wide`;
        const height = h ?? n.attrs.height;
        return height ? `${height}px tall` : "Full size";
      };
      const apply = (n: typeof node) => {
        img.src = n.attrs.src;
        img.alt = n.attrs.alt || "";
        const wrap = n.attrs.wrap as string | null;
        dom.classList.toggle("pt-wrap-left", wrap === "left");
        dom.classList.toggle("pt-wrap-right", wrap === "right");
        dom.style.width = wrap ? `${n.attrs.width || WRAP_DEFAULT_WIDTH}%` : "";
        img.style.maxHeight = !wrap && n.attrs.height ? `${n.attrs.height}px` : "";
        badge.textContent = label(n);
      };
      apply(node);

      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wrap = current.attrs.wrap as string | null;
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = dom.getBoundingClientRect().width;
        const startH = img.getBoundingClientRect().height;
        const column = dom.parentElement?.getBoundingClientRect().width || 800;
        dom.classList.add("pt-resizing");
        // Wrapped images resize by width (handle on the side facing the text); others by height.
        const measure = (ev: MouseEvent) => {
          if (wrap) {
            const dx = (ev.clientX - startX) * (wrap === "right" ? -1 : 1);
            return Math.round(Math.min(100, Math.max(20, ((startW + dx) / column) * 100)));
          }
          return Math.round(Math.min(1000, Math.max(120, startH + (ev.clientY - startY))));
        };
        const move = (ev: MouseEvent) => {
          const v = measure(ev);
          const stack = wrap && v > WRAP_STACK_AT;
          dom.classList.toggle("pt-will-stack", Boolean(stack));
          if (wrap) dom.style.width = `${Math.min(v, stack ? 100 : WRAP_MAX_WIDTH)}%`;
          else img.style.maxHeight = `${v}px`;
          badge.textContent = stack
            ? "Let go to put the image on its own line"
            : wrap
              ? label(current, Math.min(v, WRAP_MAX_WIDTH))
              : label(current, undefined, v);
        };
        const up = (ev: MouseEvent) => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          dom.classList.remove("pt-resizing", "pt-will-stack");
          const v = measure(ev);
          const pos = typeof getPos === "function" ? getPos() : null;
          if (pos == null) return;
          const attrs = !wrap
            ? { ...current.attrs, height: v }
            : v > WRAP_STACK_AT
              ? { ...current.attrs, wrap: null, width: null, height: null }
              : { ...current.attrs, width: Math.min(v, WRAP_MAX_WIDTH) };
          editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, attrs));
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });

      return {
        dom,
        update: (n) => {
          if (n.type.name !== "image") return false;
          current = n;
          apply(n);
          return true;
        },
        selectNode: () => dom.classList.add("pt-selected"),
        deselectNode: () => dom.classList.remove("pt-selected"),
        stopEvent: (e) => (e.target as HTMLElement)?.classList?.contains("pt-img-handle") ?? false,
        ignoreMutation: () => true,
      };
    };
  },
}).configure({ inline: false, allowBase64: false });

/** "Image beside text": image on one side, normal editable text on the other. */
export const ImageText = Node.create({
  name: "imageText",
  group: "block",
  content: "(paragraph|heading|bulletList|orderedList|blockquote)+",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: "" },
      side: { default: "right" }, // which side the IMAGE is on
      // Kept from older articles so they render exactly as before.
      outerClass: { default: null },
      imgClass: { default: null },
      textClass: { default: "flex-1 w-full" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div",
        priority: 100,
        getAttrs: (el) => {
          const d = el as HTMLElement;
          const cls = d.getAttribute("class") || "";
          if (!/\bmd:flex-row(-reverse)?\b/.test(cls)) return false;
          const img = d.querySelector(":scope > img");
          if (!img) return false;
          const inner = d.querySelector(":scope > div");
          return {
            src: img.getAttribute("src"),
            alt: img.getAttribute("alt") || "",
            side: cls.includes("md:flex-row-reverse") ? "right" : "left",
            outerClass: cls,
            imgClass: img.getAttribute("class"),
            textClass: inner ? inner.getAttribute("class") || "" : "",
          };
        },
        contentElement: (el) => {
          const d = el as HTMLElement;
          const inner = d.querySelector(":scope > div");
          if (inner) return inner as HTMLElement;
          // Older blocks put the text straight after the image.
          const box = document.createElement("div");
          for (const c of [...d.childNodes]) if (!(c instanceof HTMLImageElement)) box.appendChild(c.cloneNode(true));
          return box;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { class: `pt-side pt-side-${node.attrs.side}`, "data-image-text": "" }),
      ["img", { src: node.attrs.src, alt: node.attrs.alt, class: "pt-side-img", contenteditable: "false", draggable: "false" }],
      ["div", { class: "pt-side-text" }, 0],
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const { side, src, alt, outerClass, imgClass, textClass } = node.attrs;
          const dir = side === "left" ? "md:flex-row" : "md:flex-row-reverse";
          const outer = outerClass
            ? String(outerClass).replace(/\bmd:flex-row(-reverse)?\b/, dir)
            : `flex flex-col ${dir} items-center gap-6 mb-12 pb-6 border-b border-slate-700`;
          const textAttr = textClass ? ` class="${attr(textClass)}"` : "";
          state.write(
            `<div class="${attr(outer)}">\n  <img src="${attr(src)}" alt="${attr(alt)}" class="${attr(imgClass || "w-full md:w-2/5 rounded shadow")}" />\n  <div${textAttr}>\n\n`,
          );
          state.renderContent(node);
          state.ensureNewLine();
          state.write("\n  </div>\n</div>");
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/** Small grey captions (`<span style="font-size…; color…">`) used under images in older articles. */
export const Caption = Mark.create({
  name: "caption",
  addAttributes() {
    return { style: { default: "font-size: 0.95em; color: #888;" } };
  },
  parseHTML() {
    return [{ tag: "span[style]", getAttrs: (el) => ({ style: (el as HTMLElement).getAttribute("style") }) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
  addStorage() {
    return {
      markdown: {
        serialize: {
          open: (_state: any, mark: any) => `<span style="${attr(mark.attrs.style)}">`,
          close: "</span>",
          mixable: true,
          expelEnclosingWhitespace: true,
        },
        parse: {},
      },
    };
  },
});

/** Line breaks stay as `<br>`, matching existing articles. */
export const Br = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any) {
          state.write("<br>\n");
        },
        parse: {
          // tiptap-markdown drops the newline after every tag, which glues "**Rating**\nThe"
          // into "RatingThe". Turn line breaks after inline tags into spaces first.
          updateDOM(root: HTMLElement) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
              const prev = t.previousSibling as HTMLElement | null;
              if (!prev || prev.nodeType !== 1 || !t.data.startsWith("\n") || t.parentElement?.closest("pre")) continue;
              if (prev.tagName === "BR") t.data = t.data.replace(/^\n[ \t]*/, "");
              else if (/^(STRONG|EM|B|I|A|S|DEL|SPAN|CODE|SUP|SUB|U|MARK|SMALL|IMG)$/.test(prev.tagName)) t.data = " " + t.data.slice(1);
            }
          },
        },
      },
    };
  },
});

/** Any other block HTML: kept exactly as written, previewed (sanitized) in the editor. */
export const RawHtml = Node.create({
  name: "rawHtml",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { html: { default: "" } };
  },
  parseHTML() {
    return ["div", "figure", "table", "iframe", "video", "center", "details"].map((tag) => ({
      tag,
      priority: 10,
      getAttrs: (el: HTMLElement | string) => ({ html: (el as HTMLElement).outerHTML }),
    }));
  },
  renderHTML({ node }) {
    return ["div", { "data-raw-html": "", "data-html": node.attrs.html }];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(node.attrs.html);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "pt-raw";
      dom.contentEditable = "false";
      const label = document.createElement("span");
      label.className = "pt-raw-label";
      label.textContent = "Custom HTML · edit in Markdown mode";
      const body = document.createElement("div");
      body.innerHTML = sanitizeHtml(node.attrs.html).html;
      dom.appendChild(label);
      dom.appendChild(body);
      return { dom, ignoreMutation: () => true };
    };
  },
});

// ---- Drag an image beside a paragraph --------------------------------------

const SIDE_TARGETS = ["paragraph", "heading", "bulletList", "orderedList", "blockquote"];
export type SideZone = { pos: number; side: "left" | "right" };
const sideKey = new PluginKey<SideZone | null>("sideDrop");

/** The top-level text block under the pointer, if the pointer is in its left or right third. */
export function sideZoneAt(view: EditorView, x: number, y: number): SideZone | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const { doc } = view.state;
  const at = hit.inside >= 0 ? hit.inside : hit.pos;
  const $p = doc.resolve(at);
  const pos = $p.depth >= 1 ? $p.before(1) : at;
  const node = doc.nodeAt(pos);
  if (!node || !SIDE_TARGETS.includes(node.type.name) || !node.textContent.trim()) return null;
  const dom = view.nodeDOM(pos) as HTMLElement | null;
  if (!dom?.getBoundingClientRect) return null;
  const r = dom.getBoundingClientRect();
  const edge = Math.max(48, r.width * 0.2);
  if (x < r.left + edge) return { pos, side: "left" };
  if (x > r.right - edge) return { pos, side: "right" };
  return null;
}

/** Puts the image just before the block at zone.pos with the text wrapping around it; optionally removes it from where it was. */
export function wrapBeside(
  view: EditorView,
  zone: SideZone,
  image: { src: string; alt?: string; width?: number | null },
  remove?: { from: number; to: number },
): boolean {
  const { state } = view;
  const node = state.doc.nodeAt(zone.pos);
  if (!node || !SIDE_TARGETS.includes(node.type.name)) return false;
  const img = state.schema.nodes.image.create({
    src: image.src,
    alt: image.alt || "",
    wrap: zone.side,
    width: image.width || WRAP_DEFAULT_WIDTH,
    height: null,
  });
  const tr = state.tr;
  // Edit the later position first so the earlier one stays valid.
  if (remove && remove.from > zone.pos) tr.delete(remove.from, remove.to);
  tr.insert(zone.pos, img);
  if (remove && remove.from < zone.pos) tr.delete(remove.from, remove.to);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Shows (or clears) the "image goes here" highlight. */
export function setSideZone(view: EditorView, zone: SideZone | null) {
  const cur = sideKey.getState(view.state);
  if (cur?.pos === zone?.pos && cur?.side === zone?.side) return;
  view.dispatch(view.state.tr.setMeta(sideKey, zone).setMeta("addToHistory", false));
}

function draggedImage(view: EditorView) {
  const dragging = (view as any).dragging as { slice?: any; node?: NodeSelection } | null;
  const first: any = dragging?.slice?.content.childCount === 1 ? dragging.slice.content.firstChild : null;
  if (first?.type.name !== "image") return null;
  // Where the image is being dragged from (ProseMirror records it when the drag starts).
  const sel = dragging?.node ?? view.state.selection;
  const source = sel instanceof NodeSelection && sel.node.type.name === "image" ? { from: sel.from, to: sel.to } : null;
  return { attrs: first.attrs as { src: string; alt?: string; width?: number | null }, source };
}

export const SideDrop = Extension.create({
  name: "sideDrop",
  addProseMirrorPlugins() {
    return [
      new Plugin<SideZone | null>({
        key: sideKey,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const meta = tr.getMeta(sideKey);
            if (meta !== undefined) return meta;
            return tr.docChanged ? null : value;
          },
        },
        props: {
          decorations(state) {
            const z = sideKey.getState(state);
            const node = z ? state.doc.nodeAt(z.pos) : null;
            if (!z || !node) return null;
            return DecorationSet.create(state.doc, [Decoration.node(z.pos, z.pos + node.nodeSize, { class: `pt-drop pt-drop-${z.side}` })]);
          },
          handleDOMEvents: {
            dragover(view, e) {
              const files = e.dataTransfer?.types.includes("Files");
              setSideZone(view, files || draggedImage(view) ? sideZoneAt(view, e.clientX, e.clientY) : null);
              return false;
            },
            dragleave(view, e) {
              if (!view.dom.contains(e.relatedTarget as globalThis.Node | null)) setSideZone(view, null);
              return false;
            },
            dragend(view) {
              setSideZone(view, null);
              return false;
            },
          },
          handleDrop(view, e, _slice, moved) {
            const zone = sideZoneAt(view, e.clientX, e.clientY);
            setSideZone(view, null);
            const img = draggedImage(view);
            if (!img) return false;
            if (zone) {
              e.preventDefault();
              return wrapBeside(view, zone, img.attrs, moved && img.source ? img.source : undefined);
            }
            if (!(img.attrs as any).wrap) return false; // normal move
            // A wrapped image dropped between or inside blocks goes back on its own line.
            const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
            if (!hit) return false;
            e.preventDefault();
            const node = view.state.schema.nodes.image.create({ ...img.attrs, wrap: null, width: null, height: null });
            const tr = view.state.tr;
            let at = dropPoint(tr.doc, hit.pos, new Slice(Fragment.from(node), 0, 0)) ?? hit.pos;
            if (moved && img.source) {
              tr.delete(img.source.from, img.source.to);
              at = tr.mapping.map(at);
            }
            tr.replaceRangeWith(at, at, node);
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
