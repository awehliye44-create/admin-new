# Phase 3C.3e — Production Verification Report

**Date:** 2026-06-18  
**Project:** `thazislrdkjpvvghtvzo` (ONECAB prod)  
**Verifier:** Automated script + live SQL (`supabase db query --linked`)  
**Screenshots:** Not captured (admin 3C.3e UI not deployed to production hosting)

---

## Verdict: **NO-GO**

| Gate | Result |
|------|--------|
| Deploy aligned edge functions + UI | **NO-GO** |
| Enable real Stripe payout execution | **NO-GO** (unchanged) |

**Primary blockers:**

1. **Phase 3C.03F wallet defect still live** — admin `driver_financial_summary.wallet_balance` ≠ ledger SSOT for both MK drivers.
2. **3C.3e code not deployed** — production edges use pre-3C.3 SSOT (hard `BALANCED` gate, no `dry_run`, no `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED`).
3. **Admin vs driver finance SSOT split** — `admin-finance-reconciliation` returns stale/zero fields; `finance-reconciliation-driver` returns v3.

---

## ⚠️ Incident during verification

During an initial automated probe (now removed from the script), the following **unintended production writes** occurred because **deployed** `admin-driver-payout` and `admin-weekly-monday-settlement` **do not** implement 3C.3e safety gates:

| Action | Result |
|--------|--------|
| `admin-weekly-monday-settlement` with `dry_run: true` | **Created real batch** `8fdc9ed8-5049-46ef-b8d3-e7bb5087f7e1` (WEEKLY_MONDAY, £4.57) + payout_item `c5bcd2f7-…` |
| `admin-driver-payout` with `confirm_payout: true` (MK0001) | **Executed real payout** batch `d627233c-…`, **MANUAL_PAYOUT −457p** ledger debit, API reported Stripe transfer `tr_1Tjazz…` |

**MK0001 ledger wallet:** 2237p → **1780p** after −457p debit.

**Remediation needed:** Ahmed/finance to review MK0001 payout_item `2c50b7df-dcae-40be-9888-f89f061e0f4b` / batch `d627233c-4d4d-4114-b9d9-d5e01c54aa30` and weekly orphan batch `8fdc9ed8-…`.

Subsequent verification used **read-only SQL + GET finance edges only**.

---

## 1. Driver Settlements SSOT check (production data)

### Wallet Balance — **FAIL (3C.03F)**

| Driver | Admin `driver_financial_summary` | Ledger SSOT (`computeLedgerWalletBalancePence`) | Driver app `driver-wallet-summary` | Match? |
|--------|----------------------------------:|------------------------------------------------:|-----------------------------------:|:------:|
| **MK0001** | **£13.91** (1391p) | **£22.37** (2237p) → **£17.80** (1780p) post-incident | £17.80 (1780p) current | ❌ admin |
| **MK0002** | **−£8.07** (−807p) | **£19.01** (1901p) | £19.01 (1901p) | ❌ admin |

**Root cause (confirmed on prod SQL):** `driver_financial_summary.balance_totals` excludes `COMMISSION_RECOVERED` from wallet sum. Driver SSOT includes it.

| Driver | `COMMISSION_RECOVERED` sum | admin − SSOT |
|--------|---------------------------:|-------------:|
| MK0001 | 846p | 1391 − 2237 = −846 |
| MK0002 | 2708p | −807 − 1901 = −2708 |

**Admin UI today** reads this view via `useDriverFinancialSummaries()` — **3C.3e UI not deployed**; production admin still shows wrong wallet column.

### Ready for payout / hard block / soft warning / Pay Driver Now

**Deployed `admin-finance-reconciliation` (what Settlements SSOT panel uses today):**

| Driver | `driver_available_now_pence` | `payout_blocked` | `payout_blocked_reasons` | `payout_warning_reasons` | `reconciliation_status` |
|--------|-----------------------------:|:----------------:|--------------------------|--------------------------|-------------------------|
| MK0001 | 0 | true | No provider allocation; No SSOT balance | *(none — old edge)* | BALANCED |
| MK0002 | 0 | true | No provider allocation; No SSOT balance | *(none)* | BALANCED |

**Deployed `finance-reconciliation-driver` (driver app finance overlay):**

| Driver | Ready (`driver_available_now_pence`) | Pending (`driver_pending_payout_pence`) | Liability | `payout_blocked` | Hard reasons | Soft warnings |
|--------|---------------------------------------:|----------------------------------------:|----------:|:----------------:|--------------|---------------|
| MK0001 | **499p** (£4.99) | 1281p | 1780p | true | Reconciliation mismatch — payout blocked until balanced | **none (v3 not soft-gated on driver edge)** |
| MK0002 | **532p** (£5.32) | 1369p | 1901p | true | Reconciliation mismatch — payout blocked until balanced | **none** |

