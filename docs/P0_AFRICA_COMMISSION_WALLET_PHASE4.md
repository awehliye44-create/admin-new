# P0 Africa Commission Wallet — Phase 4

**Status:** Delivered (Waafi-shaped sandbox top-up + automatic confirmation).

Primary driver repo: `drive-hub-buddy`. Shared DB: `thazislrdkjpvvghtvzo`.

## Scope (done)

- SSOT: `planCommissionWalletTopupInitiate`, `planCommissionWalletTopupConfirm`, status transitions, idempotency keys
- Edges:
  - `driver-commission-wallet-initiate-topup` — JWT driver; sandbox create + auto-confirm
  - `commission-wallet-topup-webhook` — HMAC Waafi-shaped events (replay / real path)
- Ledger: `TOP_UP_CREDIT` with `purchased_portion_minor = amount` (never `driver_wallet_ledger`)
- Tables: `driver_commission_wallet_topups` (`PENDING` → `PROCESSING` → `SUCCEEDED`)
- Driver UI: Top-up card when `topup_enabled` (workflow + test access + `commission_topup_provider=waafi_pay`)
- Admin overview: Recent top-ups table
- Provider: `waafi_pay` sandbox only (Phase 1 Mogadishu SSOT)

## Isolation

- PLATFORM_COLLECTED / UK `/wallet` unchanged
- Non-test drivers cannot top up
- Booking Stripe/Revolut adapters untouched
- Dispatch reserve / campaigns / trip deduction still off

## Enable pilot top-up

1. SA: `DRIVER_COLLECTED_COMMISSION_WALLET` + `commission_wallet_enabled` + `commission_topup_provider = waafi_pay`
2. Driver: `commission_wallet_test_access = true` (Admin Commission Wallet toggle)
3. Driver app → Commission Wallet → Top up (sandbox auto-confirms)

## Webhook (optional replay)

`POST /functions/v1/commission-wallet-topup-webhook`  
Header: `x-waafi-signature` = hex HMAC-SHA256 of raw body  
Secret (required — fail closed if missing): vault `waafi_pay` test `webhook_secret`, or env `WAAFI_PAY_WEBHOOK_SECRET` / `COMMISSION_WALLET_TOPUP_SANDBOX_WEBHOOK_SECRET`.

## Not Phase 4

Campaigns, dispatch reserve, trip deduction, finance revenue, live Waafi production API, Paystack/Flutterwave, full Africa rollout.
