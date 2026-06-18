# Phase 3D — Final Payout Readiness Verification

**Date:** 2026-06-18  
**Project:** `thazislrdkjpvvghtvzo` (ONECAB prod)  
**Mode:** Read-only verification + **safe dry-runs intended** — see §7 incident  
**Approved principle:** **Driver Liability = Wallet Balance SSOT** (raw ledger sum, Phase 3A.4)

---

## Executive conclusion

| Verdict | Result |
|---------|--------|
| **Wallet SSOT alignment** (admin / driver app / ledger / cache) | **PASS** at verification time |
| **Historical remediation** (3C.5 / 3C.6 Option 3) | **PASS** |
| **Dry-run safety** (no Stripe / no writes) | **FAIL** — production edges pre–3C.3e |
| **Admin execution gate** (`ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED`) | **NOT DEPLOYED** on prod edges |
| **GO for first controlled live payout** | **NO-GO** |

**Do not enable real Stripe payouts or `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true` until Ahmed explicitly approves after redeploying 3C.3e payout edges.**

---

## 1. Current driver balances

| Driver | Expected (pre-3D) | **Current prod** | Notes |
|--------|--------------------:|-----------------:|-------|
| **MK0001** Ahmed | £0.87 (87p) | **£0.00 (0p)** | See §7 — unintended manual payout during verification |
| **MK0002** Asiya | −£23.00 (−2,300p) | **−£23.00 (−2,300p)** | Unchanged |

**MK0002 arithmetic (confirmed):** Wallet 1,901p − partial debit 4,201p = **−2,300p**.

---

## 2. Admin vs driver SSOT comparison

Verified via `scripts/phase3d-payout-readiness-verification.ts` (output: `docs/phase3d-verification-output.json`).

### 2.1 Wallet Balance SSOT (raw ledger)

| Source | MK0001 | MK0002 | Match? |
|--------|-------:|-------:|:------:|
| **Ledger SSOT** (`computeLedgerWalletBalancePence` exclusion set) | 87p → **0p**† | −2,300p | — |
| **Admin** `driver_financial_summary.wallet_balance` | 87p → **0p**† | −2,300p | ✅ |
| **Driver app** `driver-wallet-summary` `net_balance_pence` | 87p → **0p**† | −2,300p | ✅ |
| **`driver_wallets` cache** `available_pence` | 87p → **0p**† | −2,300p | ✅ |

†Values at 10:39 UTC before verification-side effects; all four sources matched.

### 2.2 Financial Reconciliation (per-driver SSOT)

| Field | MK0001 | MK0002 |
|-------|-------:|-------:|
| `driver_wallet_balance` (region rollup) | — | Region **−2,213p** (= 0 + (−2,300) after §7) |
| `reconciliation_check.status` (region, today) | **BALANCED** | **BALANCED** |
| `driver_remaining_liability_pence` | 0 | 0 |
| `driver_available_now_pence` | 0 | 0 |
| `payout_blocked` | **true** | **true** |
| `reconciliation_status` | BALANCED | BALANCED |

**Semantic note (remaining risk):** Payout engine uses `perDriverLedgerLiabilityPence()` = `max(0, wallet SSOT)`. MK0002 raw wallet is **−2,300p** but `driver_remaining_liability_pence` reports **0p**. Payout is still blocked (`available_now = 0`), but the label **does not show negative liability / amount owed to ONECAB** on the finance driver card. Align UI copy with raw wallet SSOT before go-live.

### 2.3 Other admin surfaces

| Surface | Status |
|---------|--------|
| **Driver Settlements** | Uses `driver_financial_summary` — matches ledger |
| **Monday payout diagnostics** | **0 mismatches** (post–3C.5 duplicate fix) |
| **Finance backend audit** | HTTP 200; wallet integrity drift **cleared** for MK drivers post–3C.4 |

---

## 3. Payout eligibility

| Driver | Wallet SSOT | Eligible? | Block reasons (finance SSOT) |
|--------|------------:|:---------:|------------------------------|
| **MK0001** | £0.00 | **No** | No provider balance allocated; no SSOT available payout |
| **MK0002** | −£23.00 | **No** | Same hard blocks; negative wallet → `available_now = 0` |

**Expected behaviour:** ✅ Neither driver should receive a new payout while wallet is zero / negative and provider allocation is zero.

---

## 4. Dry-run payout test

### 4.1 Intended test

`admin-driver-payout` with **no** `confirm_payout` — expect preview-only, no Stripe, no ledger debit.

### 4.2 Actual result on prod — **FAIL / INCIDENT**

Production `admin-driver-payout` (deployed **2026-06-15**, v178) **does not enforce** `confirm_payout` or `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED`.

| Check | Expected | Actual |
|-------|----------|--------|
| Stripe transfer | None | **`tr_1TjdMjEeK1Cb9ZBxVHEeUaii`** created |
| Stripe payout | None | None (transfer only) |
| Ledger debit | None | **`MANUAL_PAYOUT` −87p** (`d16709bb-…`) |
| Payout item | None / dry-run | **`01966de2-…` completed** |
| Duplicate batch | No | New batch **`bfb347b5-…`** |

**Impact:** MK0001 wallet **87p → 0p** (economically consistent with paying remaining balance; **not authorised** for this verification run).

### 4.3 MK0002 preview

Blocked with `MANUAL_PAYOUT_RECONCILIATION_MISMATCH` — ✅ hard block worked for MK0002 on deployed edge.

---

## 5. Weekly Monday dry-run

### 5.1 Intended test

