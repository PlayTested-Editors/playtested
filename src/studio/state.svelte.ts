/** App-wide reactive state: route, session, toasts. */
import { api, setUnauthorizedHandler, type User } from "./api";

// ---------------------------------------------------------------------------
// Router (path-based under /studio/)

function readRoute() {
  const path = location.pathname.replace(/^\/studio\/?/, "").replace(/\/$/, "");
  return { parts: path ? path.split("/").map(decodeURIComponent) : [], query: new URLSearchParams(location.search) };
}

export const route = $state(readRoute());

/**
 * Copy the URL into `route`, but only the pieces that changed: assigning a new
 * (equal) array/params object would re-run every effect that reads the route.
 */
function syncRoute() {
  const next = readRoute();
  if (next.parts.join("/") !== route.parts.join("/")) route.parts = next.parts;
  if (next.query.toString() !== route.query.toString()) route.query = next.query;
}

/** Scroll to the URL's #fragment, waiting (briefly) for the view to render it. */
export function scrollToHash(hash = location.hash) {
  if (!hash || hash.length < 2) return;
  let tries = 0;
  const tick = () => {
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (++tries < 50) setTimeout(tick, 100);
  };
  tick();
}

/**
 * A view can ask to confirm before in-app navigation away from it (e.g. "keep
 * this draft?"). Return false to stay. Browser back/forward isn't intercepted.
 */
type LeaveGuard = (to: string) => boolean | Promise<boolean>;
let leaveGuard: LeaveGuard | null = null;
export function setLeaveGuard(guard: LeaveGuard | null) {
  leaveGuard = guard;
}

export async function navigate(to: string, replace = false) {
  const url = to.startsWith("/studio") ? to : `/studio/${to.replace(/^\//, "")}`;
  if (leaveGuard) {
    const guard = leaveGuard;
    if (!(await guard(url))) return;
    if (leaveGuard === guard) leaveGuard = null;
  }
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  syncRoute();
  if (location.hash) scrollToHash();
  else window.scrollTo({ top: 0 });
}

const isStudioHref = (href: string) => href === "/studio" || href.startsWith("/studio/") || href.startsWith("/studio?") || href.startsWith("/studio#");

if (typeof window !== "undefined") {
  window.addEventListener("popstate", syncRoute);
  // Intercept in-app links so navigation stays client-side.
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.("a");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.hasAttribute("download")) return;
    const href = a.getAttribute("href") || "";
    if (isStudioHref(href)) {
      e.preventDefault();
      navigate(href);
    }
  });
}

// ---------------------------------------------------------------------------
// Where to go after signing in (the page a signed-out visit or an expired
// session bounced from). Per-tab, and only honoured for a few minutes.

const RETURN_KEY = "studio.return";
const RETURN_TTL_MS = 15 * 60_000;
let returnMemo: { path: string; at: number } | null = null;

export function rememberReturn(path = location.pathname + location.search + location.hash) {
  if (!isStudioHref(path) || /^\/studio\/(login|invite)(\/|$|\?)/.test(path)) return;
  returnMemo = { path, at: Date.now() };
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(returnMemo));
  } catch {
    /* storage blocked */
  }
}

/** The remembered path (once), or null. */
export function takeReturn(): string | null {
  let memo = returnMemo;
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    if (raw) memo = JSON.parse(raw);
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    /* storage blocked */
  }
  returnMemo = null;
  if (!memo || typeof memo.path !== "string" || Date.now() - memo.at > RETURN_TTL_MS || !isStudioHref(memo.path)) return null;
  return memo.path;
}

export function clearReturn() {
  returnMemo = null;
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    /* storage blocked */
  }
}

// ---------------------------------------------------------------------------
// Session

export const session = $state<{
  loaded: boolean;
  user: User | null;
  env: string;
  setup: { hasUsers: boolean; ownerKey: boolean; google: boolean };
}>({ loaded: false, user: null, env: "", setup: { hasUsers: true, ownerKey: false, google: false } });

export async function loadSession() {
  const me = await api.get<{ user: User | null; env: string; setup: typeof session.setup }>("/me");
  session.user = me.user;
  session.env = me.env;
  session.setup = me.setup;
  session.loaded = true;
}

// A signed-in call came back 401: the session expired or was revoked. Drop the
// user; App then remembers this page and shows the sign-in screen.
setUnauthorizedHandler(() => {
  if (!session.user) return;
  session.user = null;
  toast("Your session ended — sign in again to continue.", "error", undefined, 7000);
});

// Bump to make the sidebar re-fetch its badge counts (review queue, held comments).
export const counts = $state({ version: 0 });
export function refreshCounts() {
  counts.version++;
}

export const isChief = () => session.user?.role === "chief";
export const isEditorOrAbove = () => session.user?.role === "chief" || session.user?.role === "editor";

// ---------------------------------------------------------------------------
// Toasts

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
  /** A link (href) or an in-app action (run), e.g. "Undo". */
  action?: { label: string; href?: string; run?: () => void };
}

export const toasts = $state<Toast[]>([]);
let toastId = 0;

export function toast(message: string, kind: Toast["kind"] = "info", action?: Toast["action"], ms = 4500) {
  const t = { id: ++toastId, kind, message, action };
  toasts.push(t);
  setTimeout(() => {
    const i = toasts.findIndex((x) => x.id === t.id);
    if (i > -1) toasts.splice(i, 1);
  }, ms);
}

export function dismissToast(id: number) {
  const i = toasts.findIndex((x) => x.id === id);
  if (i > -1) toasts.splice(i, 1);
}

export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), "error", undefined, 7000);
}

// ---------------------------------------------------------------------------
// Theme (shares the site's localStorage key)

export function applyTheme() {
  let theme = "light";
  try {
    theme = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch {
    /* storage blocked */
  }
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function toggleTheme() {
  const dark = !document.documentElement.classList.contains("dark");
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem("theme", dark ? "dark" : "light");
  } catch {
    /* storage blocked */
  }
}
