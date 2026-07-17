# P0 Africa Commission Wallet — Phase 8

**Status:** Live — **Banadir (Mogadishu)** is the sole enabled pilot Service Area.

Shared DB: `thazislrdkjpvvghtvzo`.

## What Phase 8 did

1. Enabled **only** Banadir (`29259edf-80eb-4c08-9089-352b8a305b81`):
   - `financial_model = DRIVER_COLLECTED_COMMISSION_WALLET`
   - `commission_wallet_enabled = true`
   - `commission_reserve_enabled = true` (dispatch gate + accept reserve)
   - `commission_wallet_currency = USD`
   - `commission_topup_provider = waafi_pay`
   - `customer_payment_policy = DRIVER_COLLECTS_UPFRONT`
2. Added `commission_wallet_rollout` singleton + trigger `enforce_commission_wallet_pilot_lock`
   - While `multi_sa_unlocked = false`, **no other SA** may enable wallet **or** adopt `DRIVER_COLLECTED_COMMISSION_WALLET`
3. Admin Pricing UI loads the rollout row and blocks enable on non-pilot SAs (toast + disabled switch)
4. SSOT: `COMMISSION_WALLET_PHASE8_PILOT`, `planCommissionWalletServiceAreaEnablement`, `shouldSkipPlatformPreauthForCommissionWallet`, `tripCashUpfrontPaymentFields`
5. Gap-close: Banadir cash-upfront booking (skip Stripe/Revolut), trip CW snapshot at create-ride, overview trip counts use snapshot flags, Banadir drivers get `commission_wallet_test_access`
6. Gap-close pass 2: booking readiness skips digital gates for CW; cash insert omits invalid `payment_reauth_status`; CTAP/Scan&Go reject CW card path; ManualTrip snapshots CW; finance-summary excludes CW from UK commissionable loop
7. Gap-close pass 3: fixed cash `navigateAfterBooking` args (instant → ride-tracking); SelectVehicle shows pay-driver-upfront notice; drive-hub `create-ride` synced to customer CW path
8. Gap-close pass 4:
   - `create-preauth-payment-intent` rejects CW with `CW_CASH_UPFRONT_REQUIRED`
   - Auto-grant `commission_wallet_test_access` when driver SA = pilot (DB trigger)
   - Clear Banadir `payment_provider` / digital payment method flags
   - ManualTrip forces cash-upfront for CW SAs
   - LP return writers + `create-trip-request` snapshot CW + cash fields
9. Gap-close pass 5 (full P0 gap audit):
   - Active CW reserve recalculates on fare/preset change (`RESERVE_ADJUSTED`)
   - Trip CW financial snapshot immutable once set
   - Driver cancel reason: **Upfront payment not received**
   - `create-ride` snapshots SA vehicle commission rate (not always 0)
   - Provider `payment.reversed` → `TOP_UP_REVERSAL` + bonus compensating debit
   - Customer `BookReturnRide` uses `create-ride` (CW cash / UK deferred card)
10. Gap-close pass 6:
   - BookReturnRide branches CW cash vs PLATFORM_COLLECTED deferred card (UK isolation)
   - Driver CW page shows offer eligibility + minimum balance
   - Admin top-up provider limited to `waafi_pay` (sandbox)
   - Secondary trip writers snapshot commission rate from vehicle pricing

## Hard rule

**Do not enable a second Service Area** until Banadir pilot reconciliation passes, then unlock:

```sql
UPDATE public.commission_wallet_rollout
SET
  multi_sa_unlocked = true,
  reconciliation_passed_at = now(),
  unlocked_at = now(),
  unlocked_note = 'Pilot reconciliation passed — multi-SA unlock',
  updated_at = now()
WHERE id IS TRUE;
```

## Pilot ops checklist

| Step | Action |
|------|--------|
| 1 | Confirm Admin → Banadir → Commission Wallet shows enabled + reserve on |
| 2 | Banadir drivers have `commission_wallet_test_access` (gap-close + pass4 auto-grant) |
| 3 | Admin-credit or Waafi sandbox top-up usable balance (reserve gate is on) |
| 4 | Customer Banadir pickup → cash-upfront create-ride (no card preauth) → dispatch → accept reserve → complete → `COMMISSION_DEDUCTION` |
| 5 | Reconcile CW Finance card (snapshot-filtered trips) vs ledger; UK Milton Keynes stays `PLATFORM_COLLECTED` |
| 6 | Only after PASS: unlock `multi_sa_unlocked` (SQL above) |

## Isolation

- Milton Keynes / Indonesia SAs remain `PLATFORM_COLLECTED` with wallet off (DB lock blocks Africa model adoption)
- UK `driver_wallet_ledger` / payouts unchanged when CW gate off
- Locked accept / preset client pipelines untouched

## Migrations

- `20260831900000_commission_wallet_phase8_pilot_banadir.sql`
- `20260831910000_commission_wallet_phase8_gap_close.sql` (synced ×3 repos)
- `20260831920000_commission_wallet_phase8_gap_close_pass4.sql` (synced ×3 repos)
- `20260831930000_commission_wallet_p0_gap_close_pass5.sql` (synced ×3 repos)

## Not Phase 8

Full Africa rollout, live Waafi production settlement, multi-SA enable, `COMMISSION_DEDUCTION_REVERSAL` admin tooling.
