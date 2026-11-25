# Daily Tracker push server

An optional, free server that sends Daily Tracker reminders as **Web Push notifications**, so they arrive even when the app is closed. It runs on **Cloudflare Workers** (free plan) with a **D1** database (free plan).

You don't need this to use Daily Tracker. Without it, reminders still work while the app is open or was recently used.

## How it works

- When you turn on **Settings › Reminders › Remind me even when the app is closed**, the app asks your browser for a push subscription and registers it with this server. The server returns a random device id and a secret token. Only a SHA-256 hash of the token is stored.
- The app sends **reminder rules**: one per task or habit reminder, with the local time, the repeat pattern (daily, weekdays, weekly, monthly, every N days), the dates to skip, and your time zone. It sends them again whenever something changes.
- Every minute a cron trigger finds the reminders that are due (at most 10 per device and 200 in all per run, taking turns between devices), encrypts each one for your device (RFC 8291, aes128gcm), signs the request with your VAPID key (RFC 8292), and sends it through your browser's push service (Google, Mozilla, Apple…).
- The rules repeat on the server, so reminders keep coming even if you don't open the app for weeks.
- A reminder the server couldn't send within 15 minutes of its time (for example during a Cloudflare outage) is skipped. It is never sent hours late.
- **Limits:** at most 500 rules per device, and the time zone must be a real IANA time zone.

### What is stored, and for how long

| Data | Kept until |
|---|---|
| Device id, token **hash**, push subscription (endpoint and keys), time zone | You turn the feature off, reset the app's data, or the push service reports the subscription is gone (404/410). Devices not seen for **180 days** are deleted. |
| Reminder rules: title, body, link, time, repeat pattern, skip dates | Replaced on every sync; deleted with the device. With **Hide reminder text** on, titles and bodies are generic and contain no task or habit names. |
| Sent markers (rule id + date), so nothing is sent twice | 3 days |
| Rate-limit counters (per IP or device, per hour) | About 2 hours |
| The timer's last run time and last error (for `/api/health`) | Overwritten every minute |

Links contain only random ids and a date, for example `./#open/task/<profileId>/<taskId>/2026-11-20`. There are no names in them.

## Deploy (about 15 minutes)

You need a computer with a terminal. These steps also work from a phone with a cloud terminal such as GitHub Codespaces. The app's error messages refer to the step numbers below.

1. **Create a free Cloudflare account** at <https://dash.cloudflare.com/sign-up>.
2. **Install Node.js 20 or newer** from <https://nodejs.org> (the "LTS" button).
3. **Install the tools.** In a terminal, go to this folder:
   ```sh
   cd server
   npm install
   ```
4. **Log in to Cloudflare.** This opens your browser:
   ```sh
   npx wrangler login
   ```
5. **Make your keys:**
   ```sh
   npm run setup-keys
   ```
   It prints three values. Keep the terminal open.
   - **VAPID public key:** not secret.
   - **VAPID private key:** secret.
   - **Register key:** secret.
6. **Create the database:**
   ```sh
   npx wrangler d1 create daily-tracker-push
   ```
   Copy the `database_id` it prints into `wrangler.toml` (replace `REPLACE_WITH_YOUR_DATABASE_ID`). Then create the tables:
   ```sh
   npm run db:init
   ```
7. **Edit `wrangler.toml` › `[vars]`:**
   - `VAPID_PUBLIC_KEY`: the public key from step 5.
   - `VAPID_SUBJECT`: `mailto:` followed by an address push services can contact. It can be any address you read.
   - `ALLOWED_ORIGINS`: the address where your app runs, with no path and no trailing slash, for example `https://yourname.github.io`. Separate several with commas.
   - `MAX_DEVICES`: how many devices may sign up. The default is 20 (60 in the deployed config); raise it if your family has more phones and computers.
8. **Deploy:**
   ```sh
   npx wrangler deploy
   ```
   It prints your Worker's URL, like `https://daily-tracker-push.yourname.workers.dev`.
   - **First time on Workers?** If it says you need a `workers.dev` subdomain, open the Cloudflare dashboard › **Workers & Pages**, pick a subdomain name when asked, then run `npx wrangler deploy` again.
9. **Store the two secrets.** They are never written to a file. Paste each value from step 5 when asked:
   ```sh
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put REGISTER_KEY
   ```
   Open `<your Worker URL>/api/health` to check. Once the timer has run (it runs every minute), it shows `"ok":true`. Any `false` value points to the step to redo:
   - `vapidPrivate`: step 9
   - `registerKey`: step 9
   - `db`: step 6
10. **In the app**, open **Settings › Reminders › Advanced: push server**. Paste the Worker URL, the VAPID public key and the register key, then tap **Save**. Turn on **Remind me even when the app is closed**. Do this on each device.

   You can also put the URL and public key (not the register key) into `js/pushConfig.js` before publishing the app.

