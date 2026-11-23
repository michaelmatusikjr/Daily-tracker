# Accounts and sync (backlog #2): design and API contract

This is the source of truth for the sync feature. The server (`server/src/sync.js`, mounted from `server/src/index.js`) and the client (`js/sync*.js`) both follow it. If you change the contract, update this file.

## Decisions (from the user, 2026-11-17)
- Sign in with a **passkey** (Face ID / Touch ID). **Username + password** is the backup sign-in.
- **One account holds all profiles** (a household account).
- **End-to-end encryption:** the server stores only ciphertext. The password unlocks the data key. A one-time **recovery key** also unlocks it.
- **Photos sync too:** task photos (IndexedDB), habit image icons and profile photos (these two are inline in the JSON).
- All devices and browsers: Safari (iOS 16+), Chrome, Firefox.

## Threat model and crypto (client: WebCrypto only)
- `dataKey`: a random 256-bit AES-GCM key per account. It encrypts everything. It never leaves a device unwrapped.
- **Password.** The client computes `master = PBKDF2-SHA256(password, salt, 600000 iterations, 256 bits)`. Here `salt` is 16 random bytes per account, stored on the server and returned by `/api/auth/salt`. Two keys come from master via HKDF-SHA256, with an empty salt and distinct `info` values:
  - `authKey = HKDF(master, info "dt-auth-v1", 32 bytes)` is sent to the server as base64url. The server never sees the password itself.
  - `pwKek = HKDF(master, info "dt-kek-v1")` is an AES-GCM key that wraps `dataKey`. Its output is `wrap_pw`.
- **Server-side check.** The server stores `auth_hash = SHA-256(auth_salt ‖ authKey)` with a random 16-byte `auth_salt`, and compares in constant time. The stretching happens on the client (600k PBKDF2), so the value the server hashes is a high-entropy 256-bit key and a single salted SHA-256 is enough. This also keeps the Worker within its free-plan CPU limit, which a server-side PBKDF2 would not.
- **Recovery key.** It is 32 random bytes, shown as Crockford base32 in groups of 4 (`XXXX-XXXX-…`). It is shown once, at sign-up or on regeneration. HKDF from it gives:
  - `recAuth` (info `"dt-rec-auth-v1"`): the server stores `recovery_hash`, a salted SHA-256 like `auth_hash`.
  - `recKek` (info `"dt-rec-kek-v1"`): it wraps `dataKey`. Its output is `wrap_rec`.
- **Passkey PRF**, when the authenticator supports it (iOS 18+, recent Chrome/Android). Request `extensions.prf.eval.first` = UTF-8 `"daily-tracker-prf-v1"` at create and get. When `getClientExtensionResults().prf.results.first` is present, `prfKek = HKDF(prfOutput, info "dt-prf-kek-v1")` wraps `dataKey` to give `wrap_prf`, stored per credential.
  - If create gave no PRF result, wrap lazily on the next passkey sign-in, on a device that already holds `dataKey`.
  - If a passkey sign-in on a new device has no usable `wrap_prf`, the user is **signed in but locked**. Ask once for the password (or recovery key) to unlock. Unlocking derives `pwKek` and unwraps `wrap_pw`, and needs no server round trip beyond the data already returned.
- **Wrapped key format:** base64url of `[0x01][12-byte IV][AES-GCM(dataKey raw 32 bytes)]`, with AAD `"dt-wrap-v1"`.
- **Encrypted blob format** (docs and files), as bytes:
  - `[0x01 version][flags: bit0 = gzip][12-byte IV][AES-GCM ciphertext+tag]`
  - AAD = UTF-8 of `"<accountId>:doc:<docId>"` or `"<accountId>:file:<fileId>"`, so blobs can't be swapped between slots or accounts.
  - gzip uses `CompressionStream` when it exists. Otherwise write flags = 0.
