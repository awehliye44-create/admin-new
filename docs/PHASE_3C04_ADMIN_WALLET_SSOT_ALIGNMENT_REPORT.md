# Phase 3C.4 — Admin Wallet SSOT Alignment Report

**Date:** 2026-06-18  
**Status:** Implementation complete — **pending production migration deploy + verification**  
**Scope:** Wallet balance definition only (no payout rules, allocation, Stripe, settlement, or reconciliation formula changes)

---

## Executive summary

Phase 3C.03F identified admin wallet drift: `driver_financial_summary.wallet_balance` excluded `COMMISSION_RECOVERED` while Phase 3A.4 ledger liability SSOT includes it. Phase 3C.4 removes that exclusion everywhere and reclassifies **In Debt** using `amount_owed_to_onecab` instead of wallet sign.

**Production payout enablement:** **NO-GO** until this migration is deployed and MK verification passes. Stripe execution remains gated by `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` (Phase 3C.3e).

---

## Root cause

| Layer | Before (defect) | After (3C.4) |
|-------|-----------------|--------------|
| `driver_financial_summary.balance_totals` | Excluded `PLATFORM_COMMISSION`, `CASH_TRIP_EARNING`, **`COMMISSION_RECOVERED`** | Excludes **`PLATFORM_COMMISSION`, `CASH_TRIP_EARNING` only** |
| `recalculate_driver_wallet()` / trigger | Same triple exclusion | Same as `computeLedgerWalletBalancePence()` |
| `walletBalanceSSOT.ts` | Local exclusion set included `COMMISSION_RECOVERED` | Delegates to `onecabFinanceLedger.ts` |
| `onecabFinanceLedger.ts` `REPORTING_ONLY_LEDGER_TYPES` | Included `COMMISSION_RECOVERED` | Matches `BALANCE_EXCLUDED_LEDGER_TYPES` only |
| `capture-trip-payment` wallet sum | Excluded `COMMISSION_RECOVERED` | Aligned |
| In Debt tab / count | `wallet_balance < 0` | `amount_owed_to_onecab > 0` |

**MK0002 proof (pre-fix):** admin −807p = SSOT 1901p − COMMISSION_RECOVERED 2708p.

---

## Before / after values (production baseline)

Values from live prod read-only verification (2026-06-18, pre-3C.4 migration).

### Per-driver wallet

| Driver | Before — Admin view | Before — Driver app / ledger SSOT | Expected after 3C.4 |
|--------|--------------------:|----------------------------------:|--------------------:|
| **MK0001** | £13.91 (1391p) | £17.80 (1780p) post-incident payout | **£17.80** — admin = ledger SSOT |
| **MK0002** | −£8.07 (−807p) | **£19.01** (1901p) | **£19.01** — admin = driver = liability |

| Driver | `COMMISSION_RECOVERED` (p) | Drift (admin − SSOT) |
|--------|---------------------------:|---------------------:|
| MK0001 | 846 | −846p |
| MK0002 | 2708 | −2708p |

### Region (MK)

| Metric | Before | Expected after |
|--------|--------|----------------|
| Admin `Σ driver_financial_summary.wallet_balance` | Misaligned with finance liability | Matches `finance_reconciliation_summary.driver_money.driver_remaining_liability_pence` |
| Finance reconciliation liability rollup | Ledger SSOT (driver edge v3) | Unchanged formula — admin rollup should match |

---

## SQL changes

**Migration:** `supabase/migrations/20260618120000_phase_3c4_admin_wallet_ssot_alignment.sql`

1. **`driver_financial_summary`** — recreate view; `balance_totals.wallet_balance`:

```sql
CASE WHEN type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING')
     THEN amount_pence ELSE 0 END
```

2. **`recalculate_driver_wallet(uuid)`** — wallet sum uses same exclusion pair.

3. **`trigger_recalculate_wallet()`** — same exclusion pair on `driver_wallets.available_pence` / `lifetime_earned_pence`.

4. **Cache rebuild** — `PERFORM recalculate_driver_wallet(driver_id)` for all drivers with ledger rows.

**Approved wallet exclusions (unchanged):** `PLATFORM_COMMISSION`, `CASH_TRIP_EARNING` only.

---

## Shared SSOT alignment

| Function / module | Role |
|-------------------|------|
| `computeLedgerWalletBalancePence()` | Canonical ledger wallet sum |
| `perDriverLedgerLiabilityPence()` | `max(0, computeLedgerWalletBalancePence())` |
| `walletBalanceSSOT.ts` | Re-exports + `sumLedgerWalletBalancePence()` — identical to above |
| `driver_financial_summary.wallet_balance` | Postgres mirror of `computeLedgerWalletBalancePence()` |

All three paths now share the same exclusion set.

---

## Affected admin surfaces

