# Phase 3D.2 — Provider Available Audit

**Date:** 2026-06-18  
**Priority:** Read-only audit  
**Project:** `thazislrdkjpvvghtvzo` (prod)  
**Region:** MK (`7f611e59-a9e5-42c2-b65a-61376910bb5d`)

---

## Executive summary

**Provider Available (£6.66)** is the live **Stripe platform account** `balance.available` for GBP. It is **not** sourced from database tables, driver wallets, or remaining liability. The UI labels it correctly: *“Pending £1.13 — cash position only”*.

It does **not** reconcile to driver liability (£0.00), wallet balances (−£25.78 aggregate), or the BALANCED card/cash ledger check — by design. Those metrics use different scopes and formulas.

**GO/NO-GO on whether £6.66 blocks first controlled payout approval:**  
**No — £6.66 does not block approval** as a payout-safety issue. `driver_available_now` is **£0.00** (no payable liability), payout execution remains locked (3D.1), and both MK drivers have negative wallets. First controlled payout remains **NO-GO** for other reasons documented in Phase 3D.1, not because £6.66 exists.

---

## Production state verified (read-only)

| Metric | Value | Source |
|--------|-------|--------|
| Provider Available | **£6.66** (666p) | Stripe `balance.available[gbp]` |
| Provider Pending | **£1.13** (113p) | Stripe `balance.pending[gbp]` |
| Driver Available Now | £0.00 | `min(remaining_liability, provider_available)` |
| Remaining liability (UI period) | £0.00 | Period-scoped ledger SSOT |
| Reconciliation status | BALANCED | Period card/cash split equation |
| MK0001 wallet | −£2.78 | All-time ledger SSOT |
| MK0002 wallet | −£23.00 | All-time ledger SSOT |
| Wallet aggregate (MK) | −£25.78 | `driver_financial_summary` |
| Driver paid out (all-time MK) | £67.16 | Ledger payout debits |

Machine output: `docs/phase3d2-provider-available-audit-output.json`  
Script: `scripts/phase3d2-provider-available-audit.ts`

---

## 1. Source query for Provider Available

### Primary code path

**Edge function:** `admin-finance-reconciliation`  
**File:** `supabase/functions/admin-finance-reconciliation/index.ts`

```typescript
const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
const balance = await stripe.balance.retrieve();
stripeAvailablePence = balance.available.find((b) => b.currency === currency)?.amount ?? 0;
stripePendingPence = balance.pending.find((b) => b.currency === currency)?.amount ?? 0;
```

- **API:** Stripe `GET /v1/balance` via `stripe.balance.retrieve()`
- **Account:** ONECAB **platform** Stripe account (not Connect connected accounts)
- **Currency:** Resolved from `regions.currency_code` when `region_id` is set (MK → GBP)
- **Region scope:** Currency only — **balance is global platform cash**, not filtered to MK trips or drivers

### Passthrough to UI

1. `computeSSOTMetrics()` — `financialReconciliationSSOT.ts` lines 515–516  
   → `provider_available_balance_pence: args.providerAvailableBalancePence` (no transformation)

2. `buildFinanceReconciliationSummary()` — `financeSettlementSummary.ts` lines 548–551  
   → `provider_money.provider_available_balance_pence`

3. **UI:** `FinanceReconciliationTotalsCards.tsx` lines 98–107  
   → `FinanceSSOT.providerAvailableBalance(summary)`  
   → Subtitle: `Pending {provider_pending} — cash position only`

### Secondary path (audit page)

**Edge function:** `finance-backend-audit-v1` — identical `stripe.balance.retrieve()` call (lines 271–275), exposed as `incoming_money.provider_available_balance_pence`.

### Architecture documentation

`docs/financial-reconciliation-ssot-architecture.md`:

| Metric | Source |
|--------|--------|
| Provider balances | Stripe balance API (**cash position only**) |

**Forbidden:** Using `provider_available_balance` as commission or driver liability.

---

## 2. Tables and balances contributing to £6.66

### Direct contributors

| Source | Contributes? | Notes |
|--------|--------------|-------|
| Stripe `balance.available[gbp]` | **Yes — sole source of £6.66** | Live platform cash |
| Stripe `balance.pending[gbp]` | **Separate (£1.13)** | Shown in subtitle, not added to £6.66 |
| `payments` | No | Used for card revenue, not provider available |
| `driver_wallet_ledger` | No | Used for paid-out / liability, not provider available |
| `payout_items` | No | Used for pending payout sums elsewhere |
| `driver_financial_summary` | No | Wallet display only |
| `trips` | No | Commission/revenue only |

### Related MK all-time figures (context, not summed into £6.66)

| Metric | Pence | GBP |
|--------|-------|-----|
| Card customer revenue | 10,744 | £107.44 |
| Card driver payable | 9,232 | £92.32 |
| ONECAB card commission | 1,612 | £16.12 |
| ONECAB net platform revenue | 4,855 | £48.55 |
| Driver paid out (ledger debits) | 6,716 | £67.16 |
| Wallet aggregate | −2,578 | −£25.78 |

£6.66 is **not** `card_revenue − payouts` or `commission − bank sweep`. It is whatever Stripe currently holds as **available** on the platform account after captures, Connect transfers, fees, and platform payouts.

### Unallocated platform cash formula (legacy settlement mapping)

`useFinanceReconciliation.ts` → `toSettlementOverviewResponse()`:

