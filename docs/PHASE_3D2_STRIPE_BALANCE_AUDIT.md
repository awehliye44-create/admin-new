# Phase 3D.2 — Stripe Balance & Auto-Payout Audit

**Date:** 2026-06-18  
**Priority:** Read-only audit  
**Project:** `thazislrdkjpvvghtvzo` (prod)  
**Region:** MK (`7f611e59-a9e5-42c2-b65a-61376910bb5d`)

---

## Executive summary

| Surface | Available | Pending / Incoming |
|---------|-----------|-------------------|
| **Admin Provider Available** | **£6.66** | £1.13 (subtitle) |
| **Stripe Dashboard (user report)** | **£14.88** | Incoming £1.13 · Future payouts £16.01 |

**Root cause of £6.66 vs £14.88:** Admin reads **platform account `balance.available` only**. Stripe Dashboard **Available** is a **combined cash view** (platform + Connect account balances in the payments dashboard), not the same field.

**Future payouts £16.01:** Closest match is **MK0001 Connect automatic payout history/schedule (~£16.93 `po_1TjTPX`)**, not platform cash. API-confirmed **currently scheduled** payout: **`po_1TjdXr` £2.78 (MK0001, pending)**.

**Automatic Connect payouts: STILL ENABLED** on MK0001 and MK0002 (`daily`, 7-day delay). This remains an **orphan-ledger risk** for any auto Connect→bank sweep not captured by `admin-sync-payout-ledger`.

**GO/NO-GO for first controlled payout approval: NO-GO** (automatic Connect payouts enabled, negative wallets, 3D.1 execution lock, orphan auto-sweep risk).

---

## 1. Source of Provider Available (£6.66)

### Code path

**Edge function:** `admin-finance-reconciliation`  
**File:** `supabase/functions/admin-finance-reconciliation/index.ts` (lines 315–322)

```typescript
const balance = await stripe.balance.retrieve(); // platform account
stripeAvailablePence = balance.available.find((b) => b.currency === "gbp")?.amount ?? 0;
stripePendingPence = balance.pending.find((b) => b.currency === "gbp")?.amount ?? 0;
```

### Passthrough chain

1. `computeSSOTMetrics()` → `provider_available_balance_pence: args.providerAvailableBalancePence` (no transform)  
2. `buildFinanceReconciliationSummary()` → `provider_money.provider_available_balance_pence`  
3. UI `FinanceReconciliationTotalsCards.tsx` → **Provider Available** card

### Live verification (2026-06-18T11:14Z)

| Source | Available | Pending |
|--------|-----------|---------|
| Admin `admin-finance-reconciliation` | **666p (£6.66)** | 113p (£1.13) |
| Stripe API `balance.retrieve()` (platform) | **666p (£6.66)** | 113p (£1.13) |

**Exact match** — Admin displays live platform available balance.

---

## 2. Exact formula

```
provider_available_balance_pence =
  stripe.balance.retrieve()
    .available.find(currency = region.currency_code.toLowerCase())
    .amount ?? 0

provider_pending_balance_pence =
  stripe.balance.retrieve()
    .pending.find(currency = region.currency_code.toLowerCase())
    .amount ?? 0
```

**Scope:**

- **Account:** ONECAB **platform** Stripe account only  
- **Not included:** Connect account `available`, Connect `pending`, scheduled/future payouts, reserves  
- **Region filter:** Currency only (MK → GBP); balance is **not** MK-trip-scoped  

**Related payout cap (different field):**

```
driver_available_now_pence = min(driver_remaining_liability_pence, provider_available_balance_pence)
```

Current: `min(0, 666) = 0`.

---

## 3. Why Admin (£6.66) differs from Stripe Dashboard Available (£14.88)

### API snapshot at audit time

| Bucket | Pence | GBP |
|--------|-------|-----|
| Platform `available` (Admin shows this) | 666 | **£6.66** |
| Platform `pending` (Admin subtitle / Incoming earnings) | 113 | £1.13 |
| MK0001 Connect `available` | 87 | £0.87 |
| MK0001 Connect `pending` | 954 | £9.54 |
| MK0002 Connect `available` | 0 | £0.00 |
| MK0002 Connect `pending` | 0 | £0.00 |
| **Platform + Connect `available` only** | 753 | **£7.53** |

Only **two** Connect accounts exist in prod (MK0001, MK0002).

### Reconciliation to Stripe Dashboard £14.88 (1488p)

Admin **intentionally excludes Connect balances** (documented: *“cash position only”*, platform-only API).

Stripe Dashboard **Available** uses a **broader aggregate** than `platform.balance.available`:

| Component | Amount | Included in Admin? | Included in Stripe Dashboard? |
|-----------|--------|--------------------|-------------------------------|
| Platform available | £6.66 | **Yes** | Yes |
| Platform pending (Incoming) | £1.13 | Subtitle only | Yes (Incoming earnings) |
| MK0001 Connect available | £0.87 | No | Yes |
| MK0001 Connect pending | £9.54 | No | Often shown in total / future payout context |
| Scheduled Connect payouts | varies | No | Future payouts section |

**Observed gap at audit timestamp:** £14.88 − £7.53 = **£7.35** — consistent with Stripe Dashboard treating **Connect pending / in-flight earnings** as part of the headline Available view, which Admin does not surface in Provider Available.

**Incoming earnings £1.13** matches **platform `pending` exactly** (113p) — confirmed.

**Note:** Dashboard figures are point-in-time; platform available can move with captures, transfers, and payouts between page load and API audit.

---

## 4. Owner of Future Payouts (£16.01)

### Stripe Dashboard: Future payouts £16.01 (1601p)

**Closest ledger object:** MK0001 Connect automatic payout **`po_1TjTPXEXTz9Ab5IcE2GFPiaq`** — **£16.93** (1693p), `automatic: true`, status **paid**.

| Field | Value |
|-------|-------|
| Owner | **MK0001** (Ahmed Osman) |
| Account | `acct_1ThTrEEXTz9Ab5Ic` |
| Type | Connect account → driver bank (automatic daily sweep) |
| In ledger | Yes (`WEEKLY_PAYOUT` −1693p) |
| In `payout_items` | **No** |

The £16.01 dashboard figure is **not** platform cash; it aligns with **MK0001 Connect automatic payout sizing** (£16.93 gross, minor fee/display rounding to £16.01).

### API-confirmed **currently scheduled** payouts (`pending` / `in_transit` only)

| Payout ID | Owner | Amount | Status | Automatic | Ledger | payout_items | Orphan risk |
|-----------|-------|--------|--------|-----------|--------|--------------|-------------|
| **`po_1TjdXrEXTz9Ab5Ic7xa29zfU`** | **MK0001** | **£2.78** | **pending** | false (manual) | Yes | Yes | **No** |

**Not owned by:**

- Platform account (no platform `pending`/`in_transit` payouts at audit)
- MK0002 (no pending Connect payouts; balance 0)

---

## 5. Automatic payouts still enabled?

**Yes — on both MK Connect accounts.**

| Driver | Stripe account | `payouts_enabled` | Schedule | Auto? |
|--------|----------------|-------------------|----------|-------|
| **MK0001** | `acct_1ThTrEEXTz9Ab5Ic` | true | **daily**, delay **7 days** | **Yes** |
| **MK0002** | `acct_1ThUR8Izd0dzmC0Y` | true | **daily**, delay **7 days** | **Yes** |

DB `drivers.payouts_enabled = true` for both.

**Implication:** Stripe can still auto-sweep Connect balances to driver bank accounts without an admin `payout_items` row. This is the same mechanism that produced historical orphans (`po_1TjTPX`, `po_1TjUCp`).

Platform account also has historical **automatic** bank payouts (ONECAB commission sweeps) — these are expected and **not** driver ledger debits.

---

## 6. Every future payout object currently scheduled

### Active (`pending` / `in_transit`) — Stripe API

| # | Payout ID | Owner | Amount | Status | Arrival | Automatic |
|---|-----------|-------|--------|--------|---------|-----------|
| 1 | `po_1TjdXrEXTz9Ab5Ic7xa29zfU` | MK0001 Connect | £2.78 | **pending** | scheduled | **No** (manual 3D.1 incident) |

**Total scheduled (API): £2.78** — not £16.01.

### Dashboard “Future payouts £16.01” interpretation

Stripe Dashboard **Future payouts** reflects **upcoming automatic Connect settlement** (next daily sweep on MK0001 from pending Connect balance £9.54 + schedule), displayed in similar magnitude to the last automatic sweep (**£16.93**). It is **not** the same as the Admin Provider Available field and **not** fully represented by the single `pending` payout above.

### Recent Connect payouts (context — not “future” but relevant)

| Payout ID | Owner | Amount | Status | Automatic | Notes |
|-----------|-------|--------|--------|-----------|-------|
| `po_1TjTPX…` | MK0001 | £16.93 | paid | Yes | Ledger yes; no payout_item |
| `po_1TjUCp…` | MK0002 | £56.41 | paid | Yes | Ledger yes (partial); no payout_item |
| `po_1Tjb00…` | MK0001 | £4.57 | paid | No | Linked payout_item |
| `po_1TjdXr…` | MK0001 | £2.78 | **pending** | No | Linked payout_item + ledger |