- **On the device:**
  - `dataKey` is stored in IndexedDB (`dailyTracker-sync`, store `keys`) as a **non-extractable** CryptoKey. Generate or import it as extractable only for the moment of wrapping, then re-import it non-extractable for storage.
  - The session token and account info live in localStorage `dailyTracker:account` = `{ server, accountId, username, token, locked, lastSyncAt, seq }`. It is never included in exports, like the push device credentials.

## Server (Cloudflare Worker + D1): the existing push server, new tables (additive only)
```sql
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL,
  auth_salt TEXT NOT NULL, auth_hash TEXT NOT NULL, rec_salt TEXT NOT NULL, rec_hash TEXT NOT NULL,
  wrap_pw TEXT NOT NULL, wrap_rec TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY /* credential id b64url */, account_id TEXT NOT NULL,
  alg INTEGER NOT NULL, jwk TEXT NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, wrap_prf TEXT, name TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used INTEGER);
CREATE INDEX IF NOT EXISTS credentials_account ON credentials (account_id);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE /* public session id */, account_id TEXT NOT NULL,
  label TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, account_id TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS docs (account_id TEXT NOT NULL, doc_id TEXT NOT NULL, rev INTEGER NOT NULL, seq INTEGER NOT NULL,
  data BLOB, deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (account_id, doc_id));
CREATE TABLE IF NOT EXISTS files (account_id TEXT NOT NULL, file_id TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (account_id, file_id));
```
- **Account ids:** 128-bit random, base64url. **Usernames:** 3–40 chars `[a-z0-9._-]`, case-insensitive (stored lowercase).
- **Sessions:** tokens are 256-bit random. Only the SHA-256 is stored. They expire after 365 days without use (`last_seen`); `purge()` removes stale sessions and expired challenges.
- **Limits:**
  - `MAX_ACCOUNTS`: var, default 5.
  - Doc ciphertext ≤ 1,900,000 bytes. File ciphertext ≤ 1,900,000 bytes (D1 row limit 2 MB).
  - Per-account total ≤ 500 MB, tracked in `accounts.bytes`.
  - At most 50 docs and 5,000 files per account.
- **Rate limits** (reuse `rateLimit`):
  - sign-up: 5/hour per IP.
  - salt / login / passkey-options / passkey-login / recover: 20/hour per IP, plus 10/hour per username where a username is given.
  - sync: 600/hour per session.
  - After 10 consecutive failed password or recovery checks, the account is locked for 15 minutes (`locked_until`). A success resets `fails`.
- **Unknown usernames:** `/api/auth/salt` returns a deterministic fake salt, so it doesn't reveal which usernames exist: the first 16 bytes of `HMAC-SHA256(key = REGISTER_KEY, "salt:" + username)`. `/api/auth/login` returns the same generic `401 Wrong username or password` for every failure.
- **CORS:** same as today (ALLOWED_ORIGINS). Allow the header `X-Base-Rev`, plus methods `PATCH` and `PUT`.
- **WebAuthn verification** (no libraries; a minimal CBOR decoder in `server/src/cbor.js`):
  - rpId = hostname of the request `Origin`, which must be in ALLOWED_ORIGINS. `clientDataJSON.origin` must equal the request Origin.
  - `type` must be `webauthn.create` or `webauthn.get`. `challenge` must match an unexpired (5 min), unused challenge of the right kind. The challenge is deleted on use.
  - authData: `rpIdHash` = SHA-256(rpId); flags UP (0x01) and UV (0x04) set; AT (0x40) on create.
  - At create, parse the attestation object (`fmt` any; `attStmt` ignored, since attestation is `none`). Get the credential id and the COSE key from attested credential data. Support alg −7 (ES256, EC2 P-256) → JWK, and −257 (RS256) → JWK.
  - At get, verify the signature over `authData ‖ SHA-256(clientDataJSON)`. For ES256, convert the DER signature to raw r‖s for WebCrypto. signCount: if both stored and new are non-zero and new ≤ stored, reject; otherwise store the new value.