```
unallocated_platform_cash_pence =
  provider_available_balance_pence
  − driver_payout_liability_pence
  − in_flight_cashout_pence
```

With current values: `666 − 0 − 0 = **666p (£6.66)**` — entire displayed balance is “unallocated” relative to driver liability.

---

## 3. What £6.66 represents

| Category | Applies? | Evidence |
|----------|----------|----------|
| **Pending Stripe balance** | Partially | £1.13 is **pending** (not yet available). £6.66 is the **available** portion only. |
| **Platform balance** | **Yes** | Direct read of platform `balance.available`. |
| **Reserved funds** | No | No Connect reserve / application_fee_balance in this query. |
| **Orphaned provider funds (driver-owed)** | **No** | `driver_remaining_liability = 0`; `allocateProviderBalanceByLiability()` would assign **0p** to each driver. |
| **Payout timing difference** | **Partially** | Recent card captures and settlement lag can leave cash on platform before Connect transfer or bank sweep; £1.13 pending supports timing component. |

### Likely composition (inferred, not Stripe line-item traced)

1. **ONECAB platform revenue residue** — gross card commission £16.12; only £6.66 available suggests most commission/fees already moved, paid to bank, or offset by transfers/payouts.
2. **Unsettled / recently-captured card funds** — £1.13 still pending on platform.
3. **Not driver payout float** — `driver_available_now = min(0, 666) = 0`; negative wallets block payout eligibility independently.

### UI scope mismatch (why BALANCED + £6.66 + negative wallets coexist)

| Metric | Scope |
|--------|-------|
| Provider Available | **Global** Stripe platform balance (always live) |
| Remaining liability / BALANCED | **Period-filtered** (Driver Wallet page defaults to **today UTC** when no dates passed) |
| Driver wallet column | **All-time** `driver_financial_summary` / ledger SSOT |

Today’s period ledger for MK is dominated by **payout debits** (£67.16) without same-day trip earnings rows → `perDriverLedgerLiabilityPence()` → `max(0, period_ledger_sum) = **0**`.  
All-time wallets remain negative from historical over-payouts and MK0002 Option 3 remediation.

---

## 4. What £6.66 should reconcile to

| Bucket | Should £6.66 map here? | Verdict |
|--------|------------------------|---------|
| Driver liability | No | Liability is 0; wallets negative |
| Platform revenue | **Informational overlap** | Plausible subset of ONECAB net commission / unsettled platform cash; not 1:1 with £48.55 net revenue figure |
| Pending payouts | No | No pending `payout_items`; `driver_pending_payout = 0` |
| **Nothing (informational cash position only)** | **Yes — primary classification** | Documented SSOT intent; UI dashed border + subtitle |

**Accounting intent (from SSOT docs and code comments):**

- Provider Available = **“how much cash Stripe platform holds right now”**
- Driver Available Now = **“how much we could pay drivers”** = `min(liability, provider_available)`
- BALANCED = **card/cash ledger split** for the selected period — independent equation

---

## 5. Driver payout interaction

```typescript
// financialReconciliationSSOT.ts
driverAvailableNowPence = min(remaining_liability, provider_available)
```

Current: `min(0, 666) = **0**`.

Per-driver allocation (`allocateProviderBalanceByLiability`) assigns **0p** when total liability ≤ 0.

**Conclusion:** £6.66 does **not** increase payout eligibility. Even if liability were positive, only `min(liability, 666)` would be payable.

---

## 6. GO / NO-GO — Does £6.66 block first controlled payout approval?

### On £6.66 specifically: **NO-GO blocker = No**

| Question | Answer |
|----------|--------|
| Does £6.66 imply drivers are owed money? | **No** — liability 0, wallets negative |
| Could £6.66 be paid to drivers under current gates? | **No** — `driver_available_now = 0`, 3D.1 execution lock, SSOT blocks |
| Is £6.66 a reconciliation error? | **No** — it is intentionally excluded from BALANCED equation |
| Should ops understand it before GO? | **Yes** — confirm it is platform cash (commission/settlement residue), not float for drivers |

### Overall first controlled payout: **NO-GO** (unchanged from 3D.1)

Reasons **unrelated** to £6.66:

1. `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false` — execution locked
2. MK0001 wallet −£2.78, MK0002 wallet −£23.00 — not payout-eligible
3. Verification incidents (£0.87 + £2.78 unintended transfers)
4. Ahmed explicit approval required

**£6.66 is not a reason to delay or approve payout by itself.** It is expected platform cash telemetry.

### Recommended before first live payout (informational, not blocking)

- [ ] Optional: Stripe Dashboard → Balance → verify £6.66 transaction breakdown (charges vs transfers vs payouts)
- [ ] Optional: Schedule ONECAB platform bank sweep if £6.66 is confirmed commission residue
- [ ] UI follow-up (future): label Provider Available as *“Platform Stripe cash (all regions)”* to reduce confusion with MK liability

---

## Artifacts

| File | Purpose |
|------|---------|
| `docs/phase3d2-provider-available-audit-output.json` | Prod read-only query output |
| `scripts/phase3d2-provider-available-audit.ts` | Re-runnable audit script |
| `docs/financial-reconciliation-ssot-architecture.md` | SSOT architecture reference |

---

## Stop condition

Read-only audit complete. **No data modified. No payouts, ledger entries, or Stripe transfers executed.**