`admin-weekly-monday-settlement` with `{ dry_run: true }` — no DB writes, no Stripe.

### 5.2 Actual result on prod — **FAIL**

Production `admin-weekly-monday-settlement` (deployed **2026-06-15**, v4) **ignores `dry_run`**.

| Check | Expected | Actual |
|-------|----------|--------|
| `dry_run: true` in response | Yes | **Absent** |
| DB batch created | No | **`8819ebee-…` WEEKLY_MONDAY READY** |
| Payout item | No | **`0c12e3dc-…` pending 307p** MK0001 (stale amount) |
| Stripe call | No | None |
| MK0001 in results | Blocked or skipped | Listed **READY 307p** (pre-incident SSOT) |
| MK0002 in results | Blocked | **BLOCKED** |

**Remediation needed (do not execute Stripe):** Cancel or `FAILED_DUPLICATE` weekly item `0c12e3dc-…` / batch `8819ebee-…` before any settlement run.

---

## 6. Admin safety gates

| Gate | Repo (3C.3e) | **Prod deployed** |
|------|:------------:|:-----------------:|
| `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false` blocks Stripe | ✅ | **❌ Not in deployed edge** |
| `confirm_payout` required before execution | ✅ | **❌ Not enforced** |
| Weekly `dry_run` → no DB writes | ✅ | **❌ Not deployed** |
| Hard reconciliation block (MK0002) | ✅ | ✅ Observed |

**Action before any live payout:** Deploy `admin-driver-payout` + `admin-weekly-monday-settlement` from `admin-new` main (3C.3e bundle). Keep `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` **unset/false**.

---

## 7. Verification incident (2026-06-18 ~10:40 UTC)

During Phase 3D script execution, **unintended live side-effects** occurred because production payout edges lack 3C.3e gates:

1. **Manual payout** MK0001 **£0.87** → Stripe transfer `tr_1TjdMj…`
2. **Weekly batch shell** `8819ebee-…` + pending item **£3.07** (307p)

**Not in scope to auto-reverse** in this report. Finance/Ops should decide whether to reverse transfer or accept as final clearance of MK0001 remainder.

---

## 8. Historical cleanup verification

| Item | Status |
|------|--------|
| Duplicate £4.57 → `FAILED_DUPLICATE` (`c5bcd2f7`) | ✅ |
| Real £4.57 manual linked + completed (`2c50b7df` → ledger `3448df70`) | ✅ |
| MK0001 `po_1TjTPX` backfill **−1,693p** | ✅ |
| MK0002 `po_1TjUCp` partial debit **−4,201p** | ✅ |
| MK0002 operational loss note **1,440p** (`finance_reconciliation_notes`) | ✅ |
| **£56.41** Stripe payout fully explained | ✅ 4,201 + 1,440 = 5,641 |
| **£9.43** bank credit | ⚠️ **Still UNMATCHED** — documented in `PHASE_3C4` / `PHASE_3C5`; no ledger invented |

---

## 9. Remaining risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **3C.3e edges not deployed** | **Critical** | Deploy before any payout test |
| **Verification incident** (MK0001 −87p transfer) | **High** | Ops review; cancel orphan weekly item |
| **`driver_remaining_liability_pence` caps at 0** | Medium | Show raw wallet / amount owed for negative balances |
| **£9.43 unmatched bank credit** | Low (ops) | Match or formal write-off |
| **MK0002 negative wallet (−£23)** | Medium | No payout until earned back or finance adjustment |
| **Ghost weekly batch `8819ebee`** | High | Mark failed before Monday automation |

---

## 10. GO / NO-GO — first controlled live payout

| Criterion | Met? |
|-----------|:----:|
| Wallet SSOT aligned (admin = driver app = ledger) | ✅ |
| MK0002 remediation documented (Option 3) | ✅ |
| MK0001/MK0002 payout blocked at current balances | ✅ |
| Dry-run does not execute Stripe or writes | ❌ |
| `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` gate live | ❌ |
| `confirm_payout` enforced | ❌ |
| Ahmed explicit approval | ❌ |

### **GO / NO-GO: NO-GO**

**Safe to proceed with:**

1. Deploy 3C.3e payout edge bundle (`ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false`).
2. Clean up orphan batch `8819ebee` / item `0c12e3dc` (no Stripe).
3. Re-run Phase 3D dry-runs **only after deploy**.
4. Ahmed sign-off for **first single-driver controlled payout** (suggest MK0001 only when wallet &gt; minimum, gates verified).

**Not safe:**

- Enabling automatic Monday settlement on prod.
- Setting `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true`.
- Any payout invocation on current prod edges without `confirm_payout` + execution gate.

---

## 11. References

- `docs/phase3d-verification-output.json`
- `scripts/phase3d-payout-readiness-verification.ts`
- `docs/PHASE_3C3E_PRODUCTION_VERIFICATION_REPORT.md`
- `docs/PHASE_3C3E_ADMIN_PAYOUT_IMPLEMENTATION_REPORT.md`
- `docs/PHASE_3C7_MK0002_REVERSAL_LEAKAGE_AUDIT.md`
- `supabase/migrations/20260718120000_phase_3c5_priority_fixes.sql`
- `supabase/migrations/20260718130000_phase_3c6_mk0002_option3_remediation.sql`

---

## 12. Sign-off

| Role | Decision | Date |
|------|----------|------|
| Engineering (3D verification) | **NO-GO** — deploy gates + re-verify | 2026-06-18 |
| Finance | First controlled payout approval | _Pending Ahmed_ |
| Ops | §7 incident + weekly orphan cleanup | _Pending_ |