### Endpoints (JSON unless noted; auth = `Authorization: Bearer <token>`)
| Method & path | Auth | Body → Result |
|---|---|---|
| `POST /api/auth/signup` | `X-Register-Key` (same REGISTER_KEY as push) | `{username, salt, authKey, recAuth, wrapPw, wrapRec, label}` → `201 {accountId, token, sessionId}`. Server makes auth_salt/rec_salt, hashes. 409 username taken. 503 MAX_ACCOUNTS reached. |
| `POST /api/auth/salt` | — | `{username}` → `{salt}` (real or fake) |
| `POST /api/auth/login` | — | `{username, authKey, label}` → `{accountId, username, token, sessionId, wrapPw}` or 401 / 429 (locked) |
| `POST /api/auth/recover` | — | `{username, recAuth, label}` → `{accountId, username, token, sessionId, wrapRec}`; the client must then set a new password |
| `POST /api/auth/passkey/options` | — (or auth when adding a passkey) | `{purpose:"login"}` → `{challengeId, challenge, rpId}`; `{purpose:"register"}` (auth required) → `{challengeId, challenge, rpId, user:{id, name}, exclude:[credIds]}` |
| `POST /api/auth/passkey/register` | auth | `{challengeId, clientDataJSON, attestationObject, name, wrapPrf?}` (b64url) → `201 {credentialId}` |
| `POST /api/auth/passkey/login` | — | `{challengeId, credentialId, clientDataJSON, authenticatorData, signature, label}` → `{accountId, username, token, sessionId, wrapPw, wrapPrf}` (wrapPrf null if none) |
| `PUT /api/auth/passkey/:credId/prf` | auth | `{wrapPrf}` → `{ok}` (the credential must belong to the account) |
| `GET /api/account` | auth | → `{accountId, username, bytes, docs, files, passkeys:[{id,name,createdAt,lastUsed,prf}], sessions:[{id,label,createdAt,lastSeen,current}]}` |
| `PUT /api/account/password` | auth | `{authKey (current), newSalt, newAuthKey, newWrapPw}` → `{ok}`. After `/recover`, a recovery session may skip `authKey` once: recover marks the session `recovery`, and it is cleared on use or after 15 min. |
| `PUT /api/account/recovery` | auth | `{authKey, recAuth, wrapRec}` → `{ok}` (new recovery key) |
| `DELETE /api/account/passkey/:credId` | auth | → `{ok}` |
| `DELETE /api/account/session/:id` | auth | → `{ok}` (sign out a device; `current` = sign out) |
| `DELETE /api/account` | auth + `{authKey}` | deletes everything for the account |
| `GET /api/sync/changes?since=<seq>` | auth | → `{seq, docs:[{id, rev, seq, deleted, data(b64url or null)}]}`: docs with `seq > since`, at most 2 MB per page, plus `more:true` if truncated |
| `PUT /api/sync/doc/:docId` | auth, header `X-Base-Rev: <rev or 0>` | `{data: b64url}` or `{deleted:true}` → `{rev, seq}`. 409 `{rev, seq, data, deleted}` if the current rev ≠ base. Doc ids: `index` or `p.<profileId>` (`[A-Za-z0-9._-]{1,64}`). Every write does `seq = accounts.seq + 1`. |
| `GET /api/sync/files` | auth | → `{files:[{id,size,createdAt}]}` |
| `PUT /api/sync/file/:fileId` | auth, `Content-Type: application/octet-stream` | raw ciphertext → `{ok}` (idempotent; existing id = 200 no-op) |
| `GET /api/sync/file/:fileId` | auth | → raw bytes (`application/octet-stream`) |
| `DELETE /api/sync/file/:fileId` | auth | → `{ok}` |

## Client sync model
- **Docs:**
  - `index` = `{ v:1, profiles:[{id,name,avatar,updatedAt}], deleted:[ids] }`. `activeId` stays local to each device.
  - `p.<profileId>` = that profile's full state (the same JSON as `dailyTracker:data:<id>`).
