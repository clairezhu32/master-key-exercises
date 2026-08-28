-- Replaces the Stripe subscription gate on /goals. The application now allows
-- three successful plans per account (the original plus two revisions), with
-- usage stored in goal_data and enforced by the server.
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
