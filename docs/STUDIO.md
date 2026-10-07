# PlayTested Studio & platform

How the site runs, how editors publish, and how it stays on Cloudflare's free plan.

## How it fits together

```
 visitor ──► Cloudflare ──► built file in dist/?  ──yes──► served free (no Worker)
                                   │ no
                                   ▼
                              Worker (src/worker.ts)
                 junk filter → /api/* → staged images → /studio deep links
                 → just-published article (live fallback) → 404
                                   │
                    D1 (studio data, search) · R2 (uploads) · Vectorize · Workers AI
```

- **Public pages** are prerendered by Astro into `dist/` and served as static assets. They never run the Worker, so they're free and unlimited.
- **The Worker** runs only for URLs with no built file: the studio and its API, AI and search APIs, articles published moments ago whose build hasn't landed yet, and 404s.
- **Git is the published source.** The build reads `src/content/**`. **D1** holds the editorial layer: working copies, revisions, review state, users, notes and media. It also mirrors published articles for search and the live fallback.

## Publishing flow

1. An editor writes in `/studio/`. Autosave stores a working copy in D1.
2. Contributors and editors **submit for review**. The **chief editor** requests changes, approves, or publishes.
3. **Publish** commits the article markdown, plus any new images, to the content branch in one commit. The article is indexed for search immediately.
4. That push runs the deploy workflow (build → D1 sync → deploy, about 2 minutes).
5. Until the build lands, a **new** article is rendered live by the Worker at its real URL. Edits to an existing article show once the build lands.
6. **Scheduled posts**: publishing with a future date commits it, and the static build hides it until its date. The 10-minute cron then triggers a rebuild once it's due.

### Images

The studio resizes images to 1920 px and encodes them to AVIF in the browser (WebP/JPEG fallback), then uploads them to R2 under their final path (`/images/uploads/…`). Until a build includes them, the Worker serves them from R2. On publish they're committed to git and become free static files.

### Roles

| Role | Can |
|---|---|
| Chief editor | Everything: approve, request changes, publish/schedule/unpublish, team, site limits |
| Editor | Edit any article, notes, submit for review, restore revisions |
| Contributor | Write and edit their own articles, submit for review |

The team is invite-only (Team → Invite someone). People sign in with Google, or with a one-time link from the chief editor.

### Comments

- **Sign-in:** readers sign in with Google to comment. Reader accounts are separate from studio accounts and grant nothing in the studio.
- **Loading:** the comments section loads only when a reader scrolls near it, so most article views cost no Worker request.
- **Moderation:** comments with several links are held for review. Moderate in Studio → Comments: approve, hide, delete, or ban a commenter. Banning hides their comments and signs them out.
- **Old threads:** older Giscus (GitHub Discussions) threads load behind "Show older comments from GitHub".

## Staying on the free plan

The free plan allows 100,000 Worker requests per day, **shared by every Worker on the account**. Built pages don't count. The guards (`src/lib/server/guards.ts`) keep the live parts in check:

- **Junk filter**: scanner paths (`/wp-admin`, `.php`, `/.env`, …) get a cheap 404 before any work is done.
- **Per-visitor rate limits**, counted in D1: AI features 10/min, search 40/min, sign-in 10/min.
- **Daily caps per feature**, editable in Site & limits.
- **Watchdog** (cron, every 10 min): reads account-wide usage from the Cloudflare analytics API.
  - At 60% it switches to **conserve**: live fallback, recommender and comparator off.
  - At 85% it switches to **essential**: all public live features off. Built pages and the studio keep working.
  - It switches back after the 00:00 UTC (8 AM PH) reset.
  - The mode can be forced from the studio.
- Optional alert webhook (Discord/Slack) when the mode changes.

### D1 read budget

D1's free plan allows **5M rows read and 100k rows written per day, for the whole account** (every database counts, including other projects). "Rows read" counts every row a query scans, not just the rows it returns.

- **Every query must use an index.** Check new queries with `EXPLAIN QUERY PLAN`: `SEARCH … USING INDEX` is fine, while `SCAN <table>` on a big table is not.
- **Search passages are keyed by rowid** (`doc_id * 100 + chunk`). Never filter `search_fts` by `slug`, because FTS5 columns can't be indexed.
- **Writing FTS5 rows is read-heavy:** about 3k reads per article, because segment merges count as reads. A publish is fine. A full re-index done article by article is not: it cost about 2.2M reads on 2026-10-05.
- **Measure before and after any bulk operation:** `npx wrangler d1 insights playtested-dev --sort-by=reads --timePeriod=1h`. Wait a few minutes before trusting it, because the numbers lag.
- **Measured steady-state costs:**
  - search: ~300 reads
  - AI answer / Ask this review: ~300
  - studio list view: ~50–100
  - publish: ~3k
  - idle 10-minute job: ~5
- **The watchdog** steps the site down at 60% and 85% of any daily quota, D1 included.

## Setup (secrets)

Worker secrets are set with `npx wrangler secret put NAME`, run in the project folder. Values never go in git.

| Secret | Where | For |
|---|---|---|
| `GITHUB_TOKEN` | Worker | Publishing (commits) and triggering rebuilds. Fine-grained token: repo `PlayTested-Editors/playtested`, **Contents: read/write**, **Actions: read/write** |
| `CLOUDFLARE_API_TOKEN` | GitHub → repo Settings → Secrets → Actions | Automatic deploys. "Edit Cloudflare Workers" template + **D1: Edit** + **Vectorize: Edit** |
| `CF_ANALYTICS_TOKEN` | Worker | Watchdog. Custom token: **Account Analytics: Read** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Worker | Google sign-in for the studio **and** reader comments. Authorized redirect URIs: `<site>/api/studio/auth/google/callback` and `<site>/api/comments/auth/google/callback` |
| `STUDIO_OWNER_KEY` | Worker (+ your local `.dev.vars`) | Chief-editor sign-in before Google is configured |
| `OPENROUTER_API_KEY`, `RAWG_API_KEY` | Worker | AI features, game data |
| `ALERT_WEBHOOK_URL` | Worker (optional) | Usage alerts |

## Maintenance

- **Deploy dev manually**: `npm run deploy:dev` (build → D1 sync → `wrangler deploy`).
- **Database migrations**: add `migrations/000N_name.sql`, then `npm run db:migrate:dev`. CI applies them on every deploy.
- **Content edited directly in git** is picked up by `scripts/sync-d1.mjs` on the next build. That script is idempotent and leaves alone studio publishes newer than the commit being built.
- **Full search-index rebuild** (new database, schema change): `node scripts/bulk-index.mjs`. It does one SQL import plus embeddings from this machine. Never re-index article by article.
- **Image staging**: uploads stage in R2 when a `MEDIA` binding exists, otherwise in KV (`CACHE`). The PlayTested account has no R2, which needs a card.
- **Search index**: updated on publish. The cron catches up anything changed in git. Site & limits → Search index → *Index now* forces it.
- **Dev content** comes from the `dev` branch. Merge `main` into `dev` to pull in articles published on the live site.
