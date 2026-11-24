# Daily Tracker – project guide for Claude sessions

Read this first; read `BACKLOG.md` for what to build next and the user's recorded decisions. Keep sessions lean: don't re-derive what's written here.

## What it is
An offline-first **PWA** (plain HTML/CSS/vanilla JS ES modules, no build step) for daily tasks, habits, workouts, journal, with multiple profiles. Live at **https://michaelmatusikjr.github.io/daily-tracker/** (GitHub Pages serves the `main` branch; repo `michaelmatusikjr/Daily-tracker`). The user installs it to the iPhone Home Screen and tests there.

## Layout
- `index.html`, `css/styles.css`, `manifest.webmanifest`, `icons/`
- `sw.js` – service worker: versioned precache (`VERSION`), push + notificationclick handlers. **Every new app file must be added to its precache list.**
- `js/store.js` – state, schema (`SCHEMA_VERSION`, migrations), `APP_VERSION`, profiles index (`dailyTracker:profiles`, `dailyTracker:data:<id>`), import/export validation. `js/profiles.js` profile UI.
- `js/logic.js` – recurrence, streaks, weekly-habit rules, `dayProgress`. `js/dates.js` – local-date helpers and formatters (short month names everywhere).
- `js/actions.js` – all mutations (with Undo). `js/forms.js` task/habit forms. `js/taskView.js` View-task sheet. `js/itemMenu.js` long-press menus. `js/ui.js` sheets/toasts/gestures.
- `js/workouts.js` + `js/workoutForm.js` – workouts and records (1RM, 3×5 rules, bodyweight periods, cardio standard distances). `js/attachments.js` – task photos in IndexedDB (`dailyTracker-files`). `js/habitIcon.js` – habit image/Genmoji icons.
- `js/push.js` + `js/pushConfig.js` + `js/reminders.js` + `js/notify.js` – reminders: local timers, plus closed-app Web Push via the server.
- `js/sync.js` + `js/syncCrypto.js` + `js/account.js` – accounts and end-to-end encrypted sync (phase 1, see `SYNC.md`): records, shadows/keys in IndexedDB `dailyTracker-sync`, state in `dailyTracker:sync`, Settings › Account UI. Tests: `tests/t39.js`–`t41.js` (real Worker in Miniflare, app on `http://localhost:8080` for passkeys).
- `js/views/*.js` – today, habits, habitDetail, workouts, calendar, stats, completed, settings, widgets.
- `server/` – Cloudflare Worker + D1 push server (rules-based recurrence in `src/recur.js`, mirrored from `js/logic.js`; VAPID/aes128gcm in `src/webpush.js`). Has its own `README.md` and `npm test`.
- `tests/` – Playwright browser suites + `run-all.sh`. `BACKLOG.md` – roadmap and decisions.

## Rules that must hold
- Use local date keys (`YYYY-MM-DD`), never `toISOString().slice`. Escape all user text (build DOM with `h()`/text nodes; no innerHTML with user data).
- Never lose user data: schema changes need a migration; imports are validated; destructive actions get Undo; profiles stay isolated.
- When releasing: bump **both** `VERSION` in `sw.js` and `APP_VERSION` in `js/store.js` to the same number.
- Never commit secrets. `js/pushConfig.js` holds only the server URL + public VAPID key. The register key is a secret (user enters it in Settings › Reminders › Advanced; the user has it).
- User preferences: short month names everywhere; notes about reminders appear only when reminders *won't* arrive with the app closed; ask before adding anything to a calendar or sending email.

## Testing
- `tests/run-all.sh` runs every suite (servers on 127.0.0.1:8080 root and :8081 sub-path are started automatically). `tests/run-all.sh t21 t25` runs specific ones. Chromium + `require('playwright')` are preinstalled in cloud sessions; don't reinstall.
- t17 (push client) needs `cd server && npm ci` first. Server tests: `cd server && npm test`.
- Known flake: t12's "storage event → sheet appears" occasionally timed out under full-suite load; likely caused by http.servers left running by older `run-all.sh` versions (fixed: the servers are now direct children the trap kills). If it recurs, check `ss -ltnp | grep 808` / `pgrep -af http.server`, kill leftovers, re-run it alone.
- Add a new `tests/tNN.js` for each feature; update expectations in older suites when behaviour changes on purpose.

## Release workflow (tiered – keep it token-efficient)
1. Work on a feature branch; batch backlog items into one release.
2. **Model choice:** spin up an agent for each task using the *cheapest* model that can do it (`haiku` first, e.g. searches, simple edits, test runs); step up to `sonnet` and only then `opus` when the task genuinely needs it (complex logic, data safety, QA review). State the reason when using a more expensive model.
3. **Build:** for anything beyond a small fix, use one *fresh* builder subagent on the cheapest model that can handle it (see step 2) with a self-contained spec. Don't resume long-lived agents across releases. Small fixes: do them directly.
4. **Test:** run the relevant suites; full `tests/run-all.sh` before release.
5. **QA gate (risk-based):**
   - Data safety, storage/import/export, sync, reminders/push, security, server changes → one *fresh* QA subagent reviewing a `git archive` copy (adversarial, verdict + ranked findings).
   - Cosmetic/wording/layout → no QA agent; relevant suites + a screenshot check.
6. **Release:** fast-forward `main` to the tested commit (`git push origin <commit>:main`). Only QA-approved/tested commits go to `main` because Pages serves it live.
7. Mark items Done in `BACKLOG.md` with the version. Tell the user briefly what changed and to tap **Reload** in the app.

## Push server (deployed)
- Worker: `https://daily-tracker-push.michael-matusik-jr.workers.dev`, D1 `daily-tracker-push`, cron every minute. Config in `server/wrangler.toml` (no secrets). Secrets `VAPID_PRIVATE_KEY`, `REGISTER_KEY` live only in Cloudflare.
- Deploy from a cloud session: the Cloudflare API token is saved as a network secret for `api.cloudflare.com` in the user's Default environment. Run wrangler with `CLOUDFLARE_API_TOKEN=proxy-injected` (the proxy injects the real token) and `CLOUDFLARE_ACCOUNT_ID` from `GET /client/v4/accounts`. `workers.dev` is not reachable from the sandbox; check health via D1 (`SELECT * FROM meta` → `lastCronAt`).
- Never change server secrets or delete user devices without the user's OK.
