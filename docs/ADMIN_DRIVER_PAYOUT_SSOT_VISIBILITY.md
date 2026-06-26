# Admin Driver Payout SSOT Visibility

**Status:** Implemented  
**Location:** Admin Panel → Financial Reconciliation → **Driver Payout SSOT / Stripe Connect Balance**  
**Edge function:** `admin-connect-payout-status`  
**Report date:** 2026-06-25

## Requirement

Admins must see **all payout balances** — never a single number in isolation. Each driver exposes ledger truth, Stripe Connect payout truth, and platform reconciliation truth, plus an explicit cash-out decision.

## SSOT formulas

| Field | Formula / source |
|-------|------------------|
| **Wallet owed** | `max(0, driver_wallet_ledger net balance)` |
| **Finance cleared** | `driver_available_now_pence` from per-driver finance reconciliation |
| **Connect available** | Stripe `balance.retrieve({ stripeAccount })` → `available` for driver currency |
| **Cash out now** | `min(wallet owed, finance cleared, Connect available)` |
| **Awaiting settlement** | `max(0, wallet owed − Connect available)` |
| **Platform balance** | ONECAB platform Stripe `balance.available` — **reconciliation only**, not cash-out cap |

### Example (MK0001)

- Ledger owed: **£9.73**
- Stripe Connect instantly available: **£21.30**
- Cash-out available now: **£9.73** (ledger is the binding cap)
- Awaiting settlement: **£0**

Admin copy:

> Driver is owed £9.73. Stripe Connect has £21.30 instantly available. Cash-out available now: £9.73.

## UI sections (per driver)

### 1. ONECAB Wallet Ledger

| Field | Source |
|-------|--------|
| Driver earned / owed | `max(0, ledger balance)` |
| Ledger balance (signed) | Sum of `driver_wallet_ledger` |
| Trip earnings | `TRIP_EARNING_NET`, `DRIVER_TIP_CREDIT`, `CASH_TRIP_EARNING` |
| Debt recovery | `DEBT_RECOVERY`, `CASH_COMMISSION_DEBT` |
| Adjustments | `ADJUSTMENT`, `MANUAL_ADJUSTMENT`, `BONUS`, `CHARGEBACK_DEBIT` |

### 2. Stripe Connect Balance

| Field | Source |
|-------|--------|
| Connected account ID | `drivers.stripe_account_id` |
| Account type | Stripe `account.type` (Express / Standard / Custom) |
| Payouts enabled | Stripe `account.payouts_enabled` |
| Available to pay out | Connect `balance.available` |
| Instant available | Connect available when payouts enabled |
| Available soon / pending | Connect `balance.pending` |
| In transit to bank | Sum of Connect payouts with status `in_transit` |
| Last payout | Latest `payout_items` with `stripe_payout_id` |
| Next payout date | Finance SSOT weekly schedule |

### 3. Platform Reconciliation

| Field | Source |
|-------|--------|
| Platform Stripe available | Platform `balance.available` |
| Platform pending | Platform `balance.pending` |
| Allocated to driver | Finance allocation by liability |
| Application fees | `digital_onecab_net_commission_pence` |
| Transfers to Connect | Count/sum of `payout_items` with `stripe_transfer_id` |
| Provider settlement evidence | Reconciliation status + variance |

### 4. Cash-out Decision

Shows wallet owed, finance cleared, Connect available, cash out now, awaiting settlement, and block reasons when disabled.

Minimum cash-out: **£5.00** (`MIN_CASHOUT_AMOUNT_PENCE = 500`).

## Files changed

| File | Purpose |
|------|---------|
| `supabase/functions/admin-connect-payout-status/index.ts` | Full SSOT payload per driver |
| `supabase/functions/_shared/driverWalletSettlementSSOT.ts` | Connect-based cash-out formulas |
| `supabase/functions/_shared/connectPayoutLockdown.ts` | Currency-aware Connect balance read |
| `src/components/finance/ConnectBalancePanel.tsx` | Overview table + SSOT detail entry |
| `src/components/finance/DriverPayoutSsotDetailPanel.tsx` | Four-section detail panel |
| `src/hooks/useConnectPayoutStatus.ts` | Extended types |
| `src/lib/driverPayoutSsot.ts` | Client SSOT helpers + admin copy |
| `src/pages/FinancialReconciliation.tsx` | Tab label |
| `src/lib/__tests__/driverPayoutSsot.test.ts` | MK0001 regression test |

## API response shape (per driver)

```json
{
  "onecab_wallet": { "driver_earned_owed_pence", "ledger_balance_pence", "trip_earnings_pence", ... },
  "stripe_connect": { "available_to_payout_pence", "instant_available_pence", "pending_pence", ... },
  "platform_reconciliation": { "platform_available_pence", "application_fees_pence", ... },
  "cashout_decision": { "cashout_now_pence", "awaiting_settlement_pence", "block_reasons", ... }
}
```

Flat fields (`cashout_now_pence`, `wallet_owed_pence`, etc.) are duplicated for table sorting and backward compatibility.

## Deployment

```bash
cd admin-new
supabase functions deploy admin-connect-payout-status
```

## Verification checklist

- [ ] Open Financial Reconciliation → Driver Payout SSOT / Stripe Connect Balance
- [ ] Each driver row shows ledger owed, finance cleared, Connect available, cash out now
- [ ] SSOT detail shows all four sections
- [ ] MK0001: cash out £9.73 when Connect £21.30 and ledger £9.73
- [ ] Awaiting settlement uses `ledger − Connect`, not `ledger − finance cleared`
- [ ] Platform balances visible but not presented as driver cash-out cap

## Alignment with driver app

Driver wallet (`drive-hub-buddy`) uses the same Connect-based SSOT:

- `shared/driverWalletSettlementSSOT.ts`
- `finance-reconciliation-driver` edge function
- `driver-early-cashout` gates on Connect executable amount

Admin panel mirrors these formulas for operational visibility and support.
