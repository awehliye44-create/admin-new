# Financial Reconciliation SSOT Architecture

**Superseded by:** [DIGITAL_FINANCE_SSOT_ARCHITECTURE.md](./DIGITAL_FINANCE_SSOT_ARCHITECTURE.md) (canonical, non-negotiable)

**Version:** `financial_reconciliation_ssot_v2`  
**Date:** 2026-07-02

## Principle

Financial Reconciliation **audits** that ONECAB Platform provider and Revolut Merchant match the platform ledger. It does **not** calculate trip earnings, commission, or driver net — that is **Trip Settlement SSOT** (Trip History + Finance Recovery).

## What Financial Reconciliation owns

- Platform provider available/pending balances
- Incoming card settlements (provider payment intents)
- provider fees and money movement
- Driver provider transfers and platform bank payouts
- Failed/pending transfers, webhook health, sync status
- Reconciliation PASS / FAIL

## What Financial Reconciliation must never display

- Trip fare, discounts, commission, driver net earnings
- Wallet balance, Finance Cleared, recovery debt, cash metrics
- Per-trip settlement calculations (use Trip History)

## Admin surface

| Tab | Purpose |
|-----|---------|
| Overview | Platform provider + sync KPIs |
| Drivers | Revolut Merchant positions per driver |
| provider | Platform balance, transfers, payouts |
| Alerts | Backend audit failures |

Legacy `?tab=trips` redirects to `/trip-history`.

## Implementation

| Layer | Path |
|-------|------|
| provider audit assembly | `supabase/functions/_shared/financialReconciliationSSOT.ts` |
| Admin edge fn | `supabase/functions/admin-finance-reconciliation/index.ts` |
| Admin hook | `src/hooks/useFinancialReconciliationSSOT.ts` |
| Trip settlement (calculations) | Trip History, `tripSettlementFinanceSSOT.ts`, Finance Recovery |

## Degraded mode

1. **LIVE** — edge function
2. **DEGRADED_SNAPSHOT** — cached snapshot (read-only)
3. **UNAVAILABLE** — no data

## Related SSOT pages

- **Trip Settlement** — `/trip-history` (only page that calculates trip money)
- **Driver Wallet Ledger** — `/driver-wallet-ledger` (Revolut Merchant read-only per driver)