**iPhone and iPad:** web push needs iOS/iPadOS **16.4 or later**, and Daily Tracker must be added to the Home Screen (Share › Add to Home Screen). Open it from there.

### What the register key protects

Your Worker's address is public. Without the register key, anyone who found it could sign up their own devices, use up your free quota and slow down your reminders.

With it, only devices where *you* typed the register key can sign up. Everything else is refused, and if the key isn't set, sign-ups are refused altogether ("Server not set up").

On top of that:
- `MAX_DEVICES` caps how many devices can exist.
- Each device gets at most 10 reminders sent per minute, in turn with the others, so a busy device can't hold up anyone else's.

The register key isn't needed after sign-up. Each device then uses its own token. If you think the key leaked, set a new one with `npx wrangler secret put REGISTER_KEY`; devices already signed up keep working.

The server only sends to real browser push services:
- `fcm.googleapis.com`
- `*.push.services.mozilla.com`
- `*.push.apple.com`
- `*.notify.windows.com`

It never sends to any other address, and each send gives up after 10 seconds.

### Deploying with an API token (no browser login)

Someone helping you, or a CI job, can deploy with a token instead of `wrangler login`:

1. In the Cloudflare dashboard, go to **My Profile › API Tokens › Create Token** and pick the **"Edit Cloudflare Workers"** template.
2. Add one more permission: **Account › D1 › Edit**.
3. Limit the token to your account, then create it.

Then run the same steps with the token and your account id in the environment:

```sh
export CLOUDFLARE_API_TOKEN=...      # never commit this
export CLOUDFLARE_ACCOUNT_ID=...     # dashboard › Workers & Pages › Account ID
npx wrangler d1 create daily-tracker-push   # then paste database_id into wrangler.toml
npm run db:init
npx wrangler deploy
npx wrangler secret put VAPID_PRIVATE_KEY   # paste when asked (or pipe it in)
npx wrangler secret put REGISTER_KEY
```

## API

All endpoints take and return JSON. CORS is limited to `ALLOWED_ORIGINS`, and requests from any other origin are refused. Bodies are size-limited (8 KB, or 256 KB for schedules).

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `GET /api/health` | — | — | `{ok, time, vapidPublic, vapidPublicKey, vapidPrivate, registerKey, db, lastCronAt, lastCronError}` |
| `POST /api/register` | `X-Register-Key: <REGISTER_KEY>`, **or** (no register key sent) a signed-in account session `Authorization: Bearer <session token>` | `{subscription}` (from `PushSubscription.toJSON()`) | `201 {deviceId, token}`. Possible errors: 401 for a bad session, 403 for a wrong key, 503 if the key isn't set or the device limit is reached, 400 if the endpoint isn't a known push service. Rate limit: 10/hour per IP. |
| `PUT /api/schedule` | `Authorization: Bearer <token>`, `X-Device: <deviceId>` | `{tz, rules:[…]}` | Replaces the device's rules. Rate limit: 120/hour. |
| `POST /api/subscription` | same | `{subscription}` | Updates a rotated subscription. Rate limit: 30/hour. |
| `DELETE /api/device` | same | — | Deletes the device and everything for it. |

A rule looks like this:

```json
{
  "id": "p:t:abc", "kind": "task", "title": "Gym", "body": "Starts at 6:00 PM",
  "url": "./#open/task/p/abc/{date}", "tag": "p:t:abc:{date}",
  "time": "17:50", "offsetDays": 0,
  "recur": { "type": "weekly", "start": "2026-11-02", "days": [1, 3] },
  "date": null, "exceptions": ["2026-11-25"], "skipDates": ["2026-11-16"], "until": null
}
```

