# Phase 2 — Customer Checkout on Revolut

Move the customer-facing pre-auth → capture → refund flow off Stripe and onto the Revolut Merchant Orders API. Per project cleanup policy, Stripe checkout code is permanently deleted, not kept as fallback. Driver payouts stay on the existing (Stripe Connect) path until Phase 3.

## What changes

### Backend edge functions (rewritten to Revolut, Stripe removed)
- `create-payment-intent` → creates a Revolut **Order** with `capture_mode = manual`, amount = pre-auth hold (payable + buffer). Returns `order_id`, `checkout_token`, and `checkout_url` for the customer app widget. Commission math and pre-auth buffer logic are preserved.
- `capture-trip-payment` → calls Revolut `POST /orders/{id}/capture` with the actual final fare (payable amount, never the buffer). Uncaptured remainder is auto-released by Revolut.
- `admin-capture-trip-payment` → same Revolut capture call, admin-audited.
- `admin-cancel-trip-payment` → Revolut `POST /orders/{id}/cancel` for uncaptured holds.
- `admin-refund-trip-payment` → Revolut `POST /orders/{id}/refund` for captured amounts.
- `admin-request-extra-payment` → creates a second Revolut Order for the extra amount (Revolut does not support raising an authorised hold).
- `admin-sync-trip-payment-from-stripe` → replaced by `admin-sync-trip-payment` (reads Revolut order state).
- `admin-get-trip-payment-state` / `admin-payment-detail` / `admin-payments-list` / `admin-payments-summary` → point at the new Revolut fields.
- `revolut-webhook` (already live) → gains business logic: on `ORDER_COMPLETED` / `ORDER_AUTHORISED` / `ORDER_CANCELLED` / `ORDER_FAILED`, updates the matching trip's payment_status and writes an `admin_payment_audit` row.

### Database schema (migration)
Add generic provider-scoped columns to `trips`:
- `payment_provider text` (`'revolut'` for new orders)
- `provider_order_id text` (Revolut order UUID)
- `provider_checkout_token text` (short-lived, for the customer app)
- `provider_charge_id text` (populated at capture)

Keep the historical `stripe_payment_intent_id` **on completed pre-migration trips only** as immutable history. New trips write only the provider_* columns. No dual-write, no fallback.

Add unique index on `(payment_provider, provider_order_id)`.

### Customer app (out of scope for this repo)
This admin repo does not contain the customer app. Deliverable here is the backend API contract change; the customer-app team will swap the Stripe.js widget for Revolut's `RevolutCheckout` JS widget using the `checkout_token` returned by `create-payment-intent`. Contract documented in `docs/REVOLUT_CUSTOMER_CHECKOUT_CONTRACT.md`.

### Admin UI (this repo)
- `PaymentProviders` page: mark Revolut as the live customer-payments provider; remove the Stripe "customer payments" toggle.
- `Payments` list & detail: show Revolut order ID / state, Revolut refund IDs. Remove Stripe-only columns from the customer-payment views (Stripe columns remain visible only on payout / Connect pages until Phase 3).

## Out of scope (Phase 3)
- Driver payouts / Stripe Connect removal
- Merchant/source account UUID wiring for Revolut Business `/pay`
- Deleting `stripe-onboard-driver`, `stripe-connected-balance-tx`, Connect payout tables

## Rollout order within Phase 2
1. Migration: add provider_* columns + index.
2. Rewrite `create-payment-intent` (Revolut Orders create, manual capture).
3. Rewrite capture / cancel / refund / extra-payment / sync functions.
4. Wire webhook business logic (status sync + audit).
5. Update admin UI (Payments list/detail, Payment Providers page).
6. Delete now-unused Stripe customer-checkout helpers (statement descriptor, PI-scoped utilities used only by customer flow).
7. Write `docs/REVOLUT_CUSTOMER_CHECKOUT_CONTRACT.md` for the customer-app team.

## Verification
- Deploy each function; call it end-to-end against Revolut live API using an existing test trip.
- Trigger a real `ORDER_AUTHORISED` webhook to confirm signature + status sync.
- Confirm admin Payments list renders new Revolut order IDs.
- `tsgo` typecheck clean, existing vitest suites pass.

Approve to proceed, or tell me to trim (e.g. skip admin UI in this phase, or keep `admin-sync-trip-payment-from-stripe` as a one-off historical reader).
