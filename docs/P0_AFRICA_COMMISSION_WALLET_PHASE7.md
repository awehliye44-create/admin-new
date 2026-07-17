# P0 Africa Commission Wallet — Phase 7

**Status:** Delivered + gap-closed (completed-trip commission deduction + Finance `COMMISSION_WALLET_DEDUCTION`).

Primary repos: `drive-hub-buddy` (stop-workflow complete), `admin-new` (force_complete + Finance UI), shared DB `thazislrdkjpvvghtvzo`.

## Scope (done)

- SSOT: `planCommissionWalletDeduction`, `tripUsesCommissionWalletDeduction`, `aggregateCommissionWalletFinanceReport` (earned vs deducted + shortfall + provider fees), deduction idempotency keys, `REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION`
- Migration: `20260831800000_commission_wallet_phase7_completion_deduction.sql`
  - `driver_commission_wallet_balance_parts`
  - `convert_driver_commission_wallet_on_trip_complete` — convert active reserve → `converted_to_deduction`, write one `COMMISSION_DEDUCTION`
- Runtime:
  - `stop-workflow` `complete_trip` — CW path deducts via RPC; **skips** card finalize + `postTripEarningLedgerIfAbsent` / `driver_wallet_ledger`
  - Idempotent `complete_trip` / `force_complete` **repairs** missing CW deduction via `ensureCommissionWalletDeductionForCompletedTrip`
  - `postTripEarningLedgerIfAbsent` + `repair-commissions` hard-skip CW trips (`tripBlocksDriverWalletLedgerPosting`)
  - `admin-trip-action` `force_complete` — settlement columns + same RPC
- Admin Finance:
  - `admin-commission-wallet-overview` returns `finance_report` + `revenue_source: COMMISSION_WALLET_DEDUCTION`
  - Commission Wallet page Finance card (customer fare ≠ ONECAB revenue; payout liability = 0; earned/deducted/shortfall)
  - `admin-finance-summary` exposes separate `totals.commission_wallet_deduction_pence` (not mixed into UK `PLATFORM_COMMISSION`)

## Behaviour

| Event | Action |
|-------|--------|
| Complete trip (CW on) | Settlement columns on trip; convert active reserve; one `COMMISSION_DEDUCTION` (promo-first) |
| Complete retry after status=completed | Repair missing deduction if CW |
| Complete trip (PLATFORM_COLLECTED) | Unchanged UK `driver_wallet_ledger` path |
| Duplicate complete | Idempotent (`ALREADY_DEDUCTED` / unique trip deduction index) |
| Cancel / rematch | Phase 6 release only — no deduction |
| Customer fare $20 / commission $3 | ONECAB revenue = $3; customer collection = $0; payout liability = $0 |

## Isolation

- Never writes `driver_wallet_ledger` / payout / weekly settlement for CW trips
- UK `PLATFORM_COMMISSION` / Financial Reconciliation capture path unchanged for PLATFORM_COLLECTED
- Locked accept / preset client pipelines untouched

## Gap-close (this pass)

1. Idempotent complete repairs missing deduction
2. Skip Stripe/Revolut finalize on CW complete
3. DWL writers (`postTripEarning`, `repair-commissions`) fail-closed for CW
4. Finance earned ≠ deducted + shortfall + provider fees field
5. Main finance summary surfaces CW as separate revenue source
6. force_complete writes settlement columns
7. Static Phase 7 guards

## Gap-close pass 2

8. Complete / force_complete return `cw_deduction_ok` + `financial_ok` (lifecycle can succeed while finance flags failure)
9. `record-financial-outcome` skips DWL for CW trips
10. Customer `postTripEarningLedgerIfAbsent` CW-blocked (webhook/capture path)
11. `ZERO_USABLE_AFTER_RELEASE` now still writes `COMMISSION_DEDUCTION` (forced overdraft + shortfall metadata) — migration `20260831810000_…`
12. Settlement-summary / trip gross excludes `DRIVER_COLLECTED_COMMISSION_WALLET` trips (`excludeTripFromPlatformCollectedFinance`)
13. CW overview trip counts only enabled SAs

## Gap-close pass 3

14. `admin-payment-detail` confirm skips DWL for CW
15. `creditCapturedCardTripLedger` (drive + admin) CW-blocked — covers stripe-webhook path
16. `noShowSettlement` compensation DWL CW-blocked
17. FR SSOT (`sumOnecabGrossCommissionPence`, driver net, ledger metrics) excludes CW `financial_model`
18. `admin-finance-reconciliation` selects `financial_model` for exclusion

## Not Phase 7

Fixed platform charge add-on, mid-negotiation reserve recalculation, `COMMISSION_DEDUCTION_REVERSAL` admin tooling, persisting provider fees on every top-up (field ready; fee=0 until providers report it).

**Phase 8:** Banadir pilot enabled — see `P0_AFRICA_COMMISSION_WALLET_PHASE8.md`.
