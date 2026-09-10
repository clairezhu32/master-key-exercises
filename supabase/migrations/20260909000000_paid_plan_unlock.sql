-- One-time paid access to the complete Lucky 90-day action plan.
CREATE TABLE IF NOT EXISTS mks_unlocks (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  stripe_session_id text        UNIQUE,
  unlocked_at       timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE mks_unlocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users insert own unlock" ON mks_unlocks;
DROP POLICY IF EXISTS "users read own unlock" ON mks_unlocks;

CREATE POLICY "users read own unlock"
  ON mks_unlocks FOR SELECT
  USING (auth.uid() = user_id);

-- Inserts are deliberately service-role-only after Stripe verifies payment.
