-- Master Key System — Supabase schema
-- Run this in: supabase.com → your project → SQL Editor → Run

-- 1. Per-part progress (sessions + notes stored as JSONB)
CREATE TABLE IF NOT EXISTS mks_user_progress (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  part        smallint    NOT NULL CHECK (part >= 1 AND part <= 24),
  sessions    jsonb       DEFAULT '[]'::jsonb NOT NULL,
  note        text        DEFAULT '' NOT NULL,
  updated_at  timestamptz DEFAULT now() NOT NULL,
  UNIQUE(user_id, part)
);

-- 2. Unlock status (one row per user, linked to Stripe session)
CREATE TABLE IF NOT EXISTS mks_unlocks (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  stripe_session_id text        UNIQUE,
  unlocked_at       timestamptz DEFAULT now() NOT NULL
);

-- Enable Row-Level Security
ALTER TABLE mks_user_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE mks_unlocks        ENABLE ROW LEVEL SECURITY;

-- Progress: users can only touch their own rows
CREATE POLICY "users manage own progress"
  ON mks_user_progress FOR ALL
  USING (auth.uid() = user_id);

-- Unlocks: users can read and insert their own row (no self-delete)
CREATE POLICY "users read own unlock"
  ON mks_unlocks FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users insert own unlock"
  ON mks_unlocks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 3. [DEPRECATED] Subscription status for /goals access, synced from Stripe via
-- webhook. /goals no longer gates on this table (see mks_goal_generations below) —
-- left in place only because it holds historical rows; not read or written by
-- any current code path.
CREATE TABLE IF NOT EXISTS mks_subscriptions (
  id                      uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                 uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  stripe_customer_id      text        UNIQUE,
  stripe_subscription_id  text        UNIQUE,
  status                  text        NOT NULL, -- mirrors Stripe subscription status: active, past_due, canceled, etc.
  current_period_end      timestamptz,
  updated_at              timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE mks_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own subscription"
  ON mks_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- 4. Goal plan generation on /goals is free, but strictly one goal per
-- account, permanently — the unique constraint on user_id is what enforces
-- that (see claimGeneration/releaseGeneration in decompose-goal.js: the
-- claim is inserted before the Gemini call and only released if that
-- specific attempt fails, so a failed attempt can retry but a successful
-- one can never be replaced by a second goal). This table is also the
-- durable copy of the plan itself (goal_data + plan): generation can take
-- 40-50s+ under sustained Gemini overload, and without a server-side copy,
-- a page reload/navigation mid-request used to silently lose a plan that
-- had actually succeeded, since it previously only ever lived in the
-- browser's localStorage.
CREATE TABLE IF NOT EXISTS mks_goal_generations (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  email         text        NOT NULL UNIQUE,
  goal_data     jsonb,
  plan          jsonb,
  generated_at  timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE mks_goal_generations ENABLE ROW LEVEL SECURITY;

-- Only the service role (decompose-goal.js) writes this table, so client-side
-- code can never tamper with the generation history.
CREATE POLICY "users read own generation record"
  ON mks_goal_generations FOR SELECT
  USING (auth.uid() = user_id);

-- 5. Lightweight event tracking, built directly on Supabase rather than a
-- third-party analytics tool (Mixpanel isn't in Vercel's marketplace at
-- all; PostHog is, but only for feature flags, and its marketplace
-- installation was broken — "Missing billingPlanId" — as of 2026-08-21).
-- Generic shape (event_name + jsonb properties) so more event types can be
-- added later without a schema change, but only user_registered is wired
-- up right now. No client-side read/write policy: written only by the
-- trigger below (as owner, bypassing RLS), read only via the SQL editor /
-- service role.
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

-- auth.users gets exactly one row per account, inserted once at sign-up and
-- never re-inserted on later sign-ins (those only update last_sign_in_at
-- on the same row) — so an AFTER INSERT trigger here is a reliable,
-- entirely server-side way to capture "user_registered" exactly once per
-- account, regardless of which page or auth flow they signed up through.
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
