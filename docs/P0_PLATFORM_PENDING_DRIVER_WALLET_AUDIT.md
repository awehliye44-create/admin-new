# P0 Audit — Platform Pending £56.43 vs Driver Wallet vs Trips Tab

**Date:** 2026-07-05 · **Prod:** `thazislrdkjpvvghtvzo` · **Region:** Milton Keynes

## 1. What makes up Platform Stripe Pending (£56.43)?

**Source:** `stripe.balance.retrieve().pending` on the **ONECAB platform account** (GBP).

| Field | Value |
|-------|-------|
| Platform Stripe Pending | **£56.43** |
| Platform Stripe Available | **£0.00** |
| Finance era | **digital** |

Not driver Connect balance. Not driver weekly earnings. Stripe settlement queue on the platform merchant account.

## 2. Trips / payments involved

Stripe `pending` is aggregate — not trip-level in FR overview. Recent captures likely contributing include MK-260704-002 (£12.65 + £17.42), MK-260702-009, MK-260702-008.

Driver ledger (separate): MK0002 TRIP_EARNING_NET £14.98 on MK-260704-002.

## 3. Why Next Weekly Transfer = £0.00

- Pending payout_item: £14.98 (MK0002, MK-260704-002)
- No payout_batches in pending/processing
- Platform Stripe Available = £0 → Connect transfer waits on settlement

## 4. Settlement vs batch

Ledger credited → payout item pending → platform funds still in Stripe pending → batch not paid.

## 5. Trips tab zero

Fixed: date normalization, audit_limit 10k, default 7-day range. Prod now shows **29 trips** for Jun–Jul MK.

## 6. Legacy cash labels

`finance_era=digital` in prod. UI updated to hide migration CTA and explain platform pending separately.
