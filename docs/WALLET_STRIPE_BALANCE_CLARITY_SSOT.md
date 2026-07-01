# Wallet + Financial Reconciliation — Stripe Balance Clarity SSOT

## Rule

Three sources must never be mixed in copy or payout gates:

| Bucket | SSOT source | Meaning |
|--------|-------------|---------|
| Driver earned / wallet balance | `driver_wallet_ledger` | What ONECAB owes the driver |
| Stripe Connect standard available | Stripe `balance.available` | Scheduled weekly payout cash evidence |
| Stripe Connect instant available | Stripe `balance.instant_available` | Instant Early Cash Out execution cap |
| Awaiting settlement | `max(0, wallet − standard)` | Earned but not yet on Connect for payout |

Financial Reconciliation remains the **accounting SSOT**. Stripe balances are **cash availability evidence**.

---

## Backend fields (`finance-reconciliation-driver`)

Explicit fields returned (no client guessing):

- `wallet_balance_pence`
- `stripe_connect_available_pence` (standard)
- `stripe_connect_pending_pence`
- `stripe_instant_available_pence`
- `scheduled_payout_available_pence`
- `effective_cashout_available_pence` (instant cap when allowed)
- `awaiting_settlement_pence`
- `instant_payout_enabled_by_stripe` — from `admin_settings.stripe_instant_payouts_enabled` (default **false**)
- `early_cashout_enabled_by_service_area` — from `service_areas.early_cashout_enabled`
- `instant_cashout_status` — `available` | `disabled_by_service_area` | `not_enabled_by_stripe` | `awaiting_settlement` | `below_minimum_cashout` | `blocked` | `unavailable`
- `cashout_block_reason`
- `cashout_status_message`
- `settlement_summary_line` — e.g. `£9.73 earned · £4.08 settled · funds awaiting settlement.`

Shared computation: `shared/walletCashAvailabilitySSOT.ts`

---

## Driver app display

`WalletBalanceGrid` shows four separate cards:

1. **Wallet balance** — ledger
2. **Available for scheduled payout** — Stripe standard cap
3. **Available for instant cash out** — instant cap + status message
4. **Awaiting settlement** — when > 0

Instant Cash Out **button** only when:

- `early_cashout_enabled_by_service_area = true`
- `instant_payout_enabled_by_stripe = true`
- `instant_cashout_status = available`
- amount ≥ minimum cash-out

Never shows “Instant Cash Out available now” unless all gates pass.

---

## Admin Financial Reconciliation

`DriverPayoutSsotDetailPanel` labels updated:

- Stripe Connect **standard** vs **instant** balances shown separately
- Cash-out decision documents scheduled vs instant caps
- Ledger balance labelled separately from Stripe figures

---

## Platform instant payouts

Until Stripe enables Instant Payouts for ONECAB:

```sql
-- default absent/false — no migration required; code defaults false
SELECT setting_value FROM admin_settings WHERE setting_key = 'stripe_instant_payouts_enabled';
```

When Stripe enables the platform, ops sets `stripe_instant_payouts_enabled = true` in admin settings **and** enables per-service-area Early Cash Out toggles.

---

## Affected files

| Area | File |
|------|------|
| Shared SSOT | `drive-hub-buddy/shared/walletCashAvailabilitySSOT.ts` |
| Edge | `drive-hub-buddy/supabase/functions/finance-reconciliation-driver/index.ts` |
| Edge shared | `drive-hub-buddy/supabase/functions/_shared/connectPayoutLockdown.ts` |
| Driver model | `drive-hub-buddy/src/lib/driverWalletSummaryModel.ts` |
| Driver UI | `drive-hub-buddy/src/components/wallet/WalletBalanceGrid.tsx` |
| Driver UI | `drive-hub-buddy/src/pages/Wallet.tsx` |
| Admin UI | `admin-new/src/components/finance/DriverPayoutSsotDetailPanel.tsx` |
| Tests | `drive-hub-buddy/src/lib/__tests__/walletCashAvailabilitySSOT.test.ts` |

---

## Acceptance scenarios

1. Wallet £9.73, Stripe instant disabled → earned shown, instant £0.00, message explains platform not ready  
2. Wallet £9.73, Stripe standard £4.08 → awaiting settlement £5.65, settlement summary line shown  
3. Service area toggle OFF → scheduled payout unaffected, instant disabled with area message  
4. Future: platform + area ON + instant ≥ min → instant card shows available, button enabled  
5. Admin reconciliation → ledger vs Stripe standard vs instant shown separately  
