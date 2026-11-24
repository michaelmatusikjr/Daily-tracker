# Accounts and sync – phase 1 design (backlog #2)

This is the contract between the app (`js/sync*.js`, `js/account*.js`) and the Worker (`server/src/account.js`, `server/src/sync.js`, `server/src/webauthn.js`). Both sides must follow it exactly. Decisions behind it are in `BACKLOG.md` #2.

## Scope of phase 1
- One **household account**, which holds any number of profiles.
- Sign-in: **username + password**, and **passkeys** (Face ID / Touch ID). Account creation needs the server's **register key** (the same one used for reminders, Settings › Reminders › Advanced), so strangers can't fill the free quota.
- **End-to-end encryption**: the server only stores ciphertext plus the minimum metadata needed to route it.
- One-time **recovery key**, shown once at sign-up.
- Syncs each synced profile's data: tasks, habits, logs, journal, categories, exercises, workouts, autoHabit, settings (except device-only keys), and the profile's name/avatar/order.
- **Not in phase 1:** task photos (phase 2). A synced task whose photo isn't on this device shows a placeholder "Photo on another device" (never an error, never a lost reference). Habit image icons are small (≤ 60 KB data URLs stored inside the habit), so they travel inside the habit record already (see "Client details as built"); an icon that can't be shown still falls back to the emoji (or the first letter).

