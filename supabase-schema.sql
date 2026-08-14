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

-- 4. Goal plan generation on /goals is free, limited to one per account.
-- Uniqueness on both user_id and email means deleting and recreating an
-- account with the same email doesn't grant a second free generation.
CREATE TABLE IF NOT EXISTS mks_goal_generations (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  email         text        NOT NULL UNIQUE,
  generated_at  timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE mks_goal_generations ENABLE ROW LEVEL SECURITY;

-- Only the service role (decompose-goal.js) writes this table, so client-side
-- code can never self-grant another free generation.
CREATE POLICY "users read own generation record"
  ON mks_goal_generations FOR SELECT
  USING (auth.uid() = user_id);