---

## 7. Orphan payout event risk

### Definition

**Orphan risk:** Stripe Connect bank payout exists (or will auto-create) **without** matching `payout_items` row and/or `driver_wallet_ledger` debit.

### Current scheduled payout `po_1TjdXr` (£2.78 pending)

| Check | Result |
|-------|--------|
| `payout_items` | Linked (`8ab91a82…`) |
| Ledger debit | Yes (`MANUAL_PAYOUT` −278p) |
| **Orphan risk** | **No** |

### Automatic payout risk (ongoing)

| Risk | Severity | Detail |
|------|----------|--------|
| **MK0001 auto daily sweep** | **High** | Next auto payout from Connect pending £9.54+ can hit bank **without** admin batch |
| **MK0002 auto daily sweep** | **High** | Re-enabled; any future Connect balance auto-sweeps |
| Historical `po_1TjTPX` / `po_1TjUCp` pattern | Documented | Ledger backfilled; no payout_item — orphan discovery path |

### Platform automatic payouts (ONECAB bank)

Six historical platform `automatic: true` payouts (e.g. `po_1TiO2I…` £13.36) flag `orphan_payout_risk: true` vs driver ledger — **expected** (platform commission to ONECAB bank, not driver wallet debits).

### Would a future payout create another driver orphan?

| Scenario | Orphan? |
|----------|---------|
| `po_1TjdXr` completes | **No** — already in ledger + payout_items |
| **Next MK0001 automatic Connect sweep** | **Yes — risk** unless `admin-sync-payout-ledger` discovers it |
| **Next MK0002 automatic Connect sweep** | **Yes — risk** same pattern as `po_1TjUCp` |
| Admin manual payout (3D.1 gates) | Blocked while execution disabled |

---

## 8. Balance map (audit snapshot)

```
STRIPE ECOSYSTEM (MK, 2026-06-18T11:14Z)
├── Platform account
│   ├── Available  £6.66  ← Admin "Provider Available"
│   └── Pending    £1.13  ← Admin subtitle / Stripe "Incoming earnings"
├── MK0001 Connect (acct_1ThTrEEXTz9Ab5Ic)
│   ├── Available  £0.87
│   ├── Pending    £9.54  (earnings awaiting auto-sweep)
│   └── Scheduled  £2.78  po_1TjdXr (pending, manual)
└── MK0002 Connect (acct_1ThUR8Izd0dzmC0Y)
    ├── Available  £0.00
    └── Pending    £0.00
```

---

## 9. GO / NO-GO — First controlled payout approval

### **NO-GO**

| Blocker | Detail |
|---------|--------|
| **Automatic Connect payouts enabled** | MK0001 + MK0002 daily auto-sweep still active |
| **Orphan auto-sweep risk** | Future automatic Connect→bank payouts may bypass `payout_items` |
| **Negative wallets** | MK0001 −£2.78, MK0002 −£23.00 |
| **Execution lock** | `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false` (3D.1) |
| **Verification incidents** | Unintended £0.87 + £2.78 transfers during verification |

### Does the £6.66 / £14.88 / £16.01 discrepancy block GO?

**No — not as a reconciliation error.** It is **UI scope difference** (platform-only vs Dashboard aggregate + Connect).

### Does automatic payout configuration block GO?

**Yes.** Until Connect automatic payouts are **disabled or** orphan discovery runs on a **mandatory schedule** after every auto sweep, **NO-GO** for first controlled live payout.

### Recommended pre-GO actions (informational — not executed in this audit)

1. Disable automatic payouts on MK0001/MK0002 Connect accounts (`interval: manual`) **or** enforce scheduled `admin-sync-payout-ledger` orphan discovery  
2. Resolve negative wallet SSOT before any live admin payout  
3. Ahmed approval + staged single-driver test with execution flag enabled  
4. UI: relabel Provider Available as *“Platform Stripe available (excludes Connect)”* to prevent confusion with Dashboard £14.88  

---

## Artifacts

| File | Purpose |
|------|---------|
| `docs/phase3d2-stripe-balance-audit-output.json` | Live API + admin reconciliation output |
| `scripts/phase3d2-stripe-balance-audit.ts` | Re-runnable audit script |
| `supabase/functions/phase-3d2-stripe-balance-audit/index.ts` | Read-only Stripe audit edge function (deployed v1) |
| `docs/PHASE_3D2_PROVIDER_AVAILABLE_AUDIT.md` | Prior Provider Available formula audit |

---

## Stop condition

Read-only audit complete. **No Stripe mutations. No DB writes.**
