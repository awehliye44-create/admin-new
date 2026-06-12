# finance_backend_audit_v1 — Backend money audit

**Date:** 2026-06-11  
**Scope:** Backend audit only (no driver wallet UI changes).

---

## Purpose

Answer before any UI work:

1. What money came in?
2. What money has been paid out?
3. What money is remaining?
4. Who owns the remaining money?

---

## Implementation

| Component | Path |
|-----------|------|
| Audit builder (SSOT logic) | `supabase/functions/_shared/financeBackendAuditV1.ts` |
| Edge function | `supabase/functions/finance-backend-audit-v1/index.ts` |
| Admin page section | `src/pages/FinancialReconciliation.tsx` |
| React hook | `src/hooks/useFinanceBackendAudit.ts` |
| Tests | `supabase/functions/_shared/financeBackendAuditV1.test.ts` |

**Invoke:** `GET finance-backend-audit-v1?region_id=…&from=…&to=…&driver_id=…` (admin JWT).

**Response root:** `{ finance_backend_audit_v1: { … } }`

---

## Accounting rules enforced

| Rule | Implementation |
|------|----------------|
| Successful payout → negative ledger | `critical_checks.successful_payout_creates_negative_ledger`; payout rows show `ledger_entry_created` |
| Failed payout must not reduce wallet | Failed `payout_items` must have `ledger_entry_id` null |
| Provider available ≠ ONECAB commission | `onecab_remaining_commission_pence` from trip `onecab_net_pence` sum |
| Wallet ≠ available payout | `driver_available_now_pence = min(remaining_liability, provider_available)` |
| Remaining liability | `driver_net_earnings - ledger_payout_debits + adjustments` |

---

## £42.08 after £41.16 paid — root cause model

If `payout_items.status = completed` but **no** matching `driver_wallet_ledger` debit (`PAYOUT` / `WEEKLY_PAYOUT` / `EARLY_CASHOUT` with `amount_pence = -4116`):

- `driver_wallets.available_pence` stays at **4208** (trip earning never offset)
- `paid_out.driver_paid_out_total_pence` stays **0** (ledger is SSOT for paid out)
- Audit flags **FAIL** on `successful_payout_creates_negative_ledger`
- `wallet_integrity` explains: *"Completed payout(s) totalling 4116p have no matching negative driver_wallet_ledger entry"*

**Fix path (ops, not UI):** Insert missing ledger debit or re-run payout via `admin-driver-payout` (which writes ledger on successful Stripe transfer).

---

## Questions A–K (in `answered_questions`)

| Key | Question |
|-----|----------|
| A | Total customer paid |
| B | Total refunded |
| C | Net collected |
| D | Driver paid out (ledger debits) |
| E | ONECAB paid to bank (Stripe platform payouts) |
| F | Still owed to drivers |
| G | Available for payout now |
| H | Pending settlement |
| I | True ONECAB commission (net) |
| J | Provider processing fees |
| K | Wallet vs payout diagnosis |

---

## Reconciliation equation

```
net_customer_money_in
  = driver_paid_out_total
  + driver_remaining_liability
  + onecab_net_commission
  + provider_processing_fees
  + adjustments
```

If `|difference| > tolerance` → `reconciliation_status = "MISMATCH"`.

---

## Deploy

```bash
cd admin-new
supabase functions deploy finance-backend-audit-v1
```

View in admin: **Financial Reconciliation** → `finance_backend_audit_v1` section.
