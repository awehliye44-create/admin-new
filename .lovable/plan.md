# Phase 3 — Driver Payouts on Revolut + Legacy Stripe Removal

Move the driver-payout leg onto Revolut Business `/pay`, rewrite the deferred Phase 2 admin trip endpoints to be provider-routed, and permanently delete the Stripe Connect code paths per the project cleanup policy.

## Hard blocker before we start

Revolut Business `/pay` needs a **source account UUID** — the Business account the platform pays drivers *out of*. This is one call away:

```
GET https://b2b.revolut.com/api/1.0/accounts
Authorization: Bearer <REVOLUT_BUSINESS_API_KEY>
```

I'll do this the same way we did the webhook: run it as a one-shot edge function against the stored Business key and pick the account matching the payout currency (typically GBP). But first I need to know whether the **Business API access token is the same key already stored as `REVOLUT_MERCHANT_SECRET_KEY`**, or a separate Business API token (Revolut treats Merchant and Business as different API surfaces with separate keys).

If Business is a separate key, please generate it in Revolut Business → APIs → Business API and paste it — I'll store it as `REVOLUT_BUSINESS_API_KEY` and continue.

Once the token is in place I'll fetch the account UUID automatically and store it as `REVOLUT_BUSINESS_SOURCE_ACCOUNT_ID`.

## What Phase 3 delivers

### 1. Driver onboarding (replaces `stripe-onboard-driver`)
- New `revolut-onboard-driver-destination` edge function. Admin (or driver, via a rider-facing endpoint later) submits IBAN / UK sort-code+account / Revtag. Function creates a Revolut **counterparty**, stores `counterparty_id` in `driver_payout_destinations.destination_payload`, marks `provider = 'revolut'`. Uses the existing `createRevolutCounterparty` helper in `_shared/revolutApi.ts`.
- Delete `stripe-onboard-driver` and all Stripe Connect onboarding UI paths.

### 2. Driver payout (replaces `admin-driver-payout` + `admin-driver-connect-payout`)
- Single new `admin-driver-payout` (rewritten from scratch): reads driver wallet ledger balance, resolves active Revolut counterparty, calls `executeRevolutPay` via Business API, writes payout row + ledger debit atomically only after Revolut confirms success (per **Stripe Payout Execution Safety** memory, translated to Revolut).
- Removes both `admin-driver-connect-payout` and the Stripe scheduling / lockdown functions (`admin-connect-payout-lockdown`, `admin-connect-payout-status`, `stripe-connected-balance-tx`, `admin-monday-payout-diagnostics`, `admin-stripe-payout-peek`, `stripe-reconciliation-audit`, `admin-sync-refund-from-stripe`, `admin-sync-trip-payment-from-stripe`, `phase-3d2-stripe-balance-audit`, `phase-3d3a-future-payout-probe`).
- Early cashout stays on the same new function with a `mode: 'early_cashout'` branch (per **Early Cashout Workflow** memory).

### 3. Balance + reconciliation
- New `revolut-business-balance` edge function replaces `stripe-connected-balance-tx`; reads account balance via Business API.
- New `revolut-reconciliation-audit` replaces `stripe-reconciliation-audit`; walks `driver_wallet_ledger` vs Revolut payout list and reports drift.

### 4. Provider-routed admin trip endpoints (deferred from Phase 2)
- `admin-capture-trip-payment` / `admin-cancel-trip-payment` / `admin-refund-trip-payment` / `admin-request-extra-payment` are rewritten to dispatch on `trips.payment_provider`. For `'revolut'` they call the Phase 2 Revolut helpers plus the new commission ledger writeback (which no longer relies on Stripe transfer IDs). For historical Stripe trips (`payment_provider IS NULL` and `stripe_payment_intent_id IS NOT NULL`) they keep the existing Stripe path — historical trips remain refundable/capturable via Stripe until every open one is closed, then Phase 4 drops the Stripe branch entirely.
- Note: this is the one narrow exception to the "no fallback" rule and is required by real-money audit obligations on captured trips already on Stripe. It is a bounded, dated transition path — not a new fallback.

### 5. Database
- Add `driver_wallet_ledger.provider_payout_id` (text) so payout ledger entries reference the Revolut transaction ID, alongside the existing Stripe columns which stay as historical evidence.
- Drop nothing yet — Stripe Connect columns on trips/payouts are historical evidence and removed in Phase 4.

### 6. Admin UI (this repo)
- `PaymentProviders` page: mark Revolut as live for both customer payments and driver payouts; remove the Stripe onboarding CTA.
- Payments list & detail: show Revolut order / refund IDs alongside historical Stripe IDs, dispatching on `payment_provider`.
- Driver wallet / payout screens: replace the "Connect Stripe" flow with "Add Revolut destination" (IBAN/Revtag entry).
- Delete every UI page and hook that only makes sense with Stripe Connect (`useConnectPayoutStatus`, `useMondayPayoutDiagnostics`, connect lockdown page, etc.) once the corresponding backend function is deleted.

### 7. Docs
- `docs/REVOLUT_DRIVER_PAYOUT_ARCHITECTURE.md` covering the counterparty flow, `/pay` idempotency, and the atomic wallet-debit sequence.

## Rollout order

1. **Confirm Business API token, fetch and store source account UUID.** (blocker)
2. Migration: add `driver_wallet_ledger.provider_payout_id`.
3. Ship `revolut-onboard-driver-destination` + `revolut-business-balance`.
4. Ship rewritten `admin-driver-payout` (Revolut path). Existing Stripe payout button stays disabled from Phase 3 day 1 — the platform can only pay via Revolut.
5. Rewrite `admin-capture/cancel/refund/extra-payment` to route by `payment_provider`.
6. Ship admin UI updates.
7. Delete every Stripe-only function/page/hook listed above in a single sweep.
8. Ship `revolut-reconciliation-audit`.
9. Write architecture doc.

## Phase 4 (not in this phase)
- Drop Stripe columns on `trips`, `payout_items`, `payout_batches` once all historical Stripe trips are terminal.
- Delete the historical-Stripe branch inside admin capture/refund and delete `_shared/stripeSettlement.ts` and related helpers.
- Retire `stripe_connect_payouts`, `processed_stripe_events`, `driver.stripe_account_id`.

## Verification

- Fetch source account UUID via one-shot: expect `state = "ACTIVE"`.
- Create a test counterparty against a Revtag; expect a counterparty UUID.
- Dry-run `/pay` with `request_id` and 1-penny amount against staging Business account, then reverse manually if needed.
- Trigger a real customer capture (Phase 2) → confirm webhook flips `payment_status = 'captured'` → run the new `admin-driver-payout` → confirm Revolut payout returns `id` and ledger writes the debit.
- `tsgo` clean; existing vitest suites pass; the CI Stripe test file gets rewritten or deleted rather than skipped.

Approve to proceed and paste the Business API key (or confirm the existing merchant key doubles as Business).