- **Base copies.** For each doc the device keeps the last-synced plaintext and rev in IndexedDB `dailyTracker-sync` › `bases`: `{docId, rev, json}`. Sync is a **three-way merge (base, local, remote)**.
- **`mergeState(base, local, remote)`** is a pure function in `js/syncMerge.js`:
  - **Lists by id** (tasks, habits, categories, exercises, workouts):
    - only one side changed vs base → take that side;
    - deleted on one side and unchanged on the other → delete;
    - changed on both → higher `updatedAt` wins, and on a tie, remote wins;
    - added on both → `updatedAt` wins.
  - Item order stays a field (`order`) and isn't a conflict.
  - **Maps per key:** `logs[habit][date]`, `autoHabit[habit][date]`, `journal[date]`.
  - **Settings:** per top-level key, with the same rule (both changed → remote wins).
  - Device-local settings are never taken from remote: `notifications` (permission or reminders on this device). Check for others.
  - With **no base** (first sync of a device that already has data), it is a union: nothing is deleted, and on a conflict the newer `updatedAt` wins.
  - Every mutation in `js/actions.js` / `js/workouts.js` / `js/forms.js` that changes a list item must set `updatedAt = Date.now()`. Audit this.
- **Index merge:** union by id, newer `updatedAt` wins, tombstones stick (like the existing `mergeIndex`).
- **Loop** (`js/sync.js`, one run at a time; use `navigator.locks` when present so two tabs don't sync at once):
  1. Pull `changes?since=seq`.
  2. Decrypt.
  3. For each doc, merge (base, local, remote) → write local. The active profile uses the store's in-memory state, and views refresh with `emit({external:true})`. Other profiles go to localStorage.
  4. Set base = remote.
  5. Push every doc whose local JSON ≠ base (`X-Base-Rev` = base rev). On 409, merge with the returned doc and retry (at most 3 times).
  6. Save the new base and seq.
- **Unreadable profiles:** a profile whose local data can't be read (store `loadFailure` / `readProfileState` null) is never pushed and never overwritten by sync.
- **Profile deletes:**
  - A profile deleted locally → tombstone in index + `{deleted:true}` for its doc.
  - A profile deleted remotely → removed locally (its data is first kept as a local backup key, as the store does today).
- **Photos:**
  - After docs sync, upload every IndexedDB file referenced by a task attachment that isn't uploaded yet (`dailyTracker-sync` › `uploaded` set). Upload the encrypted blob of `{meta, blob, thumbBlob}`, serialised as one binary: a JSON header length + JSON + bytes.
  - Download referenced ids missing locally, and `putFile` them with the right `profileId`/`taskId`.
  - Server GC: delete server files not referenced by any profile **and** older than 7 days (`createdAt`).
  - Photos over the limit are skipped with a note in Settings.
- **When to sync:**
  - on start (after sign-in);
  - on `visibilitychange` → visible;
  - on `online`;
  - 2 s after any local change (debounced, subscribed to the store);
  - every 60 s while visible;
  - on Today's pull-to-refresh.
- **Offline:** quietly retry later. A locked account (no dataKey yet) never syncs.

## Settings › Account (new group at the top of Settings)
- **Signed out:** an "Account and sync" row → sheet with **Sign in with passkey**, **Sign in with password**, **Create account**, and "Use recovery key".
  - **Create account** asks for username, password (min 10 chars, confirm) and the register key (prefilled from Reminders › Advanced if set). It then shows the **recovery key** with Copy, and requires "I saved it" before continuing. Then it offers **Add a passkey** (recommended) or "Not now".
- **First sign-in on a device with local data, when the account already has data:**
  - **Merge** (default): union.
  - **Use the account's data**: this device's profiles are kept as a downloadable backup first.
- **Signed in:**
  - username;
  - "Last synced 2 min ago" / "Syncing…" / an error line;
  - **Sync now**;
  - **Passkeys** list (add / remove);
  - **Devices** (sessions: sign out others);
  - **Change password**;
  - **New recovery key**;
  - **Sign out** (keeps data on this device);
  - **Delete account** (server data only; typed confirmation).
- **Locked state:** "Enter your password to unlock sync on this device".
- Text follows the app's style: short month names, sentence case. Destructive actions confirm. Undo isn't possible for server deletes, so confirm instead.
