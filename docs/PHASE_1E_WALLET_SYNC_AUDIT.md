# PHASE 1E — Wallet Sync Audit

**Date:** 2026-06-16  
**Status:** COMPLETE — audit only (no remediation deployed)  
**Prod project:** `thazislrdkjpvvghtvzo`  
**Driver ID (Ahmed Osman MK0001):** `5ed232c3-8bb5-4085-95d6-73e48e6c5e28`

---

## Executive summary

Wallet cache drift is **real** but **does not affect driver-facing payout surfaces** that use ledger SSOT (`driver-wallet-summary`). The drift is caused by (1) a **formula mismatch** between `driver_wallets` cache refresh and the deployed `driver_financial_summary` view / driver app ledger math, and (2) a **stale cache row** that missed the latest `+436p` `TRIP_EARNING_NET` credit on 2026-06-16.

The Financial Reconciliation **−436p** figure is a **misleading comparison** (cache vs wrong ledger sum including `COMMISSION_RECOVERED`). The operationally correct balance for Ahmed is **£4.37** (ledger SSOT), not £8.47 (cache) or £12.83 (wrong sum).

---

## 1. Source of truth

| Layer | SSOT? | Formula |
|-------|-------|---------|
| **`driver_wallet_ledger`** | **Yes — authoritative** | Sum `amount_pence` excluding reporting-only types |
| **`driver_financial_summary`** (prod view) | **Yes — live aggregate** | Excludes `PLATFORM_COMMISSION`, `CASH_TRIP_EARNING`, **`COMMISSION_RECOVERED`** |
| **`computeDriverWalletSummary`** (driver app) | **Yes** | `REPORTING_ONLY_LEDGER_TYPES` in `shared/onecabFinanceLedger.ts` |
| **`driver_wallets.available_pence`** | **No — materialised cache** | Updated by trigger/RPC; **stale formula** |

**Reporting-only types (do not affect wallet balance):**

- `PLATFORM_COMMISSION`
- `CASH_TRIP_EARNING`
- `COMMISSION_RECOVERED` (mirror of `DEBT_RECOVERY`; owed-to-ONECAB uses debt − recovery only)

**Balance-affecting types:** `TRIP_EARNING_NET`, `CASH_COMMISSION_DEBT`, `DEBT_RECOVERY`, payouts, fees, adjustments, tips, etc.

---

## 2. Cache generation path

```
driver_wallet_ledger INSERT/UPDATE/DELETE
        │
        ▼
wallet_ledger_recalc_trigger (AFTER EACH ROW)
        │
        ▼
trigger_recalculate_wallet()
        │  SUM(amount_pence) WHERE type NOT IN
        │    ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING')   ← BUG: includes COMMISSION_RECOVERED
        ▼
driver_wallets UPSERT (available_pence, lifetime_earned_pence, updated_at)
```

**Also:**

- `recalculate_driver_wallet(p_driver_id)` RPC — same formula as trigger (prod-verified)
- Called after payout completion (`admin-driver-payout`, `payoutLedgerSync`, `admin-sync-payout-ledger`)
- Bulk backfill migrations (`20260403090137`, `20260611120000`) — historical one-shots

**Not cache — live ledger reads:**

- `driver-wallet-summary` edge fn → full ledger → `computeDriverWalletSummary`
- `admin-driver-wallet-detail` → aggregates ledger inline
- `driver_financial_summary` view → aggregates ledger in SQL

**Legacy cache readers (at risk):**

- `driver-earnings-summary` → reads `driver_wallets` (driver sidebar — documented P0 issue)
- `admin-finance-summary` → `Σ driver_wallets.available_pence`
- `finance-backend-audit-v1` → `wallet_integrity` compares cache vs ledger
- `useFinancialReconciliationSSOT` fallback → `driver_wallets`

---

## 3. Root cause

### 3a. Structural — formula mismatch (primary)

Prod `driver_financial_summary` (migration `20260715120000` applied) **excludes** `COMMISSION_RECOVERED` from `wallet_balance`.

Prod `recalculate_driver_wallet` + `trigger_recalculate_wallet` **still include** `COMMISSION_RECOVERED`.

For Ahmed Osman:

| Sum formula | Result |
|-------------|--------|
| Correct SSOT (excl. `COMMISSION_RECOVERED`) | **437p (£4.37)** |
| Cache trigger formula (incl. `COMMISSION_RECOVERED`) | **1283p (£12.83)** |
| Difference | **+846p** (= sum of `COMMISSION_RECOVERED` entries) |

The UI-reported “ledger £12.83” matches the **wrong** cache formula, not Financial Reconciliation SSOT.

### 3b. Incident — stale cache after card capture (secondary)

Latest ledger activity (2026-06-16 12:06:30 UTC):

| Type | Amount | Notes |
|------|--------|-------|
| `TRIP_EARNING_NET` | **+436p** | Card trip `05fa9fa8-…` |
| `PLATFORM_COMMISSION` | +77p | Reporting only |

