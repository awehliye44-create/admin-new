# ONECAB Driver Payout SSOT — Instant Only (Final Business Decision)

**Date:** 2026-06-26  
**Status:** Authoritative business rule

## Core rule

**ONECAB only pays drivers using Stripe Instant Payouts.**

There is no Standard payout execution in ONECAB.

| Flow | Who starts | Stripe method |
|------|------------|---------------|
| Weekly automatic payout | Scheduler | `instant` |
| Manual instant cash-out | Driver or optional admin | `instant` |

## Display vs execution (SSOT)

| Layer | Standard Available | Instant Available |
|-------|-------------------|-------------------|
| **Display** | Yes — `balance.available` | Yes — `balance.instant_available` |
| **Execution** | Never | Always |

Operations must see **both** balances to understand cases where Instant Available exceeds Standard Available (e.g. card balance eligible for instant before standard schedule).

### Formulas

```
cashout_now = min(ONECAB wallet owed, finance cleared, Stripe Instant Available)
awaiting_settlement = max(0, ledger owed − Stripe Standard Available)
weekly_instant_eligible = cashout_now
manual_instant_eligible = min(wallet, finance cleared, Stripe Instant Available)
```

## Admin surfaces

### Financial Reconciliation (overview only)

Per-driver read-only table:

- ONECAB Wallet Balance
- Finance Cleared
- Stripe Standard Available
- Stripe Instant Available
- Stripe Pending / Available Soon
- Weekly Instant Payout Eligible
- Manual Instant Cash-Out Eligible
- Last Stripe Sync
- Last Instant Payout
- Next Weekly Instant Payout

**No payout buttons** on this page.

### Payouts & Ledger Audit (actions only)

- Weekly Instant Payout batch records
- Manual Instant Cash Out (admin optional)
- Ledger audit
- Stripe Connect detail + **Instant cash out** action

## Driver app

Driver sees:

- Wallet Balance
- **Cash Out Instantly**
- ONECAB Cash-Out Fee: **£1.00**
- Net To Bank

No Standard payout option anywhere.

## Audit fields (every payout record)

| Field | Values / notes |
|-------|----------------|
| `payout_type` | `weekly_auto`, `manual_cashout` |
| `stripe_method` | always `instant` |
| `stripe_payout_id` | Stripe payout ID |
| `wallet_before_pence` | Ledger before debit |
| `wallet_after_pence` | Ledger after debit |
| `stripe_instant_available_before_pence` | Connect instant balance at send |
| `onecab_fee_pence` / `onecab_cashout_fee_pence` | ONECAB fee (£1.00 cash-out) |
| `stripe_fee_pence` | Stripe instant fee when known |
| `driver_receives_pence` / `net_driver_payout_pence` | Net to driver |

Migration: `20260826120000_instant_payout_audit_fields.sql`

## Implementation map

| Component | Path |
|-----------|------|
| Connect balance read (standard + instant) | `admin-new/supabase/functions/_shared/connectPayoutLockdown.ts` |
| SSOT status API | `admin-new/supabase/functions/admin-connect-payout-status/` |
| Admin instant cash-out | `admin-new/supabase/functions/admin-driver-connect-payout/` |
| Driver instant cash-out | `drive-hub-buddy/supabase/functions/driver-early-cashout/` |
| FR overview (read-only) | `FinancialReconciliation.tsx` → `ConnectBalancePanel readOnly` |
| Payout actions | `AdminPayoutBatches.tsx` → Connect tab |
| Fee constant | `ONECAB_CASHOUT_FEE_PENCE = 100` |

## Stripe dashboard reference

Stripe Connect may show:

- **Available to pay out** (standard schedule) — lower
- **Instantly available** (modal) — often higher for card-funded balance

ONECAB uses **Instant Available** for execution while displaying **Standard Available** for settlement transparency.
