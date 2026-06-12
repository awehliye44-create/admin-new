# P0 — Missing payout ledger debit fix

**Date:** 2026-06-11  
**Driver:** Ahmed Osman (`58b29f86-6cf9-4492-b971-d17d8e0456c7`)

## Root cause

Provider bank payout `po_1TgwCxImYgLhqfX02AUIfT8F` for **4116p (£41.16)** succeeded, but no matching `driver_wallet_ledger` debit was written. Wallet cache stayed at **4208p (£42.08)**.

## Fix applied

1. Migration `20260611120000_p0_payout_ledger_sync_fix.sql`
   - `ledger_sync_failed` payout status
   - Idempotent ledger indexes (`stripe_payout_id`, `stripe_transfer_id`)
   - `sync_payout_item_ledger_debit()` RPC
   - `insert_payout_ledger_debit_if_missing()` RPC

2. `admin-driver-payout` — completion requires: Stripe OK → ledger debit → `recalculate_driver_wallet`

3. `admin-sync-payout-ledger` — retry by `payout_item_id` or discover orphan **bank payouts** on connected account

4. Backfill (prod):
   - Inserted `WEEKLY_PAYOUT` **-4116p** linked to `po_1TgwCxImYgLhqfX02AUIfT8F`
   - Recalculated wallet

## Result

| Metric | Before | After |
|--------|--------|-------|
| Wallet available | £42.08 (4208p) | **£0.92 (92p)** |
| Paid out (ledger) | £7.77 early cashout only | **+£41.16 weekly payout** |
| Ledger debit for £41.16 | Missing | **Yes** (`07901b90-…`) |

Equation: `4208 - 4116 = 92` ✓

## Admin UI

- **Payout Batches** — per-item: Sent to bank, Provider payout ID, Ledger debit, Wallet recalc, Reconciliation, Retry ledger
- **Financial Reconciliation** — CRITICAL alert when provider paid but ledger missing

## Driver app

`driver-wallet-summary` reads ledger SSOT; realtime refresh on `driver_wallet_ledger` + `driver_wallets` updates.

Expected display after refresh:
- Available Now: **£0.92**
- Paid Out: **£41.16** (+ prior £7.77 early cashout in lifetime)
- Lifetime Earnings: unchanged
