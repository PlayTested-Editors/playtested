/**
 * Studio email notifications, sent through Cloudflare Email Routing's
 * send_email binding (production only; free). Email Routing delivers only to
 * the account's verified destination addresses, so these go to the chief
 * editor's sign-in email, which must be one of them. Failures are logged and
 * never block the action that triggered them.
 */
import { EmailMessage } from "cloudflare:email";
import type { Env } from "./env";

const FROM = "studio@playtested.net";
const SITE = "https://playtested.net";

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** A plain-text email (UTF-8, base64 so any title or note survives). */
function mime(to: string, subject: string, text: string): string {
  const body = b64(text.replace(/\r?\n/g, "\r\n")).replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: PlayTested Studio <${FROM}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@playtested.net>`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

async function sendToChiefs(env: Env, subject: string, text: string, exceptUserId?: string): Promise<{ sent: number; errors: string[] }> {
  const out = { sent: 0, errors: [] as string[] };
  if (!env.NOTIFY_EMAIL) return out;
  const rows = await env.DB.prepare("SELECT id, email FROM users WHERE role = 'chief' AND status = 'active'").all<{ id: string; email: string }>();
  for (const r of rows.results) {
    if (r.id === exceptUserId || !r.email) continue;
    try {
      await env.NOTIFY_EMAIL.send(new EmailMessage(FROM, r.email, mime(r.email, subject, text)));
      out.sent++;
    } catch (e) {
      console.error("notify: email to chief failed", (e as Error).message);
      out.errors.push((e as Error).message);
    }
  }
  return out;
}

/** Settings → "Send test email". */
export function notifyTest(env: Env) {
  return sendToChiefs(
    env,
    "PlayTested Studio: test email",
    `This is a test from PlayTested Studio. Emails like this tell you when an article is submitted for review.

Review queue: ${SITE}/studio/articles/?state=in_review

-- PlayTested Studio`,
  );
}

/** "Juan sent X for review": to the chief editor(s), not to a chief who submitted it. */
export async function notifySubmitted(
  env: Env,
  a: { id: string; title: string; author: string | null },
  by: { id: string; name: string; authorName: string | null },
  note: string | null,
): Promise<void> {
  const who = by.authorName && by.authorName !== by.name ? `${by.name} (${by.authorName})` : by.name;
  const title = a.title || "Untitled article";
  const text = [
    `${who} submitted an article for review:`,
    "",
    `  ${title}`,
    a.author ? `  Byline: ${a.author}` : "",
    "",
    note ? `Their note:\n  ${note.replace(/\n/g, "\n  ")}\n` : "",
    `Open it in the studio: ${SITE}/studio/articles/${a.id}/`,
    `Review queue: ${SITE}/studio/articles/?state=in_review`,
    "",
    "-- PlayTested Studio",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
  const r = await sendToChiefs(env, `Review needed: ${title}`, text, by.id);
  if (r.errors.length) throw new Error(r.errors[0]);
}
