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
  last_seen   INTEGER NOT NULL
);
-- One row per reminder rule (a task's or habit's reminder, with its recurrence).
CREATE TABLE IF NOT EXISTS rules (
  device_id TEXT NOT NULL,
  rule_id   TEXT NOT NULL,
  def       TEXT NOT NULL,           -- validated rule JSON (title, body, url, tag, time, recur, dates…)
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
  updated_at  INTEGER NOT NULL
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