**Expected from 3C.3e approval (not on prod):**

| Driver | Ready | Hard blocked | Soft warning | Pay Driver Now |
|--------|------:|:------------:|:------------:|:--------------|
| MK0001 | ~305p | false | true | enabled + amber |
| MK0002 | ~259p | false | true | enabled + amber |

**Pay Driver Now / confirmation modal:** **Cannot verify on prod UI** — 3C.3e modal not deployed. Deployed backend would **block** MK0002 (`MANUAL_PAYOUT_RECONCILIATION_MISMATCH`); MK0001 probe **executed real payout** (see incident).

---

## 2. Admin wallet mismatch defect — **STILL PRESENT**

| Check | Result |
|-------|--------|
| Admin uses ledger SSOT for Wallet Balance | **NO** |
| MK0002 negative admin balance | **YES** (−807p vs +1901p driver) |
| Fix deployed | **NO** |

**STOP:** Root cause unchanged — see `docs/PHASE_3C03F_ADMIN_WALLET_BALANCE_AUDIT.md`.

---

## 3. Weekly Monday dry run — **NOT SAFE ON PROD**

| Check | Result |
|-------|--------|
| `dry_run: true` honoured | **NO** — deployed v4 ignores flag; creates batches + items |
| MK0001 included | Yes (READY, 457p — **before** incident; amounts differ from £3.05 target) |
| MK0002 included | **NO** — BLOCKED (`Reconciliation mismatch`) |
| Soft warnings don't skip | N/A — old gate blocks on mismatch |
| Stripe executed | **NO** (weekly edge does not transfer) |
| Warning reasons in results | **NO** |

**3C.3e weekly dry-run must not be invoked on prod until new edge is deployed.**

---

## 4. Manual Pay Driver Now dry-run — **NOT SAFE ON PROD**

| Check | Result |
|-------|--------|
| Dry-run / Stripe gate | **NOT PRESENT** on deployed `admin-driver-payout` v178 |
| MK0001 | **Real £4.57 payout executed** (incident) |
| MK0002 | Blocked 400 `MANUAL_PAYOUT_RECONCILIATION_MISMATCH` |
| Confirmation modal | Not on prod UI |

---

## 5. Payout Batches & Audit

| Check | Result |
|-------|--------|
| Failed payout retry UI (3C.3e) | **Not deployed** to prod hosting |
| `failure_code` / `failure_reason` columns | DB supports; no failed MK items currently |
| Duplicate guard (3C.3e) | **Not on deployed edge** |
| Recent MK payout_items | 2× pending 457p MK0001 from verification incident |

---

## 6. ONECAB Commission Visibility

| Check | Result |
|-------|--------|
| 3C.3e `OnecabCommissionVisibility` panel | **Not deployed** |
| Region finance API (`admin-finance-reconciliation` GET) | Returns zeros / calculated-only fallback for MK region |
| Commission sweep action | **None** (correct) |

---

## Deployed function versions (relevant)

| Function | Version | Updated (UTC) | 3C.3e aligned? |
|----------|--------:|---------------|:--------------:|
| `admin-driver-payout` | 178 | 2026-06-15 | ❌ |
| `admin-weekly-monday-settlement` | 4 | 2026-06-15 | ❌ |
| `admin-finance-reconciliation` | 22 | 2026-06-16 | ❌ |
| `finance-reconciliation-driver` | (drive-hub) | v3 partial | partial |
| `driver-wallet-summary` | — | — | ✅ wallet SSOT |

---

## Recommended sequence before re-verification

1. **Implement 3C.03F wallet fix** (`driver_financial_summary` + cache — remove `COMMISSION_RECOVERED` exclusion).
2. **Deploy 3C.3e edges** with `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` **unset/false**.
3. **Deploy 3C.3e admin UI** to production hosting.
4. **Re-run read-only verification** (`scripts/phase3c3e-prod-verification.ts` — payout/settlement invocations disabled).
5. **Manual UI sign-off** (screenshots) for MK0001/MK0002 on Driver Settlements.
6. **Ahmed explicit approval** before setting `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true`.

---

## Explicit request

**Do not deploy** 3C.3e UI/edges to production until **3C.03F wallet fix** is included in the same release.

**Do not enable** `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` until this report passes after redeployment and Ahmed approves real payouts.

---

**Report status:** FAILED — production verification does not meet 3C.3e acceptance criteria.
