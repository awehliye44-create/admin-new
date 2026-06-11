# Finance Accounting Separation — ONECAB Commission vs Stripe Platform Balance

## Problem
The admin panel (and downstream driver app surfaces) currently conflates **Stripe platform balance / unallocated cash** with **ONECAB commission earned**. This produces wrong totals on:
- Admin Payments / Payout Batches / Driver Settlements / Disputes & Adjustments
- Driver Wallet & Ledger
- Driver app lifetime / today / wallet / pending / available
- Customer-side fare summaries that read from the same hooks

Root cause: several admin views derive ONECAB commission as `stripe_available_balance − driver_payable` instead of summing `driver_wallet_ledger.PLATFORM_COMMISSION` (the locked SOT per `mem://finance/unified-financial-source-of-truth`).

## Strict definitions (the only formulas that may be used)

| Metric | Formula | Source |
|---|---|---|
| Total customer revenue | `Σ payments.captured_amount_pence` (status = captured/succeeded) | `payments` |
| ONECAB gross commission | `Σ driver_wallet_ledger.amount_pence WHERE type='PLATFORM_COMMISSION'` | ledger SOT |
| Stripe processing fees | `Σ trips.stripe_processing_fee_pence` | trips |
| ONECAB net commission | gross commission − Stripe fees | derived |
| Driver net earnings | `Σ ledger(NET_FARE + TIP + AIRPORT + PASS_THROUGH)` | ledger SOT |
| Stripe platform balance | live `balances.available + balances.pending` from Stripe API | edge fn |
| Driver payout liability | `Σ driver_wallets.balance_pence` (positive only) | wallets |
| Driver available payout | `Σ driver_financial_summary.net_available_for_payout` | view |
| Driver pending payout | captured driver earnings not yet Stripe-available | derived |

Commission is **never** calculated as `stripe_balance − driver_payable`.

## Backend changes

### 1. New edge function `admin-finance-summary`
Returns one canonical object per region (or All Services grouped by currency):
```ts
{
  currency_code,
  totals: {
    customer_revenue_pence,       // payments.captured_amount_pence
    onecab_gross_commission_pence,// ledger PLATFORM_COMMISSION
    stripe_fees_pence,            // trips.stripe_processing_fee_pence
    onecab_net_commission_pence,  // derived
    driver_net_earnings_pence,    // ledger NET_FARE+TIP+AIRPORT+PASS_THROUGH
    driver_payout_liability_pence,// Σ driver_wallets.balance > 0
    driver_available_payout_pence,// Σ net_available_for_payout
    driver_pending_payout_pence,
  },
  stripe_platform_balance: { available_pence, pending_pence, source: 'stripe_api'|'unavailable' },
  commission_status: 'stripe_confirmed'|'stripe_paid_out'|'calculated_pending'|'legacy_fallback',
  validation_warnings: string[]   // e.g. "Commission exceeds tier cap"
}
```
Implementation reuses `_shared/commission.ts` for the tier-cap validation and the existing Stripe client for balance + payouts.

### 2. Validation rule (server-side, inside the function)
```
if onecab_gross_commission > commissionable_revenue × max_driver_tier_pct
  → push warning "Commission exceeds allowed tier cap — calculation mismatch."
```

### 3. Commission status resolution
- If `processed_stripe_events` has a recent `balance.available` event covering the period → `stripe_confirmed`
- If a Stripe payout to the ONECAB platform bank exists → `stripe_paid_out`
- Else if ledger has `PLATFORM_COMMISSION` rows → `calculated_pending`
- Else → `legacy_fallback`

No migrations required — all numbers come from existing tables (`driver_wallet_ledger`, `payments`, `trips`, `driver_wallets`, `driver_financial_summary`).

## Frontend changes

### `src/hooks/useAdminFinanceSummary.ts` (new)
Wrap the edge function with React Query (5-min stale, per centralized caching memory).

### `src/components/finance/FinanceTotalsCards.tsx` (new, reusable)
Renders the 9 required cards in order:
1. Total customer revenue
2. ONECAB gross commission
3. Stripe processing fees
4. ONECAB net after Stripe fees
5. Stripe platform balance — **labelled "Platform balance — not commission"**, distinct slate styling, info tooltip
6. Driver payout liability
7. Driver available payout
8. Driver pending payout
9. ONECAB commission payout status (badge: confirmed / paid / calculated / legacy + fallback chip when not Stripe-confirmed)

Mixed-currency safe via existing `CurrencyGroupedStats`.

### Pages updated to consume the new hook (remove any local commission math)
- `src/pages/AdminPayments.tsx`
- `src/pages/AdminPayoutBatches.tsx`
- `src/pages/AdminDriverSettlements.tsx`
- `src/pages/DriverWallet.tsx` (admin view — show Gross fares / Card credits / Driver net / Cash debt / Wallet balance / Pending / Available / Paid out / In-flight cashout)
- `src/pages/Disputes.tsx` summary header

### Driver app surfaces (driver-app project, mirrored via existing `driver-wallet-summary` edge fn)
- Confirm the function returns `lifetime_earnings`, `today_earnings`, `wallet_balance`, `pending_payout`, `available_payout`, `cash_debt_pence` — already implemented per memory; only add a guard so it **never** falls back to `stripe_available_balance` if the ledger query fails (throw structured `error_code: WALLET_LEDGER_UNAVAILABLE` instead, per the No-Silent-Failures policy).

### Tests
- Extend `src/test/tripAccounting.test.ts` with a regression case asserting `commission ≠ stripe_balance − driver_payable`.
- New `src/test/financeSummary.test.ts` covering the 4 commission_status branches and the tier-cap warning.

## Out of scope (kept untouched)
- Existing `record-financial-outcome`, commission writes, ledger schema — these are correct; only the **reporting layer** is being fixed.
- Customer fare engine.

## Risks / fallbacks
- If Stripe API is unreachable: `stripe_platform_balance.source = 'unavailable'`, card shows "—" with a warning chip; commission status falls back to `calculated_pending` so admins still see a number.
- All historical trips with missing `commission_pence` get a fallback chip on the row and use `commissionable_fare × tier_pct` per `_shared/commission.ts`.

## Deliverables
1. `supabase/functions/admin-finance-summary/index.ts`
2. `src/hooks/useAdminFinanceSummary.ts`
3. `src/components/finance/FinanceTotalsCards.tsx`
4. Edits to the 5 admin pages above
5. Driver-wallet-summary guard tweak
6. 2 test files

Estimated diff: ~900 lines across ~10 files, no DB migration.