- **`time`** is local time, already moved earlier by the reminder lead. When the lead crosses midnight, `offsetDays` is `-1`: fire on the day before the occurrence.
- **`recur.type`** is one of `none` (uses `date`), `daily`, `weekdays`, `weekly` (`days`: 0 = Sunday … 6), `monthly` (day of the start date, clamped to the month's end), or `interval` (every `interval` days from `start`).
- **`{date}`** in `url` and `tag` is replaced with the occurrence's date when sending.
- **Time zones** are converted with `Intl` only.
  - A time that doesn't exist (clocks spring forward) fires at the next valid minute.
  - A time that happens twice (clocks fall back) fires once, at the first one.

## Accounts and sync

The same Worker also holds **sync accounts** (`/api/account/*`, `/api/passkey/*`, `/api/sync/*`, `/api/files/*`). The full contract is in [`../SYNC.md`](../SYNC.md). In short:

- Everything is **end-to-end encrypted** on the devices. The server stores ciphertext records (an opaque id, an edit time, a device id and an encrypted blob), wrapped keys it can't open, and a salted HMAC verifier of the key derived from the password. It never sees a password, a recovery key or the data.
- Creating an account needs the same **register key** as reminders (`X-Register-Key`), or a single-use **invite code** (`X-Invite-Code`, see below).
- **`MAX_ACCOUNTS`** (in `wrangler.toml` `[vars]`, default 10; 25 in the deployed config) caps how many accounts can be created.
- **Task photos** (sync phase 2) are stored as encrypted files: an opaque file id (an HMAC the app derives), and one AES-GCM ciphertext split into chunks of at most 512 KiB of base64url text (a D1 value is limited to about 2 MB). An upload is all-or-nothing: its chunks only become a file when every one is there and the upload is committed. Files count toward the account's **200 MB** (shared with records; 413 beyond); at most 16 MiB of text per file and 8 uploads in progress per account. The server never decides that a photo is unused – only an app that has downloaded everything deletes one, after a 7-day delay (see SYNC.md).
- New tables: `accounts`, `sessions`, `passkeys`, `records`, `challenges`, and (photos) `files`, `file_uploads`, `file_chunks`. **After updating, run `npm run db:init` once more** (it only adds missing tables and indexes; existing data is untouched), then `npx wrangler deploy`.
- **Invite codes** (backlog #35, table `invites`): the owner makes one per friend, so the register key is never shared. A code looks like `7K3Q-X9PM` (8 symbols from a 32-symbol alphabet without 0/O/1/I: 40 bits), is single-use and expires after 30 days. The server stores only `HMAC-SHA-256(REGISTER_KEY, "invite:" + code)`; the code itself is shown once, when it is made (changing the register key voids open codes). At most 50 open codes at once.

  | Method & path | Auth | Body | Result |
  |---|---|---|---|
  | `POST /api/invites` | `X-Register-Key` | `{name?}` (up to 40 characters) | `201 {id, code, name, createdAt, expiresAt, status}` |
  | `GET /api/invites` | `X-Register-Key` | — | `{invites:[{id, name, createdAt, expiresAt, usedAt, username, status}]}`, newest first. `status` is `unused`, `used`, `expired` or `revoked`. |
  | `DELETE /api/invites/<id>` | `X-Register-Key` | — | Revokes an unused code. 409 if it was already used, 404 if unknown. |
  | `POST /api/invites/check` | none | `{code}` | `{valid: true\|false}` only (nothing else is revealed). 20 calls/hour per IP. |
  | `POST /api/account/create` | `X-Invite-Code: <code>` instead of `X-Register-Key` | as in SYNC.md | The code is spent in the same atomic D1 batch that inserts the account and its session (a conditional `UPDATE … WHERE used_at IS NULL AND revoked = 0 AND expires_at > now`), so two simultaneous uses give one account, and a failed creation never leaves a spent code. One 403 "Invalid or expired invite code" covers unknown, used, revoked and expired. |

  Owner calls are rate limited per IP (120/hour; 10 wrong keys/hour). Revoked codes and codes expired for 90 days are removed by the daily purge; used codes stay as the record of who joined.
- **Upgrading an existing database (release 1.17.0), in this order:** (1) `npm run db:init` (adds the `invites` table); (2) `npm run db:migrate:0002` once (adds `devices.account_id` and `accounts.invited`; it is not repeatable and fresh installs must skip it, they get the columns from `schema.sql`); (3) `npx wrangler deploy`; (4) only then publish the app (fast-forward `main`). The Worker needs both columns: deploying it first makes account creation, login and device sign-up fail with a 500.
- **Per-account device cap:** a device added through an account session (no register key) counts against that account, at most 5 (409 beyond that); devices added with the register key (the owner) are not capped per account. Deleting an account deletes its devices. Account responses (create, login, passkey login, recovery, `GET /api/account`) include `invited` (true when the account was made with an invite code).
- Sessions unused for 400 days, expired passkey challenges and photo uploads abandoned for a day are removed by the daily purge. Deleting an account removes all of its records, photos, passkeys and sessions.

## Develop and test

```sh
npm test         # crypto vs the web-push reference library, recurrence parity with the app, Worker + D1 in Miniflare (push, accounts/sync, photo files)
npm run dev      # local Worker; trigger the cron with: curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

`test/recur.test.mjs` loads the app's `js/logic.js` and checks that the server's recurrence rules give the same answers. Keep the two in step when changing repeat rules.

**Real delivery can't be tested here.** The tests check the encryption byte-for-byte against the reference implementation and run the whole flow against a fake push service. Actual delivery through Google, Mozilla or Apple push services only happens after you deploy.
