-- Release 1.18.0 (encrypted reminder text). Run once on the live database BEFORE deploying the 1.18.0 Worker:
--   npm run db:migrate:0003
-- Reminder text (title/body) used to be stored in plaintext inside each rule's JSON. From 1.18.0 it only ever exists
-- as ciphertext (`enc`) that the receiving device encrypted. This removes the old plaintext from every stored rule.
-- Each device sends its rules again (encrypted) the next time the app opens; until then a rule without `enc` fires a
-- generic "Reminder" notification. Safe to run more than once. Does not touch fresh installs (schema.sql has no plaintext).
UPDATE rules SET def = json_remove(def, '$.title', '$.body') WHERE json_extract(def, '$.title') IS NOT NULL OR json_extract(def, '$.body') IS NOT NULL;
