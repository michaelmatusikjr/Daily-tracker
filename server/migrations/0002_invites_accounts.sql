-- One-time migration for the live database (release 1.17.0, invite codes). NOT idempotent: run it once.
-- Fresh installs get these columns from schema.sql and must not run this file.
ALTER TABLE devices ADD COLUMN account_id TEXT;
ALTER TABLE accounts ADD COLUMN invited INTEGER NOT NULL DEFAULT 0;
