/**
 * Site-wide motion, loaded once by BlogLayout. Astro's <ClientRouter /> keeps
 * this module alive across navigations, so per-page setup re-runs on every
 * `astro:page-load` and tears down the previous page's observer first.
 *
 *  - Scroll reveal: `[data-reveal]` elements that start below the fold fade and
 *    slide in as they enter the viewport, staggered when several arrive at once.
 *    Anything already on screen is left alone, so nothing visible ever blinks.
 *  - Shared elements: the clicked card's thumbnail/title are named
 *    `hero-<slug>`/`title-<slug>` right before the view transition, matching
 *    ArticleView, and Back names the same card in the incoming page.
 *  - Hero warm-up: resting on a card starts loading that article's hero image,
 *    so it is ready when the transition lands.
 *
 * Styles live in src/styles/global.css ("Motion" section).
 */
import type { TransitionBeforePreparationEvent, TransitionBeforeSwapEvent } from "astro:transitions/client";
import { heroTransitionName, titleTransitionName, vtName } from "../lib/transitions";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// Scroll reveal --------------------------------------------------------------

let revealObserver: IntersectionObserver | undefined;

function initReveal() {
  revealObserver?.disconnect();
  revealObserver = undefined;
  if (reducedMotion.matches || !("IntersectionObserver" in window)) return;

  const fold = window.innerHeight;
  const pending = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]")).filter(
    (el) => el.getBoundingClientRect().top >= fold,
  );
  if (!pending.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      let batch = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        observer.unobserve(el);
        const delay = Math.min(batch++, 5) * 70;
        el.style.setProperty("--reveal-delay", `${delay}ms`);
        el.classList.add("is-revealed");
        // Hand the element back to its own hover transitions once the reveal
        // (and the score badge pop it triggers) has finished.
        setTimeout(() => {
          el.classList.remove("reveal-pending", "is-revealed");
          el.style.removeProperty("--reveal-delay");
        }, delay + 900);
      }
    },
    { threshold: 0.1 },
  );
  for (const el of pending) {
    el.classList.add("reveal-pending");
    observer.observe(el);
  }
  revealObserver = observer;
}

// Shared-element transitions -------------------------------------------------

const normalize = (path: string) => {
  try {
    path = decodeURI(path);
  } catch {}
  return path.endsWith("/") ? path : `${path}/`;
};

const cardsFor = (root: ParentNode, slug: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(`[data-vt-card][data-vt-slug="${CSS.escape(slug)}"]`));

/** Elements named for the current navigation, cleared before the next one. */
const named: HTMLElement[] = [];
/** Which of a page's same-slug cards was clicked, so Back lands on that one. */
const clickedCard = new Map<string, { slug: string; index: number }>();

function setName(el: HTMLElement | null, name: string) {
  if (!el) return;
  el.style.setProperty("view-transition-name", vtName(name));
  el.classList.add("vt-morph");
  named.push(el);
}

function nameCard(card: HTMLElement, slug: string) {
  card.classList.add("vt-source");
  setName(card.querySelector("[data-vt-hero]"), heroTransitionName(slug));
  setName(card.querySelector("[data-vt-title]"), titleTransitionName(slug));
}

function clearNames() {
  for (const el of named.splice(0)) {
    el.style.removeProperty("view-transition-name");
    el.classList.remove("vt-morph");
    el.closest(".vt-source")?.classList.remove("vt-source");
  }
}

/**
 * The header keeps its own (stable) snapshot only while it is on screen on both
 * sides; otherwise it would visibly slide between its old and new positions.
 */
function pinHeader() {
  const header = document.querySelector<HTMLElement>(".site-header");
  if (!header) return;
  if (header.getBoundingClientRect().bottom > 0) header.style.removeProperty("view-transition-name");
  else header.style.setProperty("view-transition-name", "none");
}

function unpinIncomingHeader(newDocument: Document) {
  const current = document.querySelector<HTMLElement>(".site-header");
  const restoredY = (history.state as { scrollY?: number } | null)?.scrollY ?? 0;
  if (current && restoredY > current.offsetTop + current.offsetHeight) {
    newDocument.querySelector<HTMLElement>(".site-header")?.style.setProperty("view-transition-name", "none");
  }
}

document.addEventListener("astro:before-preparation", (e) => {
  const event = e as TransitionBeforePreparationEvent;
  clearNames();
  pinHeader();

  const card = (event.sourceElement as Element | undefined)?.closest?.<HTMLElement>("[data-vt-card]");
  const slug = card?.dataset.vtSlug;
  if (!card || !slug || normalize(event.to.pathname) !== normalize(`/article/${slug}/`)) return;

  clickedCard.set(normalize(location.pathname), { slug, index: cardsFor(document, slug).indexOf(card) });
  nameCard(card, slug);
});

document.addEventListener("astro:before-swap", (e) => {
  const event = e as TransitionBeforeSwapEvent;
  // Back/forward restore a scroll position, which may put the new header off screen.
  if (event.navigationType === "traverse") unpinIncomingHeader(event.newDocument);
  if (event.direction !== "back") return;
  const slug = normalize(event.from.pathname).match(/^\/article\/([^/]+)\/$/)?.[1];
  if (!slug) return;

  const cards = cardsFor(event.newDocument, slug);
  const last = clickedCard.get(normalize(event.to.pathname));
  const card = (last?.slug === slug && cards[last.index]) || cards[0];
  if (card) nameCard(card, slug);
});

// Hero warm-up ---------------------------------------------------------------

const warmed = new Map<string, HTMLImageElement>();
let warmTimer: number | undefined;

function warmHero(target: EventTarget | null) {
  const src = (target as Element | null)?.closest?.<HTMLElement>("[data-vt-card]")?.dataset.heroSrc;
  if (!src || warmed.has(src)) return;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData || /2g/.test(conn?.effectiveType ?? "")) return;
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  warmed.set(src, img);
}

// Same intent signals as Astro's hover prefetch: a short rest, a touch, or focus.
document.addEventListener(
  "mouseover",
  (e) => {
    clearTimeout(warmTimer);
    warmTimer = window.setTimeout(() => warmHero(e.target), 120);
  },
  { passive: true },
);
document.addEventListener("touchstart", (e) => warmHero(e.target), { passive: true });
document.addEventListener("focusin", (e) => warmHero(e.target));

// Per-page setup --------------------------------------------------------------

document.addEventListener("astro:page-load", initReveal);
