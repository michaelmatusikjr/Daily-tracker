# Daily Tracker push server

An optional, free server that sends Daily Tracker reminders as **Web Push notifications**, so they arrive even when the app is closed. It runs on **Cloudflare Workers** (free plan) with a **D1** database (free plan).

You don't need this to use Daily Tracker. Without it, reminders still work while the app is open or was recently used.

## How it works

- When you turn on **Settings › Reminders › Remind me even when the app is closed**, the app asks your browser for a push subscription and registers it with this server. The server returns a random device id and a secret token. Only a SHA-256 hash of the token is stored.
- The app sends **reminder rules**: one per task or habit reminder, with the local time, the repeat pattern (daily, weekdays, weekly, monthly, every N days), the dates to skip, and your time zone. It sends them again whenever something changes.
- Every minute a cron trigger finds the reminders that are due, encrypts each one for your device (RFC 8291, aes128gcm), signs the request with your VAPID key (RFC 8292), and sends it through your browser's push service (Google, Mozilla, Apple…).
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

Links contain only random ids and a date, for example `./#open/task/<profileId>/<taskId>/2026-11-20`. There are no names in them.

## Deploy (about 15 minutes)

You need a computer with a terminal. These steps also work from a phone with a cloud terminal such as GitHub Codespaces.

1. **Create a free Cloudflare account** at <https://dash.cloudflare.com/sign-up>.
2. **Install Node.js 20 or newer** from <https://nodejs.org> (the "LTS" button).
3. In a terminal, go to this folder and install the tools:
   ```sh
   cd server
   npm install
   ```
4. **Log in to Cloudflare.** This opens your browser:
   ```sh
   npx wrangler login
   ```
5. **Make your VAPID keys.** These identify your server to the push services:
   ```sh
   npm run gen-vapid
   ```
   It prints a public key and a private key. Keep the terminal open.
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
8. **Store the private key as a secret.** It is never written to a file:
   ```sh
   npx wrangler secret put VAPID_PRIVATE_KEY
   ```
   Paste the private key from step 5 when asked.
9. **Deploy:**
   ```sh
   npx wrangler deploy
   ```
   It prints your Worker's URL, like `https://daily-tracker-push.yourname.workers.dev`. Open `<that URL>/api/health` to check: it should say `"ok":true`.
10. **In the app**, open **Settings › Reminders › Advanced: push server**. Paste the Worker URL and the public key, then tap **Save**. Turn on **Remind me even when the app is closed**.

   You can also put both values into `js/pushConfig.js` before publishing the app, so every device gets them.

**iPhone and iPad:** web push needs iOS/iPadOS **16.4 or later**, and Daily Tracker must be added to the Home Screen (Share › Add to Home Screen). Open it from there.

### Deploying with an API token (no browser login)

Someone helping you, or a CI job, can deploy with a token instead of `wrangler login`. Create one at **Cloudflare dashboard › My Profile › API Tokens › Create Token › Custom token** with these permissions:

- Account › **Workers Scripts** › Edit
- Account › **D1** › Edit
- Account › **Account Settings** › Read
- User › **User Details** › Read (lets wrangler show who is logged in)
- Zone access isn't needed: the Worker uses its free `workers.dev` address.

Then run the same commands with the token and your account id in the environment:

```sh
export CLOUDFLARE_API_TOKEN=...      # never commit this
export CLOUDFLARE_ACCOUNT_ID=...     # dashboard › Workers & Pages › Account ID
npx wrangler d1 create daily-tracker-push
npm run db:init
echo "<private key>" | npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler deploy
```

## API

All endpoints take and return JSON. CORS is limited to `ALLOWED_ORIGINS`, and requests from any other origin are refused. Bodies are size-limited (8 KB, or 256 KB for schedules).

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `GET /api/health` | — | — | `{ok, time, vapid}` |
| `POST /api/register` | — | `{subscription}` (from `PushSubscription.toJSON()`) | `201 {deviceId, token}`. Rate limit: 10/hour per IP. |
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

## Develop and test

```sh
npm test         # crypto vs the web-push reference library, recurrence parity with the app, Worker + D1 in Miniflare
npm run dev      # local Worker; trigger the cron with: curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

`test/recur.test.mjs` loads the app's `js/logic.js` and checks that the server's recurrence rules give the same answers. Keep the two in step when changing repeat rules.

**Real delivery can't be tested here.** The tests check the encryption byte-for-byte against the reference implementation and run the whole flow against a fake push service. Actual delivery through Google, Mozilla or Apple push services only happens after you deploy.
