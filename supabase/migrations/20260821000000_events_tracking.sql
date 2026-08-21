-- Lightweight event tracking, built on Supabase rather than a third-party
-- analytics tool. Generic shape (event_name + jsonb properties) so more
-- event types can be added later without a schema change, but only the
-- registration trigger below is wired up for now, per what was actually
-- requested.
CREATE TABLE IF NOT EXISTS mks_events (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  event_name  text        NOT NULL,
  user_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  email       text,
  properties  jsonb       DEFAULT '{}'::jsonb NOT NULL,
  created_at  timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS mks_events_event_name_idx ON mks_events (event_name, created_at DESC);

ALTER TABLE mks_events ENABLE ROW LEVEL SECURITY;

-- No client-side read or write policy: this table is written only by the
-- trigger below (as the table owner, bypassing RLS) and read only via the
-- Supabase SQL editor / service role — it's an internal record, not
-- user-facing data.

-- auth.users gets exactly one row per account, inserted once at sign-up and
-- never re-inserted on later sign-ins (those only update last_sign_in_at on
-- the same row) — so an AFTER INSERT trigger here is a reliable, entirely
-- server-side way to capture "user_registered" exactly once per account,
-- regardless of which page (goals.html, exercises.html, welcome.html) or
-- auth flow they signed up through.
CREATE OR REPLACE FUNCTION mks_track_user_registered()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO mks_events (event_name, user_id, email, properties)
  VALUES ('user_registered', NEW.id, NEW.email, jsonb_build_object('provider', NEW.raw_app_meta_data->>'provider'));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_registered ON auth.users;
CREATE TRIGGER on_auth_user_registered
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION mks_track_user_registered();