- `driver_wallets.updated_at` = **12:06:30.497** (matches `PLATFORM_COMMISSION` insert)
- Cache = **847p** = **1283p − 436p** (old-formula total **before** today’s earning was applied)
- Trigger ran on `PLATFORM_COMMISSION` row but cache **did not include** the `+436p` `TRIP_EARNING_NET` inserted 1ms earlier

Likely: per-row trigger race when two ledger rows are inserted in rapid succession, or `TRIP_EARNING_NET` insert path bypassed full recalc visibility.

`capture-trip-payment` credits ledger via `creditCapturedCardTripLedger` but does **not** call `recalculate_driver_wallet` explicitly (relies on trigger only).

### 3c. Audit UI — misleading comparison

`finance-backend-audit-v1`:

- `walletByDriver` → **all-time** `driver_wallets.available_pence`
- `ledgerSumByDriver` → **period-filtered** ledger rows (default: today) with **wrong** exclusion set

This produces the observed **−436p** message even when the real issue is formula + staleness.

---

## 4. Ahmed Osman — prod snapshot (2026-06-16)

| Metric | Value |
|--------|-------|
| `driver_wallets.available_pence` (cache) | **847p (£8.47)** |
| Ledger SSOT (correct formula) | **437p (£4.37)** |
| Cache vs correct drift | **+410p** (cache overstated) |
| Wrong-formula ledger sum | **1283p (£12.83)** |
| UI-reported drift (cache − wrong sum) | **−436p** |
| `driver_financial_summary.wallet_balance` | **437p** ✓ |
| `net_available_for_payout` | **437p** |
| `total_payouts_sent` | **0** |
| `amount_owed_to_onecab` | **0** |

---

## 5. Affected drivers count (prod)

| Driver | Cache | Ledger SSOT | Drift (cache − SSOT) |
|--------|-------|-------------|----------------------|
| Ahmed Osman (MK0001) | 847p | 437p | **+410p** |
| asiya wehliye (MK0002) | 1901p | −807p | **+2708p** |

**2 / 2** drivers with `driver_wallets` rows have cache drift **> 1p** vs correct ledger SSOT.

---

## 6. Drift impact on driver finance surfaces

| Surface | Data source | Affected? |
|---------|-------------|-----------|
| **Available Now** | `driver-wallet-summary` → ledger | **No** |
| **Next Weekly Payout** | `computeDriverWalletSummary` → ledger | **No** |
| **Owed to ONECAB** | `computeOwedToOnecab` / view `amount_owed_to_onecab` | **No** |
| **Early Cash Out** | Ledger + in-flight cashouts | **No** |
| Admin Payout Batches / Settlements | `driver_financial_summary` view | **No** |
| Financial Reconciliation trip SSOT | Ledger / trips | **No** |
| **Wallet integrity audit row** | Compares cache vs wrong sum | **Yes — misleading** |
| **admin-finance-summary** totals | `driver_wallets` | **Yes — liability overstated** |
| **driver-earnings-summary** sidebar | `driver_wallets` | **Yes — may show stale balance** |
| Payout eligibility if ever gated on cache | `driver_wallets` | **Risk — not primary path today** |

**Payout engine / Monday settlement:** Uses `driver_financial_summary` / ledger-backed paths — **not directly gated on stale cache** today.

---

## 7. Risk assessment

| Risk | Severity | Notes |
|------|----------|-------|
| Driver sees wrong Available Now | **Low** | `driver-wallet-summary` reads ledger |
| Admin approves over-payout from cache | **Medium** | Mitigated if batches use `net_available_for_payout` from view |
| Audit false alarm (−436p) | **Medium** | Ops confusion; wrong remediation target |
| asiya cache +2708p vs ledger −807p | **High** | Severe cache corruption; driver in debt but cache shows credit |
| Formula drift on every `COMMISSION_RECOVERED` trip | **High** | Systematic +846p class error for Ahmed after debt-recovery flows |

---

## 8. Fix proposal (requires approval — not implemented in 1E)

### Step 1 — Align cache formula (SQL migration, no ledger writes)

Update `recalculate_driver_wallet` and `trigger_recalculate_wallet` to exclude:

```sql
type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING', 'COMMISSION_RECOVERED')
```

Match prod `driver_financial_summary.balance_totals` and `onecabFinanceLedger.REPORTING_ONLY_LEDGER_TYPES`.

### Step 2 — Rebuild cache (ops, no ledger changes)

```sql
SELECT recalculate_driver_wallet(driver_id)
FROM (SELECT DISTINCT driver_id FROM driver_wallet_ledger) d;
```

**Expected after fix:**

| Driver | Cache should become |
|--------|---------------------|
| Ahmed Osman | **437p** |
| asiya wehliye | **−807p** (or 0 if clamped — verify clamp policy) |

### Step 3 — Belt-and-suspenders (code, small)

