# PlayTested: handoff

Where this project stands and how to pick it up on any machine (PC or laptop), for you and for any Claude Code session. Last updated 2026-10-09.

- **How the platform works, secrets, maintenance:** [docs/STUDIO.md](docs/STUDIO.md)
- **Rules for Claude sessions:** [CLAUDE.md](CLAUDE.md)

---

## 1. Work from any machine

GitHub holds everything you need to work on the site: code, content, docs and design mocks (`docs/mocks/`). The only things not in GitHub are local secrets (`.dev.vars`, `.env`), and you rarely need them (see 1.3).

### 1.1 Daily routine (same on every machine)

1. **Start:** open the project, then `git pull`. You're always on `dev`.
2. **Work.** Claude commits as it goes.
3. **Stop:** make sure everything is pushed (`git status` clean, `git push`). Even half-done work goes to `dev`, so the other machine can continue it.

If you forget to push on one machine, the other one simply won't have that work yet. Push from the first machine, then pull on the second.

### 1.2 Set up a new machine (once)

Install:
- **Git**: <https://git-scm.com> (it includes Git Credential Manager, so GitHub sign-in is a browser click).
- **Node.js 22 LTS**: <https://nodejs.org>
- **VS Code** and the **Claude Code** extension.

Then:
1. Clone: `git clone https://github.com/PlayTested-Editors/playtested.git storyteller-astro`. Any folder works; matching the PC path (`...\Project\reviews\storyteller-astro`) keeps things simple.
2. In the project folder, run `powershell -ExecutionPolicy Bypass -File scripts/setup-machine.ps1`. It checks Git and Node, switches to `dev`, installs packages, and tells you what's missing.
3. Sign in to Cloudflare: `npx wrangler login` with the **rebutoclyndon02@gmail.com** account. It's Super Admin on the PlayTested and Kasama accounts, so one login works for both.
4. Open the folder in VS Code and start Claude Code. It reads `CLAUDE.md` automatically.

### 1.3 Local secrets (usually not needed)

Normal work doesn't need them: Claude edits, pushes to `dev`, and GitHub builds and deploys the dev site with its own stored secrets, so you test on the dev site. They're only needed to run the site locally (`npm run dev`) or for a few maintenance scripts (for example `scripts/bulk-index.mjs`).

When a machine does need them:
- Keep `.dev.vars` and `.env` in a password manager (Bitwarden is free) or copy them over by USB, then put them in the project folder. The setup script also copies them from a folder named `PlayTested-private` next to the repo, if one exists (`-Private <path>` points it elsewhere).
- **Never commit them**, not even to a private repo. The live site's secrets live in Cloudflare and GitHub, not in these files.

Don't sync the project folder with a file-sync tool: `node_modules`, `.git` and build output change constantly and two machines would conflict. Git already keeps the project in sync.

### 1.4 Claude's memory

Claude Code keeps per-machine notes in `C:\Users\<you>\.claude\projects\<folder-name>\memory\`. The important ones are written into `CLAUDE.md` and this file, which travel with git, so the laptop doesn't need them. If you want them anyway, copy that `memory` folder to the same place on the laptop after its first Claude session there. The folder name comes from the project path.

---

## 2. Where things are

| | |
|---|---|
| Live site | <https://playtested.net>: Worker `playtested`, deployed from `main` |
| Dev site | <https://playtested-dev.lyndongaming.workers.dev>: Worker `playtested-dev`, deployed from `dev` |
| Studio (CMS) | `/studio/` on either site. Chief editor: lyndongaming@gmail.com, byline **lyndonguitar** |
| Repo | <https://github.com/PlayTested-Editors/playtested> |
| Cloudflare | **PlayTested** account `3290294832f56e48f5c04f91d5d87634` (lyndongaming@). Kasama and personal sites are separate accounts, so their free quotas don't collide. |
| Email | lyndon@playtested.net → lyndongaming@gmail.com (Email Routing). Studio emails come from studio@playtested.net. |
| Alerts | Discord `#playtested-alerts` (Worker secret `ALERT_WEBHOOK_URL`); switches in Studio → Site & limits |

### Release flow
1. Work and commit on `dev`, then `git push origin dev`. That deploys the dev site.
2. Release with `git push origin dev:main`, which deploys playtested.net in about 2–3 minutes.
3. **First** check `git rev-list --count HEAD..origin/main` is `0`. Publishing in the live studio commits to `main`, so `main` can get ahead. If it's not 0, run `git merge origin/main` on `dev` first.

---

## 3. What's built (October 2026 overhaul)

- **Platform:** Astro static site plus a Cloudflare Worker for the studio, APIs, search and AI. D1, KV and Vectorize; free plan only. Usage guards and a watchdog keep it there.
- **Studio:**
  - Writing: visual editor (resize and wrap images, tidy formatting), Write with AI, Find screenshots (Steam, then RAWG), live preview.
  - Review: History, review workflow (submit → approve / request changes → publish or schedule).
  - Team: roles, invites, bylines, "View as".
  - Site & limits (usage, modes, caps, Discord alerts, integrations).
- **Privacy:** a draft is private to its author until submitted. Editors see submitted and published work; contributors see only their own.
- **Onboarding:** a welcome tour and an editor spotlight tour for new members only, plus a 30-day "Getting started" checklist.
- **Notifications:** email to the chief when something is submitted; Discord alerts for builds, usage, errors, reviews, publishes, comments, team and security.
- **Site:** Chakra Petch headings, blue score badges (9.0 style), wrapped-image article layout (all old reviews converted), gallery, share card, comments with Google sign-in, AI summary, "Ask this review", chat, recommender and comparator.

## 4. Open items

- **Adsterra:** new ad codes still to come from you.
- **First real studio publish:** when you have new content.
- **Kept as backups on purpose (don't delete unless you say so):** the old Pages projects `playtested` / `playtested-old` in the personal account, the old playtested-dev resources there, and the `scheduled-publish.yml` / `update-rag.yml` workflows.
- **Ideas not started:** build-time thumbnail resizing (cards ship full-size images), and the kasama.loan usage/admin work (a prompt was written for that repo's session).