## Rules from the user
- **Conflicts:** latest edit wins, per record (see Records).
- **First sign-in / sign-up on a device:** ask which of this device's profiles to sync (pick one or more, or none). All profiles already in the account are downloaded to the device.
- **Device-only profiles** stay on the device untouched. Each one shows a persistent "On this device only" indicator – **also before anyone has signed in** – until it is synced: a small badge on the header avatar when the active profile is device-only, and a label in the profile menu row. Tapping the label opens the Account sheet.
- **Adding a profile while signed in:** the form asks where to save it: "This device only" or "Account" (default: Account).
- **Names are unique in an account** (case-insensitive, trimmed). Syncing a device profile whose name matches an account profile: the app asks the user to rename the device profile first (inline rename field in the same flow). Renaming a synced profile to a name another account profile uses is refused with a clear message.
- **Sign out:** asks "Keep copies on this device" (default; the account's profiles stay on the device as device-only profiles and simply stop syncing; their shadows and the outbox are cleared) or "Remove from this device". Never deletes account data. "Remove" first syncs; if anything is still not in the account (pending edits or profile deletions, items too large to sync, an unreadable synced profile, or the session expired / keys locked) it is refused with the reason and "Keep copies" is offered instead. Its confirm says everything was uploaded, and that task photos (not synced in phase 1) are deleted with the profiles.
- **Deleting a synced profile** (existing two-step confirm) deletes it from the account and every signed-in device; the confirm text must say so.
- **Delete account** (Settings › Account, needs the password, two-step confirm): wipes the server data; local copies stay as device-only profiles.

## Crypto (client side, WebCrypto only)
- `uname` = username trimmed, lower-cased; 3–40 chars of `[a-z0-9._-]`.
- `salt` = SHA-256(`"daily-tracker/v1/" + uname`) (deterministic, so no salt lookup endpoint can leak which usernames exist).
- `pwBits` = PBKDF2-SHA-256(password, salt, **600 000** iterations, 512 bits). Split: `authKey` = first 32 bytes, `kek` = last 32 bytes.
- `authKey` (base64url) is what is sent to the server instead of the password. The password never leaves the device.
- `dataKey` = random 32 bytes, created at sign-up. Wrapped with AES-256-GCM: `wrapped = b64url(iv12 || ciphertext)`.
  - `wrappedPw` = wrap(`kek`, dataKey).
  - Recovery key: random 32 bytes, shown as 52 base32 chars (RFC 4648, no padding) in groups of 4. `recBits` = HKDF-SHA-256(recoveryKey, salt, info `"daily-tracker/v1/recovery"`, 512 bits) → `recAuth` (first 32) and `recKek` (last 32). `wrappedRec` = wrap(`recKek`, dataKey).
  - Passkey PRF (when the authenticator returns `prf.results.first`; eval input `first` = UTF-8 `"daily-tracker/v1/prf"`): `prfKek` = HKDF-SHA-256(prfOutput, salt, info `"daily-tracker/v1/prf-kek"`, 256 bits); `wrappedPrf` = wrap(`prfKek`, dataKey).
- From `dataKey` via HKDF-SHA-256 (salt empty, distinct infos): `encKey` (AES-256-GCM, info `"daily-tracker/v1/enc"`) and `macKey` (HMAC-SHA-256, info `"daily-tracker/v1/rid"`).
- On the device, `dataKey` is kept as raw bytes only long enough to derive `encKey`/`macKey`, which are stored **non-extractable** in IndexedDB `dailyTracker-sync` (store `keys`). Also store `wrappedPw`-free state; never store the password, `authKey`, `kek` or the recovery key.

## Records
A synced profile is flattened into records. Record keys (`k`), `<pid>` = profile id:
| k | value |
|---|---|
| `<pid>/meta` | `{ name, avatar, order }` (order = position in the profile list) |
| `<pid>/task/<id>` | the task object |
| `<pid>/habit/<id>` | the habit object (including an `image` icon's data URL, ≤ 60 KB) |
| `<pid>/cat/<id>` | category `{ id, name, color, order }` (order = index) |
| `<pid>/ex/<id>` | exercise |
| `<pid>/wo/<id>` | workout |
| `<pid>/log/<habitId>/<date>` | number |
| `<pid>/auto/<habitId>/<date>` | `true` |
| `<pid>/journal/<date>` | journal entry |
| `<pid>/set/<key>` | one top-level settings key (skip device-only keys: `notifications` and `onboarded`, `DEVICE_ONLY_SETTINGS` in `js/sync.js`) |

- Each record: `{ k, v, t, dev, sv }`: `v` = value, or `null` for a deletion (tombstone); `t` = edit time (ms, see Clock); `dev` = device id (random 16 bytes b64url, per device); `sv` = `SCHEMA_VERSION` of the writer.
- **Latest edit wins:** a record replaces another when `(t, dev)` is greater (compare `t`, then `dev` as a string).
- `rid` = b64url(HMAC-SHA-256(macKey, k)) – opaque to the server, stable for a key.
- `blob` = b64url(iv12 || AES-256-GCM(encKey, JSON.stringify({k, v, t, dev, sv}), additionalData = UTF-8 rid)).
- Applying a remote record: validate/normalize the value through the same normalizers imports use (`normTask`, `normHabit`, …, exported from `store.js` for this) – a record that fails validation is skipped and logged, never applied. A record with `sv > SCHEMA_VERSION` pauses sync and shows "Update the app to keep syncing" (Reload button).
- A remote `<pid>/meta` tombstone deletes that profile on this device (with its photos, like deleteProfile). A profile **missing** locally is never treated as deleted – only explicit tombstones delete.

## Clock
- Server returns `now` (ms) in every sync response; the client keeps `offset = serverNow - Date.now()` (smoothed). Edit times are `t = min(max(now, previous t of that record + 1), now + 1 min)` with `now = Date.now() + offset` – never more than a minute ahead (if the previous t is beyond that, the edit gets now + 1 min and loses to later edits). When a push is refused with 400 naming `records[i]`, that record gets a new time (now) and the push is retried once; refused again, the record is set aside (pending = 2) so it never blocks the rest.

## Change tracking (client)
- Per synced profile a **shadow** in IndexedDB `dailyTracker-sync` (store `shadow`, key = pid): `{ [k]: [hash, t, dev, pending] }` (hash = the existing `hashStr` of the canonical JSON of `v`, `null` for a tombstone). It lives in IndexedDB, not localStorage, so a big profile's bookkeeping never eats the ~5 MB localStorage that holds the data itself (storage full there would block saving user data).
- After each save that affects a synced profile (debounced ~1.5 s, plus on `visibilitychange` (shown and hidden), `online`, app start, and every 60 s while visible), flatten the profile, diff with its shadow: new/changed → new record with fresh `t`; key in shadow but no longer present → tombstone. The **outbox** is the shadow's `pending` flag (1 = to upload, 0 = uploaded, 2 = too large to upload): it is persisted with the shadow, survives reloads/offline, and is cleared per record when a push returns (accepted or stale). The diff runs **before any network call**, so an edit made offline gets (about) its edit time, not the time the device came back online; it runs again right before remote records are applied.
- An unreadable profile (`readProfileState` → null / load failure) is skipped – never produces tombstones.
- Pull before push on each cycle. Remote record newer than the shadow entry → apply into the profile (active profile through a new store helper that saves + emits `{ remote: true }`; others through `mutateProfileData`), update shadow. Remote record older → ignore (our outbox copy will win on push).
- Only one tab syncs at a time (`navigator.locks.request('dailyTracker-sync', …)`, fall back to a localStorage lease). Other tabs pick up changes through the existing storage events.
- Remote changes must not break an open Undo: an Undo after a remote change applies to the current state (re-find items by id), never restores a whole old state snapshot over newer remote data. Audit `actions.js` Undo closures for whole-state snapshots.
- Reminders: after remote changes are applied, the existing reminder/push reschedule path runs (the store emit already triggers it – verify).

## Import / export while signed in
- Export is unchanged (local data).
- Import confirm adds: "Profiles in your account stay in the account." An import never replaces account data: imported profiles whose id matches a synced profile are added as device-only copies under a new id (the confirm lists them by name and says so; their photos go to the copy). Synced profiles are neither changed nor removed from the device: a multi-profile import keeps them next to the imported ones. Other imported profiles are device-only.

## Server API (Worker, JSON, CORS as today)
All `/api/account/*`, `/api/sync/*`, `/api/passkey/*` responses include `now`. Errors: `{ error }` with 400/401/403/404/409/413/429.
Session auth: `Authorization: Bearer <session token>` (32 random bytes b64url; server stores SHA-256 only). Sessions last 400 days, `last_seen` updated at most hourly.

| Method path | Body → response |
|---|---|
| `POST /api/account/create` (header `X-Register-Key`) | `{ username, authKey, wrappedPw, wrappedRec, recAuth, deviceName }` → `{ accountId, token }`. 409 if the username is taken. |
| `POST /api/account/login` | `{ username, authKey, deviceName }` → `{ accountId, token, wrappedPw }`. Unknown user and wrong key give the same 401 "Wrong username or password". |
| `POST /api/account/recover` | `{ username, recAuth, newAuthKey, newWrappedPw, deviceName }` – but the client needs `wrappedRec` first, so this is two steps: `POST /api/account/recover/start { username, recAuth }` → `{ wrappedRec }` (401 if wrong); then `POST /api/account/recover/finish { username, recAuth, newAuthKey, newWrappedPw, deviceName }` → `{ accountId, token }`; finishing ends every other session. |
| `POST /api/account/password` (auth) | `{ authKey, newAuthKey, newWrappedPw }` → `{ ok }`; ends every other session (this one stays) |
| `POST /api/account/logout` (auth) | → `{ ok }` (ends this session) |
| `DELETE /api/account` (auth) | `{ authKey }` → `{ ok }`: deletes account, sessions, passkeys, records |
| `GET /api/account` (auth) | → `{ accountId, username, passkeys: [{ id, name, createdAt, prf }], sessions: [{ id, deviceName, lastSeen, current }] }` |
| `DELETE /api/account/session/<id>` (auth) | sign another device out |
| `GET /api/sync/pull?since=<seq>&limit=<n≤1000>` (auth) | → `{ records: [{ rid, seq, t, dev, blob }], seq, more }` ordered by seq |
| `POST /api/sync/push` (auth) | `{ records: [{ rid, t, dev, blob }] }` (≤ 500, blob ≤ 256 KB b64, body ≤ 4 MB) → `{ seq, accepted: n, stale: [rid…] }`. Server upserts each record only if `(t, dev)` is greater than the stored one; every accepted write gets the account's next `seq`. |
| `POST /api/passkey/register/options` (auth) | → `{ challengeId, options }` (PublicKeyCredentialCreationOptions JSON: rp `{ id: <origin hostname>, name: "Daily Tracker" }`, user id = account id bytes, `residentKey: required`, `userVerification: required`, alg -7 and -257, `attestation: none`, excludeCredentials) |
| `POST /api/passkey/register` (auth) | `{ challengeId, credential (JSON-serialised, b64url fields), name, wrappedPrf? }` → `{ ok, id }` |
| `POST /api/passkey/login/options` | → `{ challengeId, options }` (empty allowCredentials, `userVerification: required`) |
| `POST /api/passkey/login` | `{ challengeId, credential, deviceName }` → `{ accountId, username, token, wrappedPrf? }` |
| `POST /api/passkey/prf` (auth) | `{ id, wrappedPrf }` – attach a PRF wrap to an existing passkey |
| `DELETE /api/passkey/<id>` (auth) | remove a passkey |

Server-side rules:
- Stored password verifier: `HMAC-SHA-256(key = random 16-byte per-account salt, message = authKey)`, compared in constant time. Same for `recAuth` (its own salt); an unknown username does the same work against a dummy salt. `authKey` and `recAuth` are already 256-bit outputs of the client's PBKDF2 (600 000 iterations) / HKDF, so a fast keyed hash is enough on the server (a server-side PBKDF2 would not fit the Workers free plan's 10 ms CPU limit).
- Rate limits (existing `rate` table): login/recover failures 10/hour per username and 30/hour per IP; create 5/hour per IP; passkey login 30/hour per IP; push 600/hour and pull 1200/hour per account.
- Limits: 200 000 records and 200 MB of blobs per account (413 beyond); `MAX_ACCOUNTS` var (default 10).
- Challenges: single-use, 5-minute expiry, bound to their purpose (and account for registration).
- WebAuthn verification: `clientDataJSON.type`, `challenge`, `origin` ∈ ALLOWED_ORIGINS; `rpIdHash` = SHA-256(origin hostname); UP and UV flags set; signature over `authData || SHA-256(clientDataJSON)` with the stored COSE key (ES256: convert DER → raw r||s; RS256: RSASSA-PKCS1-v1_5 SHA-256); sign count: reject a non-zero count that doesn't increase. Minimal CBOR decoder for the attestation object and COSE key. No attestation verification (`none`).
- Never log tokens, authKeys, blobs.
- New D1 tables go in `schema.sql` (`CREATE TABLE IF NOT EXISTS`, safe to re-run on the live DB) – no change to existing tables. Purge expired challenges in the cron's purge.

### Server details as built (server 1.7.0; these are part of the contract)
- **Formats** (strict, 400 otherwise): `authKey`, `recAuth`, `newAuthKey` = 32 bytes b64url (43 chars, no padding); `wrappedPw`, `wrappedRec`, `newWrappedPw`, `wrappedPrf` = exactly 60 bytes (iv 12 + ciphertext 32 + tag 16; 80 chars); `rid` 32 bytes (43 chars); `dev` 16 bytes (22 chars); `blob` b64url, 38–262 144 chars; `t` integer ms in `[0, now + 1 day]`; `deviceName` / passkey `name` 1–60 chars after trimming, no control characters. The server trims and lower-cases `username` itself.
- **Responses** (every one, errors included, carries `now`):
  - create → `201 { accountId, username, token, sessionId }`; wrong/missing register key 403 "Wrong register key"; cap reached 503 "Account limit reached"; taken 409 "Username is taken".
  - login → `{ accountId, username, token, sessionId, wrappedPw }`; 401 "Wrong username or password".
  - recover/start → `{ wrappedRec }`; recover/finish → `{ accountId, username, token, sessionId }`; 401 "Wrong username or recovery key".
  - passkey/login → `{ accountId, username, token, sessionId, wrappedPw, wrappedPrf }` (`wrappedPrf` null when none). **`wrappedPw` is included** so a passkey sign-in without PRF can unlock with the password without another call (for the recovery key, call recover/start).
  - Too many attempts → 429 "Too many attempts, try again later" (failure limits) or "Too many requests, try again later".
  - A wrong current password on a signed-in call (`/api/account/password`, `DELETE /api/account`) is **403 "Wrong password"**, not 401: 401 ("Not signed in") always means the session is gone, so the client should treat it as signed out.
  - `GET /api/account` → `{ accountId, username, records, bytes, passkeys: [{ id, name, createdAt, lastUsed, prf }], sessions: [{ id, deviceName, createdAt, lastSeen, current }] }`.
  - `DELETE /api/account/session/<id>` → `{ ok, current }`; 404 "Session not found". `POST /api/passkey/prf` and `DELETE /api/passkey/<id>` → `{ ok }`, 404 "Passkey not found".
  - passkey/register → `200 { ok, id }`; 409 if already registered or at 20 passkeys.
- **Seq:** strictly increasing per account but **not contiguous** (a push reserves one number per record it sends). Use the pull's `seq` as the next `since`; the push's `seq` (account seq after the write) is not a pull cursor. Pull pages are also capped at 4 MB of blobs (always at least one record); keep pulling while `more`. `stale` lists rids the server kept because its copy's `(t, dev)` is greater **or equal**. A push is all-or-nothing (one D1 transaction); duplicate rids in one push keep the latest.
- **Limits:** a push that would add records or bytes beyond the account limits is refused whole with 413 "Account storage is full"; pushes that don't grow usage (e.g. smaller tombstones) still go through.
- **Rate limits:** the failure counters (10/h per username, 30/h per IP) are shared by login, recover start/finish, password change and account delete; once over, even the right key gets 429 for the rest of the hour. Successes don't count. Passkey login options and passkey login: 30/h per IP each. Register options + register: 30/h per account. Other signed-in account calls: 600/h per account.
- **WebAuthn:** rpId = hostname of the request `Origin` (which must be in ALLOWED_ORIGINS), and `clientDataJSON.origin` must **equal** the request Origin; `crossOrigin: true` is refused. `options.user.id` is the account id string (it is already the b64url of the 16 id bytes – decode it to bytes). The server doesn't add the PRF extension to the options: the client adds `extensions.prf.eval.first`. A `response.userHandle`, when sent, must equal the account id. Sign count: if the new or stored count is non-zero, the new one must be greater (authenticators that always report 0 are fine). Both login and register answer 400 "Wrong or expired challenge" for a missing, used, expired, wrong-purpose or other-account challenge; other passkey sign-in failures are 401 with a short reason. IP addresses can't be rpIds in browsers: local tests must use `http://localhost:…`, not `127.0.0.1`.

## Client flows (Settings › Account, a new section at the top of Settings)
- Signed out: "Create account" and "Sign in" (password), "Sign in with passkey", "Forgot password? Use recovery key".
- Create: username, password (≥ 10 chars, confirm), register key (prefilled from the reminders config if set) → shows the **recovery key** with Copy and "I've saved it" (required checkbox) → profile picker → offer "Add a passkey".
- Sign in on a device: → downloads account profiles (progress) → profile picker for this device's profiles (rename step for name clashes).
- Passkey sign-in without PRF on a device that has no key yet → ask for the password (or recovery key) once to unlock.
- Signed in: username, sync status ("Synced just now" / "Offline – changes will sync" / error), each profile with "Synced" or "On this device only" + "Sync to account", passkeys (add/remove), signed-in devices (sign out other), change password, sign out, delete account.
- All text uses short month names. Only show warnings when something won't sync.

### Client details as built (app; part of the contract)
- **Files:** `js/syncCrypto.js` (crypto + IndexedDB), `js/sync.js` (state, API client, records, cycles), `js/account.js` (Settings › Account UI).
- **State:** localStorage `dailyTracker:sync` (shared by tabs): `dev`, `accountId`, `username`, `token`, `sessionId`, `serverUrl` (the reminders server, `pushConfig().serverUrl`), `synced` (pids), `cursor`, `full`, `fresh`, `merge`, `waitReadable`, `deletes` (`{ pid: t }`, explicit profile deletions still to push), `offset`, `lastOk`, `error`, `paused`, `expired`, `locked`. Exports never include it.
- **Keys:** IndexedDB `dailyTracker-sync` › `keys` › `current` = `{ accountId, encKey, macKey (non-extractable), check, wrappedPw? }`. `check` = HMAC(macKey, "daily-tracker/v1/key-check"): before a password change or a PRF wrap, an unwrapped dataKey must give the same check, so a wrong key can never be wrapped into the account. `wrappedPw` is the same ciphertext the server holds (only usable with the password); it lets a password change / passkey PRF wrap work without an extra sign-in (if it's stale, the app signs in once to fetch the current one and ends that session). The raw dataKey is kept in memory only for 15 minutes after signing in (for "Add a passkey"); otherwise adding a passkey asks for the password.
- **Passkeys:** the app adds `extensions.prf.eval.first` to both create and get. If create returns no PRF output but `prf.enabled`, one extra get (allowCredentials = the new id) fetches it and `POST /api/passkey/prf` attaches the wrap. Credentials are serialised by hand (`id`, `rawId`, `type`, `response.*` as b64url); `clientExtensionResults` are **never** sent, because they contain the PRF output that unwraps `wrappedPrf`. A passkey sign-in without PRF output unlocks with the password (unwrap the returned `wrappedPw` locally, no extra call) or the recovery key (`recover/start`); when the authenticator gave PRF output, that unlock also attaches a PRF wrap to the passkey.
- **Applying:** all pages of a pull are fetched and decrypted first; a record is only applied when it decrypts, its inner `k` hashes to its `rid`, inner `t`/`dev` equal the outer ones, and its value passes the store normalizers (values from an older `sv` are migrated first). The profile is saved first (`applyRemoteProfile`); only when that worked are its shadow and the cursor moved on (storage full → nothing is lost, the same records are pulled again). The shadow after applying takes the remote `(t, dev)` for applied keys; values the normalizer changes or adds are recorded as known, never uploaded as edits.
- **New profiles from the account** (and synced profiles that went missing locally without an explicit delete, `fresh`) are created only from a **full** pull (`since = 0`), so no record is missing; a partial pull that meets a new profile triggers a full pull in the same cycle. They start from an empty base (no example categories), `onboarded = true`.
- **Kept copies:** "Keep copies" records the account id for each kept profile (`kept: { pid: accountId }` in the state, kept across sign-outs). Signing in to the **same** account again merges each kept copy back (the merge below: the account's records win, records only on this device are uploaded, photos stay, no duplicate).
- **Same id, different profile:** when the account has a profile whose id is also a device-only profile here that wasn't kept from this account (another account's copy, or the same backup imported on two devices), the device profile gets a new id before the pull is applied (data and backups move; its photos are **copied** to the new id, so the account's copy keeps them) and stays device-only; the account's copy is downloaded beside it. Deleting a profile's photos skips files another profile's tasks still refer to.
- **Adding device profiles needs a complete download:** `pulled` is set once a full pull of this account completed (a new account starts with it). Until then the profile picker isn't shown (sign-in shows the reason with Retry instead), "Sync to account" is hidden and `syncProfiles` refuses. The state keeps `known: { pid: name | null }` (every meta record the account has; null = deleted): name clashes also check account profiles that aren't on this device; syncing a device profile whose id the account already has merges it (account wins), never starts it from an empty shadow with fresh times; one whose id the account deleted gets a new id first.
- **Unreadable profiles:** never diffed, never written. When one becomes readable again (`waitReadable` → `merge`), its old shadow no longer describes what's on the device, so it is merged instead of diffed: empty shadow, full pull, the account's record wins where both have one, records only on this device are uploaded, nothing is tombstoned. "Start fresh" after a load failure on a synced profile uses the same merge (`merge`), so the account's copy is applied on top of whatever was added since and the empty start is never uploaded as deletions (`fresh` is only for synced profiles missing from the device, which are rebuilt from the account). A remote delete of an unreadable profile keeps its raw text as a backup key.
- **Sessions:** 401 → `expired` (token dropped; synced list, shadows and keys kept), "You were signed out…" in Account. Signing in again to the **same** account carries on where it stopped (pending edits upload); signing in to a different account first drops the old sync state (local data stays). An explicit sign-out (keep or remove) clears shadows, keys and the synced list. A password change (like a recovery) signs every other device out.
- **Profile deletions:** only an explicit delete (profile menu) pushes a `<pid>/meta` tombstone (`deletes`), with `t = max(now, the meta record's last known t + 1)` (the shadow is kept until the tombstone is uploaded); the profile's data records stay on the server as they are (they're never applied again: other devices delete the profile when they see the tombstone). A later meta edit on another device (`t` greater) brings the profile back there. "Reset <name>'s data" on a synced profile is an explicit edit: it tombstones the profile's records (its confirm says so).
- **Order:** `<pid>/meta.order` = position among the synced profiles (device-only ones keep their place).
- **Lock:** `navigator.locks` `dailyTracker-sync` (else a localStorage lease `dailyTracker:sync:lease`); each tab's cycle checks after every await that it is still the same session (sign-out sets `signingOut` and waits for the lock).
- **Known limitation:** with two tabs open, a save in tab 1 that lands in the milliseconds between tab 2 applying a remote change to tab 1's active profile and tab 1 receiving the storage event can overwrite that remote change locally; tab 2's next diff then uploads tab 1's value as a newer edit (no data is lost from the device, but that one remote edit is undone).

## Testing
- `server/test/account.test.mjs`: Miniflare end-to-end – create/login/recover/password/logout/delete, rate limits, LWW push/pull with seq, limits, CORS, and WebAuthn register/login with software ES256 and RS256 authenticators (including PRF wrap passthrough, replayed challenge, wrong origin, wrong rpIdHash, missing UV, bad signature, sign-count regression).
- `tests/t39.js`: two browser contexts against the real Worker in Miniflare (like t17): sign-up, recovery key shown, profile picker, sync of tasks/habits/logs/journal/settings both ways, offline edit then reconnect, latest-wins conflict, tombstones, profile rename clash, device-only badge before sign-in, sign out keep/remove, deleting a synced profile, import while signed in, unreadable profile never tombstones, newer `sv` pauses sync.
- `tests/t40.js`: regressions for the phase-1 QA findings – failed first download (no picker, Retry, kept copy merged not reverted), Remove refused with pending edits, Start fresh merges, same-id photos copied, future edit times, delete tombstone time, remote delete of an unreadable profile keeps its backup.
- Passkeys in the browser: Playwright CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`, ctap2, internal, resident key, UV) – test with and without PRF support.