| Surface | Change |
|---------|--------|
| **Driver Settlements** table | `wallet_balance` from aligned view; column label **Wallet Balance (SSOT)** |
| **Driver Settlements** detail modal | SSOT wallet card (removed “informational” wording) |
| **Driver Settlements** In Debt tab | `amount_owed_to_onecab > 0` (+ count badge) |
| **Driver Wallet** page | SSOT wallet display; In Debt tab/count uses `amount_owed_to_onecab` |
| **Driver Wallet** detail modal | SSOT wallet + Ready for Payout (`net_available_for_payout`) |
| **Manual payout dialog** | Wallet line labeled **Wallet Balance (SSOT)** |
| **Financial Reconciliation fallback** (`useFinancialReconciliationSSOT`) | Region wallet rollup from aligned `driver_financial_summary` |
| **`admin-finance-reconciliation`** region rollup | `Σ wallet_balance` from aligned view |
| **`admin-finance-settlement-summary`** | Same source view |
| **`admin-payments-summary`** / **`admin-driver-settlements`** edges | Same source view |
| **`capture-trip-payment`** | Debt-recovery wallet-before uses SSOT exclusion set |

---

## In Debt classification

**Before:** Drivers with negative `wallet_balance` appeared in In Debt (MK0002 could show −£8.07 while owing £0 cash commission).

**After:** In Debt = `amount_owed_to_onecab > 0` (cash commission debt SSOT). A driver with positive wallet balance is never listed solely due to wallet drift.

---

## Verification

### Automated (post-deploy)

```bash
# From admin-new/
npx tsx scripts/phase3c4-wallet-ssot-verification.ts
```

**Required checks:**

| Check | MK0001 | MK0002 |
|-------|--------|--------|
| Admin wallet == ledger SSOT | ✓ (expected 1780p) | ✓ (expected 1901p) |
| Finance liability == max(0, ledger) | ✓ | ✓ (£19.01) |
| Driver app wallet == ledger SSOT | ✓ | ✓ |

**Region:** `Σ admin wallet_balance` (MK) == finance reconciliation `driver_remaining_liability_pence`.

### Unit tests

```bash
deno test supabase/functions/_shared/walletBalanceSSOT.test.ts --allow-read
```

### Manual UI sign-off (post-deploy)

- [ ] Driver Settlements — MK0001/MK0002 wallet column matches driver app
- [ ] MK0002 not in In Debt tab unless `amount_owed_to_onecab > 0`
- [ ] Finance Reconciliation region liability matches Settlements wallet rollup

---

## GO / NO-GO — payout enablement

| Gate | Status |
|------|--------|
| 3C.4 migration applied to production | **Pending deploy** |
| MK0001/MK0002 wallet alignment | **Pending post-deploy verification** |
| MK region rollup alignment | **Pending post-deploy verification** |
| 3C.3e edges + UI deployed (`ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false`) | **Pending** |
| Ahmed approval for real Stripe execution | **Not granted** |

**Verdict:** **NO-GO** for production payout enablement until:

1. Migration `20260618120000_phase_3c4_admin_wallet_ssot_alignment.sql` is applied to prod.
2. `phase3c4-wallet-ssot-verification.ts` passes with zero blockers.
3. Manual UI sign-off on MK drivers.
4. Ahmed explicitly approves Stripe execution (separate from wallet alignment).

---

## Files changed

| Path | Purpose |
|------|---------|
| `supabase/migrations/20260618120000_phase_3c4_admin_wallet_ssot_alignment.sql` | View + cache + rebuild |
| `supabase/functions/_shared/walletBalanceSSOT.ts` | Align with `onecabFinanceLedger` |
| `supabase/functions/_shared/onecabFinanceLedger.ts` | `REPORTING_ONLY` set fix |
| `supabase/functions/_shared/walletBalanceSSOT.test.ts` | SSOT tests |
| `supabase/functions/capture-trip-payment/index.ts` | Wallet sum exclusion |
| `supabase/functions/_shared/financeBackendAuditV1.ts` | Comment fix |
| `src/pages/AdminDriverSettlements.tsx` | In Debt + labels |
| `src/pages/DriverWallet.tsx` | In Debt + labels |
| `src/hooks/useDriverWallet.ts` | SSOT comment |
| `src/components/finance/ManualPayoutConfirmDialog.tsx` | Label |
| `scripts/phase3c4-wallet-ssot-verification.ts` | Post-deploy verifier |
| `scripts/phase3c3e-prod-verification.ts` | Single exclusion set |

---

## References

- `docs/PHASE_3C03F_ADMIN_WALLET_BALANCE_AUDIT.md` — root cause audit
- `docs/PHASE_3C3E_PRODUCTION_VERIFICATION_REPORT.md` — pre-fix prod baseline
- `drive-hub-buddy/docs/PHASE_3A1_FINANCE_ALIGNMENT.md` — COMMISSION_RECOVERED in wallet balance
