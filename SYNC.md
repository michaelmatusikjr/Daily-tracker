# Accounts and sync – phase 1 design (backlog #2)

This is the contract between the app (`js/sync*.js`, `js/account*.js`) and the Worker (`server/src/account.js`, `server/src/sync.js`, `server/src/webauthn.js`). Both sides must follow it exactly. Decisions behind it are in `BACKLOG.md` #2.

## Scope of phase 1
- One **household account**, which holds any number of profiles.
- Sign-in: **username + password**, and **passkeys** (Face ID / Touch ID). Account creation needs the server's **register key** (the same one used for reminders, Settings › Reminders › Advanced), so strangers can't fill the free quota.
- **End-to-end encryption**: the server only stores ciphertext plus the minimum metadata needed to route it.
- One-time **recovery key**, shown once at sign-up.
- Syncs each synced profile's data: tasks, habits, logs, journal, categories, exercises, workouts, autoHabit, settings (except device-only keys), and the profile's name/avatar/order.
- **Not in phase 1:** task photos and habit image icons (phase 2). A synced task whose photo isn't on this device shows a placeholder "Photo on another device" (never an error, never a lost reference). Habit image icons: a habit whose image icon isn't on this device shows its emoji (or the first letter) instead.

## Rules from the user
- **Conflicts:** latest edit wins, per record (see Records).
- **First sign-in / sign-up on a device:** ask which of this device's profiles to sync (pick one or more, or none). All profiles already in the account are downloaded to the device.
- **Device-only profiles** stay on the device untouched. Each one shows a persistent "On this device only" indicator – **also before anyone has signed in** – until it is synced: a small badge on the header avatar when the active profile is device-only, and a label in the profile menu row. Tapping the label opens the Account sheet.
- **Adding a profile while signed in:** the form asks where to save it: "This device only" or "Account" (default: Account).
- **Names are unique in an account** (case-insensitive, trimmed). Syncing a device profile whose name matches an account profile: the app asks the user to rename the device profile first (inline rename field in the same flow). Renaming a synced profile to a name another account profile uses is refused with a clear message.
- **Sign out:** asks "Keep copies on this device" (default; the account's profiles stay on the device as device-only profiles and simply stop syncing; their shadows and the outbox are cleared) or "Remove from this device". Never deletes account data.
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
| `<pid>/habit/<id>` | the habit object (an `image` icon is kept as a reference; data in phase 2) |
| `<pid>/cat/<id>` | category `{ id, name, color, order }` (order = index) |
| `<pid>/ex/<id>` | exercise |
| `<pid>/wo/<id>` | workout |
| `<pid>/log/<habitId>/<date>` | number |
| `<pid>/auto/<habitId>/<date>` | `true` |
| `<pid>/journal/<date>` | journal entry |
| `<pid>/set/<key>` | one top-level settings key (skip device-only keys: `notifications`, and anything the code marks device-only) |

- Each record: `{ k, v, t, dev, sv }`: `v` = value, or `null` for a deletion (tombstone); `t` = edit time (ms, see Clock); `dev` = device id (random 16 bytes b64url, per device); `sv` = `SCHEMA_VERSION` of the writer.
- **Latest edit wins:** a record replaces another when `(t, dev)` is greater (compare `t`, then `dev` as a string).
- `rid` = b64url(HMAC-SHA-256(macKey, k)) – opaque to the server, stable for a key.
- `blob` = b64url(iv12 || AES-256-GCM(encKey, JSON.stringify({k, v, t, dev, sv}), additionalData = UTF-8 rid)).
- Applying a remote record: validate/normalize the value through the same normalizers imports use (`normTask`, `normHabit`, …, exported from `store.js` for this) – a record that fails validation is skipped and logged, never applied. A record with `sv > SCHEMA_VERSION` pauses sync and shows "Update the app to keep syncing" (Reload button).
- A remote `<pid>/meta` tombstone deletes that profile on this device (with its photos, like deleteProfile). A profile **missing** locally is never treated as deleted – only explicit tombstones delete.

## Clock
- Server returns `now` (ms) in every sync response; the client keeps `offset = serverNow - Date.now()` (smoothed). Edit times are `t = max(Date.now() + offset, previous t of that record + 1)`.

## Change tracking (client)
- Per synced profile a **shadow** in localStorage `dailyTracker:sync:shadow:<pid>`: `{ [k]: [hash, t, dev] }` (hash = the existing `hashStr` of the canonical JSON of `v`).
- After each save that affects a synced profile (debounced ~1.5 s, plus on `visibilitychange`→visible, `online`, app start, and every 60 s while visible), flatten the profile, diff with its shadow: new/changed → new record with fresh `t`; key in shadow but no longer present → tombstone. Queue them in an **outbox** (`dailyTracker:sync:outbox`, persisted, survives reloads/offline) and update the shadow.
- An unreadable profile (`readProfileState` → null / load failure) is skipped – never produces tombstones.
- Pull before push on each cycle. Remote record newer than the shadow entry → apply into the profile (active profile through a new store helper that saves + emits `{ remote: true }`; others through `mutateProfileData`), update shadow. Remote record older → ignore (our outbox copy will win on push).
- Only one tab syncs at a time (`navigator.locks.request('dailyTracker-sync', …)`, fall back to a localStorage lease). Other tabs pick up changes through the existing storage events.
- Remote changes must not break an open Undo: an Undo after a remote change applies to the current state (re-find items by id), never restores a whole old state snapshot over newer remote data. Audit `actions.js` Undo closures for whole-state snapshots.
- Reminders: after remote changes are applied, the existing reminder/push reschedule path runs (the store emit already triggers it – verify).

## Import / export while signed in
- Export is unchanged (local data).
- Import confirm adds: "Profiles in your account stay in the account." Imported profiles whose id matches a synced profile update it (normal edits → sync). Synced profiles missing from the import are not deleted from the account; they are downloaded again. Other imported profiles are device-only.

## Server API (Worker, JSON, CORS as today)
All `/api/account/*`, `/api/sync/*`, `/api/passkey/*` responses include `now`. Errors: `{ error }` with 400/401/403/404/409/413/429.
Session auth: `Authorization: Bearer <session token>` (32 random bytes b64url; server stores SHA-256 only). Sessions last 400 days, `last_seen` updated at most hourly.

| Method path | Body → response |
|---|---|
| `POST /api/account/create` (header `X-Register-Key`) | `{ username, authKey, wrappedPw, wrappedRec, recAuth, deviceName }` → `{ accountId, token }`. 409 if the username is taken. |
| `POST /api/account/login` | `{ username, authKey, deviceName }` → `{ accountId, token, wrappedPw }`. Unknown user and wrong key give the same 401 "Wrong username or password". |
| `POST /api/account/recover` | `{ username, recAuth, newAuthKey, newWrappedPw, deviceName }` – but the client needs `wrappedRec` first, so this is two steps: `POST /api/account/recover/start { username, recAuth }` → `{ wrappedRec }` (401 if wrong); then `POST /api/account/recover/finish { username, recAuth, newAuthKey, newWrappedPw, deviceName }` → `{ accountId, token }`; finishing ends every other session. |
| `POST /api/account/password` (auth) | `{ authKey, newAuthKey, newWrappedPw }` → `{ ok }` |
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
- Stored password verifier: `PBKDF2-SHA-256(authKey, random 16-byte salt, 100 000 iterations)` (Workers' max), compared in constant time. Same for `recAuth`.
- Rate limits (existing `rate` table): login/recover failures 10/hour per username and 30/hour per IP; create 5/hour per IP; passkey login 30/hour per IP; push 600/hour and pull 1200/hour per account.
- Limits: 200 000 records and 200 MB of blobs per account (413 beyond); `MAX_ACCOUNTS` var (default 10).
- Challenges: single-use, 5-minute expiry, bound to their purpose (and account for registration).
- WebAuthn verification: `clientDataJSON.type`, `challenge`, `origin` ∈ ALLOWED_ORIGINS; `rpIdHash` = SHA-256(origin hostname); UP and UV flags set; signature over `authData || SHA-256(clientDataJSON)` with the stored COSE key (ES256: convert DER → raw r||s; RS256: RSASSA-PKCS1-v1_5 SHA-256); sign count: reject a non-zero count that doesn't increase. Minimal CBOR decoder for the attestation object and COSE key. No attestation verification (`none`).
- Never log tokens, authKeys, blobs.
- New D1 tables go in `schema.sql` (`CREATE TABLE IF NOT EXISTS`, safe to re-run on the live DB) – no change to existing tables. Purge expired challenges in the cron's purge.

## Client flows (Settings › Account, a new section at the top of Settings)
- Signed out: "Create account" and "Sign in" (password), "Sign in with passkey", "Forgot password? Use recovery key".
- Create: username, password (≥ 10 chars, confirm), register key (prefilled from the reminders config if set) → shows the **recovery key** with Copy and "I've saved it" (required checkbox) → profile picker → offer "Add a passkey".
- Sign in on a device: → downloads account profiles (progress) → profile picker for this device's profiles (rename step for name clashes).
- Passkey sign-in without PRF on a device that has no key yet → ask for the password (or recovery key) once to unlock.
- Signed in: username, sync status ("Synced just now" / "Offline – changes will sync" / error), each profile with "Synced" or "On this device only" + "Sync to account", passkeys (add/remove), signed-in devices (sign out other), change password, sign out, delete account.
- All text uses short month names. Only show warnings when something won't sync.

## Testing
- `server/test/account.test.mjs`: Miniflare end-to-end – create/login/recover/password/logout/delete, rate limits, LWW push/pull with seq, limits, CORS, and WebAuthn register/login with software ES256 and RS256 authenticators (including PRF wrap passthrough, replayed challenge, wrong origin, wrong rpIdHash, missing UV, bad signature, sign-count regression).
- `tests/t39.js`: two browser contexts against the real Worker in Miniflare (like t17): sign-up, recovery key shown, profile picker, sync of tasks/habits/logs/journal/settings both ways, offline edit then reconnect, latest-wins conflict, tombstones, profile rename clash, device-only badge before sign-in, sign out keep/remove, deleting a synced profile, import while signed in, unreadable profile never tombstones, newer `sv` pauses sync.
- Passkeys in the browser: Playwright CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`, ctap2, internal, resident key, UV) – test with and without PRF support.
