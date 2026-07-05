# Digital-Only Finance SSOT — Cash Workflow Removal Audit

**Date:** 2026-07-05 (final pass complete)  
**Status:** Production SSOT is **100% digital-only** for all new trips

## Production SSOT (100% digital-only)

| Layer | Enforcement |
|-------|-------------|
| DB trigger | `block_cash_payment_method_trg` — rejects `payment_method = CASH` on insert/update |
| Finance era | `admin_settings.finance_era = digital` |
| Service area | `cash_enabled` column dropped (migration `20260702203718`) |
| Booking API | `create-ride` — **410** for cash; deferred scheduled **card** only |
| Trip creation | `create-trip`, `create-trip-after-payment`, `scan-and-go` — **410** for cash |
| Payment switch | `switch-trip-payment-method` — **410** (retired) |
| Driver settings | `accept_cash = false`; toggle removed from UI |
| Cash completion RPC | `record_cash_trip_completion` raises exception |
| Driver confirm | `confirm-trip-payment` rejects new cash collection (410) |
| Dispatch | `accept_cash` removed from `auto-dispatch` query |
| Trip completion | `stop-workflow` — no new `CASH_*` ledger writes |
| Trip finalize | `finalize-trip-and-capture` — historical cash read-only; no `collected_cash` writes |
| No-show/cancel fees | `record-financial-outcome` — digital ledger only |
| Admin confirm | `admin-payment-detail` — **410** for cash trips; no `CASH_COMMISSION_DEBT` |
| Commission repair | `repair-commissions` — skips historical cash trips (all repos) |
| Statements/invoices | No new `cash_collected` line items or offsets |
| Customer UI | No cash in payment sheets; cash→card switch disabled |
| Admin UI | **Historical Legacy Trip** label; no cash reconciliation leg |
| Finance FR | Cash trips **excluded** from reconciliation partition |

## Supported payment flow (SSOT)

```
Customer Card / Mobile Wallet / Future gateways (Paystack, Flutterwave, Sifalo Pay, …)
  → PaymentIntent
  → Pre-authorisation
  → Manual Capture
  → Driver Ledger (TRIP_EARNING_NET)
  → Weekly Earnings
  → Scheduled Payout
  → Stripe Connect Transfer
  → Completed
```

## Files changed (complete list — git diff across repos)

### Customer app (`onecab-comfy-ride`)
- `shared/digitalFinanceSSOT.ts`
- `src/lib/tripCustomerActions.ts` — `canSwitchCashToCardOnTrip` always false
- `src/hooks/useServiceAreaPaymentMethods.ts` — digital-only flags
- `src/components/PaymentMethodSheet.tsx` — no cash option
- `src/pages/SelectVehicle.tsx`, `ScanAndGo.tsx`, `BookRide.tsx`
- `supabase/functions/create-ride/index.ts` — cash 410
- `supabase/functions/create-trip/index.ts` — cash 410
- `supabase/functions/create-trip-after-payment/index.ts` — cash 410; no `cash_enabled`
- `supabase/functions/switch-trip-payment-method/index.ts` — 410 retired
- `supabase/functions/scan-and-go/index.ts` — cash 410
- `supabase/functions/finalize-trip-and-capture/index.ts` — historical cash read-only
- `supabase/functions/_shared/resolveScanGoDriverSsot.ts`, `customerPaymentWorkflow.ts`

### Driver app (`drive-hub-buddy`)
- `supabase/functions/stop-workflow/index.ts` — no new cash ledger
- `supabase/functions/auto-dispatch/index.ts` — no `accept_cash`
- `supabase/functions/confirm-trip-payment/index.ts` — 410 for new cash
- `supabase/functions/repair-commissions/index.ts` — skip historical cash
- `supabase/functions/auto-generate-statements/index.ts` — no cash offset
- `supabase/functions/generate-driver-statement/index.ts` — digital earnings only
- `supabase/functions/driver-earnings-summary/index.ts` — no cash earnings bucket
- `supabase/functions/_shared/financialReconciliationSSOT.ts` — no `cash_reconciliation` leg
- `supabase/functions/_shared/driverWalletSummary.ts` — cash metrics zeroed
- `supabase/functions/_shared/serviceAreaConfigSSOT.ts` — `cash: false`
- `src/pages/Earnings.tsx`, `Settings.tsx`, `ConfirmPaymentScreen.tsx`

