/** App-wide reactive state: route, session, toasts. */
import { api, type User } from "./api";

// ---------------------------------------------------------------------------
// Router (path-based under /studio/)

function readRoute() {
  const path = location.pathname.replace(/^\/studio\/?/, "").replace(/\/$/, "");
  return { parts: path ? path.split("/").map(decodeURIComponent) : [], query: new URLSearchParams(location.search) };
}

export const route = $state(readRoute());

export function navigate(to: string, replace = false) {
  const url = to.startsWith("/studio") ? to : `/studio/${to.replace(/^\//, "")}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  Object.assign(route, readRoute());
  window.scrollTo({ top: 0 });
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => Object.assign(route, readRoute()));
  // Intercept in-app links so navigation stays client-side.
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.("a");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("/studio")) {
      e.preventDefault();
      navigate(href);
    }
  });
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

export const isChief = () => session.user?.role === "chief";
export const isEditorOrAbove = () => session.user?.role === "chief" || session.user?.role === "editor";

// ---------------------------------------------------------------------------
// Toasts

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
  action?: { label: string; href: string };
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
