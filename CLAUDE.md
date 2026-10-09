# Working on PlayTested

Read [HANDOFF.md](HANDOFF.md) first (project state, machines, release flow). Read [docs/STUDIO.md](docs/STUDIO.md) for the platform.

## Branches and releases
- Work on `dev`. It deploys the dev site on push.
- Production = `git push origin dev:main`, and only when the user asks or has approved shipping.
  - First check `git rev-list --count HEAD..origin/main` is 0. The live studio commits publishes to `main`; merge `origin/main` into `dev` if it's ahead.
- The user works from more than one machine (PC and laptop). **Before the first edit of a session**, run `git fetch` and `git status`.
  - If `dev` is behind `origin/dev`, run `git pull --ff-only` first and tell the user what came in (`git log --oneline HEAD..origin/dev`).
  - If the working tree has uncommitted changes, ask before pulling.
  - Push before stopping.

## Cloudflare free plan (hard $0 limit)
- D1 allows 5M rows read and 100k written per day, for the whole account. "Rows read" counts scanned rows, so **every query must use an index**. Check new queries with `EXPLAIN QUERY PLAN` (node:sqlite against `migrations/` works).
  - No `COUNT(*)` over big tables on list pages: fetch `pageSize + 1` instead.
  - Never filter `search_fts` by slug.
  - FTS5 writes cost about 3k reads each: never re-index article by article. Measure before any bulk job.
- New live features go behind `gate()` (guards.ts): switch, per-visitor rate limit, daily cap.
- R2 isn't available (it needs a card): uploads stage in KV.

## Security and privacy
- Never read `.env`, `.dev.vars` values, or the token `.txt` files in the parent folder. Never commit secrets. Use wrangler commands for anything that needs credentials.
- Drafts are private until submitted: any article read must go through `canView()` / `visibleSql()` (articles.ts). Hidden = 404.
- "View as" lowers the chief's role and hides their byline. Nothing may change the chief's real byline from that view.

## UI rules (the user is light-sensitive)
- No pulsing or flashing: no `animate-pulse` skeletons, no dim/undim on quick refreshes, no fade-in on re-rendered rows. Use still placeholders with "Loading…". Keep motion short and behind `prefers-reduced-motion`.
- Headings use Chakra Petch (`.font-brand`); body text stays the system font.
- Prefer a mock before a big UI change: a self-contained `.html` file in `docs/mocks/` (committed, so it reaches the user's other machine through GitHub; outside `src/` and `public/`, so it's never published). **Never publish claude.ai Artifacts** for this user.

## Practical notes (Windows)
- Shell heredocs and `node -e` often swallow backslashes in regexes (`\s`, `\b`, `\n`), and the Edit tool can turn `﻿` into a literal character. Use the Edit/Write tools for code with escapes, then grep the result.
- Piping text from PowerShell into a program can add a byte-order mark (an invisible character). Write secrets to a UTF-8-without-BOM file and use `wrangler secret bulk`.
- Files are a mix of CRLF and LF: keep each file's line endings.
- Browser checks: Playwright (`playwright-core` with the installed Chrome) against `dist/` or the live site. The studio can be tested with a mocked `/api/studio/*`.
- `gh` isn't installed. Use wrangler, git, and the site's `/build-info.json` (it shows the deployed commit).

## Writing for the user
- Short, plain answers: what changed, what they need to do, exact click paths for dashboards.
- Commit messages explain why. End them with the co-author line the session asks for.