After `creditCapturedCardTripLedger` / payout ledger writes, explicit `recalculate_driver_wallet` RPC (already done for payouts; add for capture path).

### Step 4 — Fix audit comparison (code)

`financeBackendAuditV1.buildWalletIntegrityRows`:

- Use **all-time** ledger aggregate
- Exclude `COMMISSION_RECOVERED` (match SSOT)
- Compare to cache; label as “cache vs ledger SSOT”

### Step 5 — Deprecate cache readers (follow-up)

Point `admin-finance-summary` and `driver-earnings-summary` at ledger/view SSOT; treat `driver_wallets` as optional performance cache only.

**No payout logic changes. No ledger row inserts/deletes. No Stripe webhook changes.**

---

## 9. Rollback plan

| Step | Rollback |
|------|----------|
| Migration (function update) | `CREATE OR REPLACE` prior function bodies from `20260403090125` migration |
| Cache rebuild | Re-run old-formula `recalculate_driver_wallet` (restores wrong but prior cache state) |
| Audit code fix | Revert `financeBackendAuditV1.ts` |
| Capture explicit recalc | Remove RPC call only |

**Safe rollback window:** Before any payout batch uses rebuilt cache values. Document pre-rebuild cache values (Ahmed 847p, asiya 1901p) for reference.

---

## 10. Verification checklist (post-fix sign-off)

- [x] Ahmed: cache = view = ledger SSOT (**1391p** at sign-off — see §12; audit-time **437p** superseded by +954p new `TRIP_EARNING_NET`)
- [x] asiya: cache = view = ledger SSOT (**−807p**, drift **0**)
- [x] All drivers: **2/2** zero drift, max drift **0p**
- [x] `wallet_integrity` uses all-time ledger SSOT (excludes `COMMISSION_RECOVERED`) — deployed
- [x] `driver-wallet-summary` unchanged (ledger path)
- [x] No payout / Monday settlement / DEBT_RECOVERY / COMMISSION_RECOVERED write logic changed
- [ ] Regression: trip card capture → cache updates within 1s (monitor post-deploy)

---

## 11. Paths audited

| Component | Repo | Role |
|-----------|------|------|
| `driver_wallets` table | DB | Materialised cache |
| `driver_wallet_ledger` | DB | SSOT |
| `trigger_recalculate_wallet` | DB (prod) | Per-row cache refresh |
| `recalculate_driver_wallet` | DB (prod) | Manual / post-payout refresh |
| `driver_financial_summary` | DB view | Admin + payout batches |
| `driver-wallet-summary` | drive-hub-buddy | Driver app balances |
| `driver-earnings-summary` | drive-hub-buddy | Sidebar (cache — risk) |
| `finance-backend-audit-v1` | admin-new | Wallet integrity display |
| `admin-driver-wallet-detail` | admin-new | Ledger-backed detail |
| `capture-trip-payment` | admin-new | Ledger credit, trigger-only cache |
| `onecabFinanceLedger.ts` | admin-new / shared | SSOT type exclusions |
| `payoutLedgerSync.ts` | admin-new | Post-payout recalc |

---

## 12. Phase 1E remediation — sign-off (2026-06-17)

### Applied

| Step | Action | Status |
|------|--------|--------|
| 1E-A | `recalculate_driver_wallet` + `trigger_recalculate_wallet` exclude reporting-only types | Applied via `supabase db query -f 20260617180000_phase_1e_wallet_cache_alignment.sql` |
| 1E-B | One-time rebuild (`DO $$ … PERFORM recalculate_driver_wallet`) | Applied (same migration) |
| 1E-C | Display cleanup + audit SSOT comparison | Edge functions deployed |

### Before / after balances

| Driver | Pre-fix cache | Pre-fix SSOT | Post-fix cache | Post-fix SSOT | Drift |
|--------|---------------|--------------|----------------|---------------|-------|
| Ahmed Osman (MK0001) | 847p (£8.47) | 437p (£4.37)* | **1391p (£13.91)** | **1391p** | **0** |
| asiya wehliye (MK0002) | 1901p (£19.01) | −807p (−£8.07) | **−807p (−£8.07)** | **−807p** | **0** |

\*Audit-time SSOT. Ahmed gained **+954p** additional `TRIP_EARNING_NET` between audit and rebuild; all three surfaces (cache, view, ledger) agree at **1391p**.

### Rebuild results

```
drivers=2  zero_drift=2  max_drift_pence=0
```

### Deployments (prod `thazislrdkjpvvghtvzo`)

- `finance-backend-audit-v1`, `admin-finance-summary`, `capture-trip-payment` (admin-new)
- `driver-earnings-summary` (drive-hub-buddy)

### Tests

```
deno test walletBalanceSSOT.test.ts financeBackendAuditV1.test.ts --no-check → 7 passed
```

---

## Stop gate

**Phase 1E complete.** Cache formula aligned, rebuilt, and matches ledger SSOT for all drivers. **Phase 2 driver app SSOT alignment may begin** after stakeholder sign-off on this report.
