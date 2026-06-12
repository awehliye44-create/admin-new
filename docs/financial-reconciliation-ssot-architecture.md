# Financial Reconciliation SSOT Architecture

**Version:** `financial_reconciliation_ssot_v1`  
**Date:** 2026-06-11

## Principle

Financial Reconciliation is the **source of truth for calculations and reporting**.

It is **not** the raw data store. It calculates from canonical backend sources and publishes official values used by all apps and admin pages.

## Canonical data sources

| Metric | Source |
|--------|--------|
| Customer revenue | `payments.captured_amount_pence` → `trips.capture` → `trips.final_fare` |
| Refunds | `trips.refund_amount_pence` |
| ONECAB gross commission | `sum(trips.commission_pence)` only |
| Provider fees | `sum(trips.stripe_processing_fee_pence)` |
| Driver paid out | `driver_wallet_ledger` payout debits |
| Provider balances | Stripe balance API (cash position only) |

**Forbidden:** Using `provider_available_balance` or `driver_liability` as commission.

## Reconciliation equations

**Period reports (date filter active):**

```
net_customer_revenue = driver_net_earnings + onecab_gross_commission
```

**Cash / wallet (lifetime; adjustments already inside remaining liability):**

```
net_customer_revenue
  = driver_paid_out
  + driver_remaining_liability
  + onecab_net_commission
  + provider_processing_fee
```

If not equal → `RECONCILIATION_MISMATCH` + variance amount.

## Implementation

| Layer | Path |
|-------|------|
| SSOT formulas | `supabase/functions/_shared/financialReconciliationSSOT.ts` |
| Payload assembly | `supabase/functions/_shared/financeSettlementSummary.ts` |
| Admin edge fn | `supabase/functions/admin-finance-reconciliation/index.ts` |
| Driver edge fn | `drive-hub-buddy/.../finance-reconciliation-driver/index.ts` |
| Admin hook | `src/hooks/useFinancialReconciliationSSOT.ts` |
| Badge | `src/components/finance/FinanceSSOTBadge.tsx` |
| Totals cards | `src/components/finance/FinanceReconciliationTotalsCards.tsx` |

## Pages using SSOT (read-only)

- Financial Reconciliation (`LIVE`)
- Dashboard commission widgets (`LIVE` via `useFinanceReconciliationRevenue`)
- Payments & Transactions (`FinanceReconciliationTotalsCards`)
- Payout Batches & Audit (`FinanceReconciliationTotalsCards`)
- Driver app (`finance-reconciliation-driver` — deploy separately)

## Fallback hierarchy

1. **LIVE** — `admin-finance-reconciliation`
2. **SUMMARY** — `driver_financial_summary` aggregate
3. **LEDGER** — raw ledger (future)
4. **RECONSTRUCTED** — historical payout reconstruction (future)

Badge shown on all finance surfaces.

## Rules for developers

No page may calculate locally:

- commission
- driver liability
- available payout
- pending payout
- net commission

Use `FinanceSSOT.*` accessors from `useFinancialReconciliationSSOT`.
