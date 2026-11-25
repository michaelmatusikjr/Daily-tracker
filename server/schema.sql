-- Daily Tracker push server schema (Cloudflare D1 / SQLite).
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,      -- random 128-bit id (base64url)
  token_hash  TEXT NOT NULL,         -- SHA-256 of the device token (the token itself is never stored)
  endpoint    TEXT NOT NULL,         -- push service URL from the browser
  p256dh      TEXT NOT NULL,         -- subscription public key
  auth        TEXT NOT NULL,         -- subscription auth secret
  tz          TEXT NOT NULL,         -- IANA time zone of the device (for local reminder times)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  account_id  TEXT                   -- NULL: registered with the register key (the owner); else the signed-in account that added it
);
-- One row per reminder rule (a task's or habit's reminder, with its recurrence).
CREATE TABLE IF NOT EXISTS rules (
  device_id TEXT NOT NULL,
  rule_id   TEXT NOT NULL,
  def       TEXT NOT NULL,           -- validated rule JSON (enc, url, tag, time, recur, dates…); the reminder text is ciphertext (enc) only the device can read
  next_at   INTEGER,                 -- next fire time, UTC ms (NULL: nothing left to fire)
  next_date TEXT,                    -- occurrence date of next_at (YYYY-MM-DD, the device's local date)
  PRIMARY KEY (device_id, rule_id)
);
CREATE INDEX IF NOT EXISTS rules_next ON rules (next_at) WHERE next_at IS NOT NULL;
-- Occurrences already sent (so nothing fires twice); purged after 3 days.
CREATE TABLE IF NOT EXISTS fired (
  device_id TEXT NOT NULL,
  rule_id   TEXT NOT NULL,
  date      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (device_id, rule_id, date)
);
CREATE TABLE IF NOT EXISTS rate (
  key   TEXT PRIMARY KEY,
  win   INTEGER NOT NULL,
  count INTEGER NOT NULL
);
-- Server status (cron heartbeat) for /api/health.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ===== Accounts and sync (SYNC.md). Additive only: safe to re-run on the live database. =====
-- The server only holds ciphertext: blobs and wrapped keys are encrypted on the devices.
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,      -- random 128-bit id (base64url)
  username    TEXT NOT NULL UNIQUE,  -- lower-case, [a-z0-9._-]{3,40}
  auth_salt   TEXT NOT NULL,         -- random 16 bytes (base64url) for auth_hash
  auth_hash   TEXT NOT NULL,         -- PBKDF2-SHA-256(authKey, auth_salt, 100000), hex
  rec_salt    TEXT NOT NULL,
  rec_hash    TEXT NOT NULL,         -- PBKDF2-SHA-256(recAuth, rec_salt, 100000), hex
  wrapped_pw  TEXT NOT NULL,         -- dataKey wrapped with the password key (opaque to the server)
  wrapped_rec TEXT NOT NULL,         -- dataKey wrapped with the recovery key
  seq         INTEGER NOT NULL DEFAULT 0, -- last sync sequence number handed out
  records     INTEGER NOT NULL DEFAULT 0, -- number of rows in records
  bytes       INTEGER NOT NULL DEFAULT 0, -- total blob length in records
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  invited     INTEGER NOT NULL DEFAULT 0 -- 1: created with an invite code (never gets the owner's register key)
);
-- Signed-in devices. Only the SHA-256 of the session token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,  -- public session id (for "sign out this device")
  account_id  TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
CREATE INDEX IF NOT EXISTS sessions_seen ON sessions (last_seen);
-- WebAuthn credentials (passkeys).
CREATE TABLE IF NOT EXISTS passkeys (
  id          TEXT PRIMARY KEY,      -- credential id (base64url)
  account_id  TEXT NOT NULL,
  alg         INTEGER NOT NULL,      -- COSE alg: -7 (ES256) or -257 (RS256)
  jwk         TEXT NOT NULL,         -- public key as JWK JSON
  sign_count  INTEGER NOT NULL DEFAULT 0,
  wrapped_prf TEXT,                  -- dataKey wrapped with the passkey's PRF key, if any
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_account ON passkeys (account_id);
-- Encrypted sync records. rid is an opaque HMAC of the record key; the latest (t, dev) wins.
CREATE TABLE IF NOT EXISTS records (
  account_id TEXT NOT NULL,
  rid        TEXT NOT NULL,
  seq        INTEGER NOT NULL,       -- account sequence number of the last accepted write
  t          INTEGER NOT NULL,       -- edit time (ms)
  dev        TEXT NOT NULL,          -- writer's device id
  blob       TEXT NOT NULL,          -- ciphertext (base64url)
  PRIMARY KEY (account_id, rid)
);
CREATE INDEX IF NOT EXISTS records_seq ON records (account_id, seq);
-- Single-use WebAuthn challenges (5 minutes).
CREATE TABLE IF NOT EXISTS challenges (
  id         TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,          -- base64url
  purpose    TEXT NOT NULL,          -- 'register' or 'login'
  account_id TEXT,                   -- set for 'register'
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges (expires_at);
-- Encrypted task photos (SYNC.md › Phase 2). fid is an opaque HMAC; the file is one AES-GCM
-- ciphertext (base64url), stored in chunks of at most 512 KiB characters (a D1 value is limited
-- to ~2 MB). An upload is only visible once committed (a row in files); until then its chunks
-- belong to a row in file_uploads, which the daily purge removes after a day.
CREATE TABLE IF NOT EXISTS files (
  account_id TEXT NOT NULL,
  fid        TEXT NOT NULL,          -- 32 bytes base64url (HMAC)
  upload     TEXT NOT NULL,          -- the upload whose chunks hold the data
  size       INTEGER NOT NULL,       -- total characters (counted in accounts.bytes)
  chunks     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, fid)
);
CREATE INDEX IF NOT EXISTS files_upload ON files (account_id, upload);
CREATE TABLE IF NOT EXISTS file_uploads (
  account_id TEXT NOT NULL,
  upload     TEXT NOT NULL,          -- random 16 bytes base64url
  fid        TEXT NOT NULL,
  size       INTEGER NOT NULL,
  chunks     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, upload)
);
CREATE INDEX IF NOT EXISTS file_uploads_age ON file_uploads (created_at);
CREATE TABLE IF NOT EXISTS file_chunks (
  account_id TEXT NOT NULL,
  upload     TEXT NOT NULL,
  n          INTEGER NOT NULL,       -- 0-based chunk number
  data       TEXT NOT NULL,          -- base64url characters
  PRIMARY KEY (account_id, upload, n)
);

-- ===== Invite codes (backlog #35). Additive only: safe to re-run on the live database. =====
-- A friend's single-use code for creating an account without the register key. Only an HMAC of
-- the code is stored (the code itself is shown once, to the owner, when it is made).
CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,       -- random id (base64url), what the owner's list uses to revoke
  code_hash  TEXT NOT NULL UNIQUE,   -- HMAC-SHA-256(REGISTER_KEY, "invite:" + code), hex
  name       TEXT NOT NULL DEFAULT '', -- the owner's label ("Sam"), optional
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,       -- created_at + 30 days
  used_at    INTEGER,                -- set atomically when an account is created with it
  account_id TEXT,                   -- the account it created
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invites_created ON invites (created_at);
