/**
 * Team alerts to a Discord (or Slack) channel through an incoming webhook
 * (Worker secret ALERT_WEBHOOK_URL). Each kind can be switched off in Site &
 * limits. Noisy kinds are de-duplicated with daily/hourly counters in D1
 * (usage_daily), so a burst sends one message. Failures are swallowed: an
 * alert must never break the action that triggered it.
 */
import type { Env } from "./env";
import { bump, getGuards } from "./guards";

export const ALERT_KINDS = {
  deployFailed: "Production build failed",
  usage: "Usage limits (conserve / essential mode)",
  watchdogError: "Usage check failing",
  errors: "Error spike on the site",
  submitted: "Article submitted for review",
  reviewed: "Article approved / changes requested",
  published: "Article published or scheduled post going live",
  comments: "Comments waiting for moderation",
  team: "New team member joined",
  security: "Owner-key sign-ins and failed attempts",
} as const;
export type AlertKind = keyof typeof ALERT_KINDS;

const SITE = "https://playtested.net";
const COLOR = { red: 0xef4444, amber: 0xf59e0b, green: 0x22c55e, blue: 0x3b82f6, indigo: 0x6366f1, slate: 0x64748b };

export interface AlertMessage {
  title: string;
  description?: string;
  /** Opens when the title is clicked: a studio or site path, or a full URL. */
  url?: string;
  color?: keyof typeof COLOR;
  fields?: { name: string; value: string; inline?: boolean }[];
}

/**
 * Send one alert of this kind. `once` de-duplicates: a key sent at most once
 * per UTC day (or per hour/run, if the key says so).
 */
export async function alert(env: Env, kind: AlertKind, msg: AlertMessage, once?: string): Promise<boolean> {
  try {
    if (!env.ALERT_WEBHOOK_URL) return false;
    const g = await getGuards(env);
    if (g.alerts?.[kind] === false) return false;
    if (once && (await bump(env, `alert:${once}`)) > 1) return false;
    return await post(env, msg);
  } catch (e) {
    console.error("alert failed:", (e as Error).message);
    return false;
  }
}

/** Settings → "Send test alert": ignores the switches. */
export async function testAlert(env: Env): Promise<boolean> {
  if (!env.ALERT_WEBHOOK_URL) return false;
  return post(env, {
    title: "Test alert from PlayTested Studio",
    description: "If you can read this, alerts reach this channel. Choose which ones you want in Studio → Site & limits.",
    url: "/studio/settings/#alerts",
    color: "indigo",
  });
}

async function post(env: Env, msg: AlertMessage): Promise<boolean> {
  const url = msg.url ? (msg.url.startsWith("http") ? msg.url : SITE + msg.url) : undefined;
  const tag = env.SITE_ENV === "production" ? "" : ` (${env.SITE_ENV})`;
  // Secrets pasted through a Windows pipe can carry a byte-order mark or a newline.
  const hook = env.ALERT_WEBHOOK_URL!.replace(/^﻿/, "").trim();
  const body = hook.includes("hooks.slack.com")
    ? {
        text: [`*${msg.title}*${tag}`, msg.description, ...(msg.fields ?? []).map((f) => `${f.name}: ${f.value}`), url]
          .filter(Boolean)
          .join("\n"),
      }
    : {
        username: `PlayTested${tag}`,
        avatar_url: `${SITE}/apple-touch-icon.png`,
        allowed_mentions: { parse: [] }, // never ping @everyone from user-written text
        embeds: [
          {
            title: clip(msg.title, 250),
            description: msg.description ? clip(msg.description, 1500) : undefined,
            url,
            color: COLOR[msg.color ?? "slate"],
            fields: msg.fields?.slice(0, 10).map((f) => ({ name: clip(f.name, 250), value: clip(f.value || "—", 1000), inline: f.inline ?? true })),
            timestamp: new Date().toISOString(),
          },
        ],
      };
  const res = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) console.error("alert webhook:", res.status, (await res.text()).slice(0, 200));
  return res.ok;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