### Admin (`admin-new`)
- `supabase/functions/_shared/financialReconciliationSSOT.ts` — digital-only reconciliation
- `supabase/functions/_shared/financeSettlementSummary.ts`, `financeBackendAuditV1.ts`
- `supabase/functions/_shared/tripFinancialAuditStatus.ts`, `tripCaptureStatus.ts`
- `supabase/functions/_shared/driverStatementPeriodTotals.ts`, `driverInvoiceAggregation.ts`, `driverInvoiceService.ts`
- `supabase/functions/_shared/customerPaymentWorkflow.ts` — `cash: false`
- `supabase/functions/admin-finance-reconciliation/index.ts`
- `supabase/functions/admin-payment-detail/index.ts` — 410 + no cash ledger
- `supabase/functions/auto-generate-statements/index.ts`, `repair-commissions/index.ts`
- `supabase/functions/record-financial-outcome/index.ts`
- `src/pages/StatementRuns.tsx`, `TripHistory.tsx`, `FinancialReconciliation.tsx`
- `src/components/payment/ServiceAreaMobileWalletMethodsConfig.tsx`
- `supabase/migrations/20260705120000_digital_only_finance_ssot.sql`

## Cash workflows removed

| Workflow | After |
|----------|-------|
| New cash booking | **410 CASH_NOT_SUPPORTED** + DB trigger |
| Deferred booking via cash default | **Card deferred** via `create-ride` |
| Cash→card mid-trip switch | **410** + UI gate always false |
| Cash dispatch filter (`accept_cash`) | **Removed** |
| Driver cash collection | **410** on `confirm-trip-payment` |
| Cash commission debt on trip complete | **No new writes** |
| Admin cash payment confirm | **410** — no `CASH_COMMISSION_DEBT` |
| Cash commission repair/backfill | **Skipped** for historical cash trips |
| Cash reconciliation leg in FR API | **Removed** — card-only balanced check |
| Cash Collected / Cash outstanding labels | **Historical Legacy Trip** |
| Statement/invoice cash offset lines | **Removed** from generation |
| Driver wallet cash metrics | **Zeroed** (`weekly_cash_collected`, `cash_commission_due`) |
| Service area `cash_enabled` queries | **Removed** / always false |

## Remaining cash references (intentional only)

| Category | Examples | Why kept |
|----------|----------|----------|
| Historical DB rows | `trips.payment_method = 'cash'` | Audit trail — display only |
| Ledger history | `CASH_TRIP_EARNING`, `CASH_COMMISSION_DEBT` rows | Not deleted — read in transaction history |
| Generated types | `integrations/supabase/types.ts` | Schema columns retained for history |
| `collected_cash` payment_status | SSOT finalised set | Read-only legacy recognition |
| Card capture shortfall | `outstanding_shortfall_pence` | **Not cash** — Stripe under-capture |
| Early cashout / instant payout | `driver-early-cashout`, `EARLY_CASHOUT` | **Not passenger cash** |
| Ledger type constants | `onecabFinanceLedger.ts` exclusions | Historical row handling in balance math |
| Admin wallet detail | Displays historical `CASH_*` ledger rows | Read-only audit |
| RideTracking dead code | Cash switch sheets (never shown) | Inert — gate always false |
| Unit test fixtures | Historical `payment_method: "cash"` | Scenario coverage |
| FR metric fields | `cash_collected_by_driver_pence: 0` | API shape retained; always zero for new periods |

## Deploy checklist

1. Apply migration `20260705120000_digital_only_finance_ssot.sql` (if not already)
2. Deploy edge functions across all repos (booking, settlement, FR, statements, repair)
3. Deploy customer, driver, admin frontends
4. Verify: new booking cannot select cash; FR shows card-only balanced; historical cash trips show **Historical Legacy Trip**

## Confirmation

**Production finance SSOT is digital-only** for all new trips. Cash exists only as **historical read-only audit data** — never as an operational payment, settlement, reconciliation, or shortfall workflow.
