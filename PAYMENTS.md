# Lucky paid plan setup

Lucky gives signed-in public users Week 1 of their generated plan and unlocks Weeks 2–12 with a one-time Stripe Checkout payment. Accounts with founding-cohort beta access remain fully unlocked.

## Production configuration

1. Run `supabase/migrations/20260909000000_paid_plan_unlock.sql` in the Lucky Supabase project.
2. In Stripe, create an active **one-time** price for the full 90-day action plan.
3. Add these environment variables to the Vercel project:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PLAN_PRICE_ID`
   - `STRIPE_WEBHOOK_SECRET`
   - `SUPABASE_SERVICE_ROLE_KEY` (already used by the existing APIs)
4. In Stripe Workbench, add a webhook endpoint for:
   - URL: `https://lucky-action-plan.vercel.app/api/stripe-webhook`
   - Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`
5. Redeploy the production project after saving the environment variables.

Use Stripe test-mode values first. Complete a test checkout with a non-beta account and confirm that `/goals` restores all 12 weeks after payment.
