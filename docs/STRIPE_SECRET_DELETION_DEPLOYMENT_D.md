# Deployment D — Stripe secret / webhook deletion

**Status:** Applied 2026-08-07 (Stripe elimination pass).

## Secrets deleted

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED`
- `STRIPE_RUNTIME_DISABLED`

## Dashboard cleanup (manual)

- Disable/delete Stripe webhook endpoint(s) pointing at `…/functions/v1/stripe-webhook`
- Confirm Revolut Merchant webhook remains active

`stripe-webhook` edge stub remains deployed and returns HTTP 410 `STRIPE_RETIRED`.
