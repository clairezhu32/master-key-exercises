-- Master Key System / Lucky — email waitlist
-- Run this in: supabase.com → your project → SQL Editor → Run

CREATE TABLE IF NOT EXISTS mks_waitlist (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  email       text        NOT NULL UNIQUE,
  source      text        DEFAULT '' NOT NULL,
  created_at  timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE mks_waitlist ENABLE ROW LEVEL SECURITY;

-- Only the service role (api/waitlist.js) writes this table.
CREATE POLICY "users cannot read waitlist"
  ON mks_waitlist FOR SELECT
  USING (false);
