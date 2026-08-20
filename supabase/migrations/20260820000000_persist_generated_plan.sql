-- The generated plan was only ever stored in the browser's localStorage.
-- Generation now routinely takes 40-50s+ under sustained Gemini overload,
-- and a page reload/navigation mid-request silently loses a plan that
-- actually succeeded server-side, with the user left looking at stale
-- cached content and no way to recover it. Persist it here so the client
-- can always recover the latest successful generation on next load.
ALTER TABLE mks_goal_generations ADD COLUMN IF NOT EXISTS goal_data jsonb;
ALTER TABLE mks_goal_generations ADD COLUMN IF NOT EXISTS plan jsonb;
