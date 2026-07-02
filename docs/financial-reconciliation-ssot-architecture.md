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
| Platform KPIs | `platform_kpis` block on `admin-finance-reconciliation` response |
| Badge | `src/components/finance/FinanceSSOTBadge.tsx` — `LIVE` / `DEGRADED_SNAPSHOT` / `UNAVAILABLE` |

## Admin finance pages (two SSOT surfaces only)

- **Driver Wallet Ledger** (`/driver-wallet-ledger`) — per-driver wallet, ledger, payouts, Stripe, history
- **Financial Reconciliation** (`/financial-reconciliation`) — platform overview, trips, drivers, Stripe, alerts

Legacy routes (`/payments`, `/payout-batches`, `/driver-wallet`, etc.) redirect to the above.

## Degraded mode (G-07)

1. **LIVE** — `admin-finance-reconciliation` edge function
2. **DEGRADED_SNAPSHOT** — last persisted browser snapshot (read-only; actions disabled)
3. **UNAVAILABLE** — no live data and no snapshot

No SUMMARY / LEDGER / RECONSTRUCTED client fallbacks on Financial Reconciliation.

## Rules for developers

No page may calculate locally:

- commission
- driver liability
- available payout
- pending payout
- net commission

Use `FinanceSSOT.*` accessors from `useFinancialReconciliationSSOT`.
