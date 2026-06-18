# Phase 3C.03F — Admin Wallet Balance SSOT Mismatch Audit

**Date:** 2026-06-17  
**Status:** Read-only audit — **no implementation**  
**Driver:** MK0002 (Asiya Wehliye) — `cd8bae4c-3827-4b90-98c6-10be70eb0e52`  
**Region:** MK — `7f611e59-a9e5-42c2-b65a-61376910bb5d`

## Executive summary

The **Driver Settlements** table column **“Wallet Balance”** does **not** use Phase 3A.4 ledger wallet SSOT. It reads `driver_financial_summary.wallet_balance`, whose SQL **excludes `COMMISSION_RECOVERED`** from the ledger sum. The driver app uses `computeLedgerWalletBalancePence()` / `driver-wallet-summary`, which **includes** `COMMISSION_RECOVERED`.

For MK0002 this produces **exactly** the observed delta:

| Surface | Value |
|---------|------:|
| Driver app wallet | **+£19.01** (1901p) |
| Admin “Wallet Balance” | **−£8.07** (−807p) |
| Difference | **2708p** (= `COMMISSION_RECOVERED` on this driver) |

**Classification:** **(E) Other** — SSOT definition drift between admin Postgres view / cache helpers and approved Phase 3A.4 ledger wallet formula (not legacy trip aggregation, not `amount_owed_to_onecab`, not a label-only issue).

---

## 1. Driver Settlements “Wallet Balance” — exact source chain

### 1.1 UI component

| Layer | Location |
|-------|----------|
| Page | `src/pages/AdminDriverSettlements.tsx` |
| Table column | `Wallet Balance` → `formatPence(d.wallet_balance, d.currency_code)` |
| Detail dialog | “Wallet (informational)” card + breakdown footer “= Wallet Balance” → `selectedDriverDetail.wallet_balance` |
| “In Debt” tab filter | `d.wallet_balance < 0` |

No client-side recalculation. Value is passed through unchanged from the hook.

### 1.2 React query

| Layer | Location |
|-------|----------|
| Hook | `src/hooks/useDriverWallet.ts` → `useDriverFinancialSummaries()` / `useDriverFinancialSummary()` |
| Query | Direct Supabase client (no edge function for this column) |

```typescript
supabase
  .from('driver_financial_summary')
  .select('…, wallet_balance, …')
```

Mapping:

```typescript
wallet_balance: Number(d.wallet_balance) || 0,
```

### 1.3 Edge function

**None** for the Settlements table wallet column.  
(Per-driver payout SSOT on the same page uses `admin-finance-reconciliation` via `DriverSSOTPayoutPanel` — separate from wallet column.)

### 1.4 SQL view

**Object:** `public.driver_financial_summary` (Postgres view)

**Authoritative migration in repo:** `supabase/migrations/20260715120000_p0_finance_ledger_ssot.sql`

**Wallet formula (`balance_totals` CTE):**

```sql
COALESCE(SUM(
  CASE WHEN type NOT IN (
    'PLATFORM_COMMISSION',
    'CASH_TRIP_EARNING',
    'COMMISSION_RECOVERED'          -- ← admin-only exclusion
  ) THEN amount_pence ELSE 0 END
), 0)::bigint AS wallet_balance
```

Exposed as:

```sql
COALESCE(bt.wallet_balance, 0::bigint) AS wallet_balance
```

**Related cache function (same exclusion):** `recalculate_driver_wallet()` in `supabase/migrations/20260617180000_phase_1e_wallet_cache_alignment.sql`

**Shared TS mirror (same exclusion):** `supabase/functions/_shared/walletBalanceSSOT.ts` → `WALLET_BALANCE_EXCLUDED_LEDGER_TYPES` includes `COMMISSION_RECOVERED`.

### 1.1 Formula (admin)

```
admin_wallet_balance =
  Σ ledger.amount_pence
  WHERE type ∉ { PLATFORM_COMMISSION, CASH_TRIP_EARNING, COMMISSION_RECOVERED }
```

---

## 2. Comparison to Phase 3A.4 SSOT

### 2.1 `computeLedgerWalletBalancePence()` (approved)

**Source:** `drive-hub-buddy/shared/onecabFinanceLedger.ts` (ported to `admin-new/supabase/functions/_shared/onecabFinanceLedger.ts`)

```typescript
export const BALANCE_EXCLUDED_LEDGER_TYPES = [
  "PLATFORM_COMMISSION",
  "CASH_TRIP_EARNING",
] as const;
// COMMISSION_RECOVERED is NOT excluded — offsets DEBT_RECOVERY in balance
```

```
ssot_wallet_balance =
  Σ ledger.amount_pence
  WHERE type ∉ { PLATFORM_COMMISSION, CASH_TRIP_EARNING }
```

Documented in `drive-hub-buddy/docs/PHASE_3A1_FINANCE_ALIGNMENT.md`:

> **Included:** `COMMISSION_RECOVERED` (balance-offset, not reporting-only)  
> Removed `COMMISSION_RECOVERED` from `REPORTING_ONLY_LEDGER_TYPES`

### 2.2 `finance-reconciliation-driver` / per-driver SSOT

**Edge:** `admin-finance-reconciliation` (GET `driver_id=…`) → `fetchPerDriverFinancialReconciliation()`

**Liability / wallet SSOT field:**

```typescript
perDriverLedgerLiabilityPence(ledger) =
  max(0, computeLedgerWalletBalancePence(ledger))
```

Mapped to response as:

- `driver_remaining_liability_pence` — ledger wallet (SSOT)
- `driver_available_now_pence` — finance-cleared, Stripe-capped payout
- `driver_pending_payout_pence` — awaiting settlement (digital)

**Important:** Driver Settlements **does not** bind the “Wallet Balance” column to `driver_remaining_liability_pence`. It uses `driver_financial_summary.wallet_balance` instead.

### 2.3 Driver app

| Layer | Location |
|-------|----------|
| UI | `drive-hub-buddy/src/components/wallet/WalletBalanceGrid.tsx` |
| Edge | `driver-wallet-summary` |
| Calculation | `computeDriverWalletSummary()` → `net_balance_pence = computeLedgerWalletBalancePence(...)` |
| Ready / awaiting | `available_payout_pence` + `pending_payout_pence` (settlement split; sums to wallet) |

---

## 3. MK0002 — reconciled figures

### 3.1 Ledger rows (prod snapshot fixture — `phase3a1WalletVerification.test.ts`)

| Type | amount_pence |
|------|-------------:|
| TRIP_EARNING_NET | +6049 |
| DRIVER_TIP_CREDIT | +100 |
| CASH_COMMISSION_DEBT | −2708 |
| DEBT_RECOVERY | −2708 |
| **COMMISSION_RECOVERED** | **+2708** |
| LEDGER_REVERSAL | −1540 |

### 3.2 Computed balances

| Metric | Formula | pence | GBP |
|--------|---------|------:|----:|
| **Ledger wallet (Phase 3A.4 SSOT)** | `computeLedgerWalletBalancePence()` — includes COMMISSION_RECOVERED | **1901** | **£19.01** |
| **Admin view wallet** | Sum excluding COMMISSION_RECOVERED | **−807** | **−£8.07** |
| **Finance liability SSOT** | `perDriverLedgerLiabilityPence()` = max(0, 1901) | **1901** | £19.01 |
| **COMMISSION_RECOVERED excluded** | 1901 − 2708 | −807 | −£8.07 |

### 3.3 Driver app (observed 2026-06-17 screenshot)

| Field | Observed | Notes |
|-------|----------|-------|
| Wallet Balance | £19.01 | Matches SSOT ledger wallet |
| Ready for Payout | £6.83 | Finance-cleared + settlement split |
| Awaiting Settlement | £12.18 | Uncaptured / pending settlement bucket |
| Identity | £6.83 + £12.18 = £19.01 | Consistent with SSOT wallet |

### 3.4 Admin Driver Settlements (observed screenshot)

| Field | Observed | Source |
|-------|----------|--------|
| Wallet Balance column | **−£8.07** | `driver_financial_summary.wallet_balance` (wrong exclusion) |
| Commission column | −£27.08 | `company_commission_total` (trip aggregation — separate) |
| SSOT Available (detail dialog) | Shown separately via `DriverSSOTPayoutPanel` | `admin-finance-reconciliation` — **not** used for wallet column |

### 3.5 Payout / finance SSOT (from Phase 3C audits — approximate)

| Field | Expected (MK0002) |
|-------|-------------------:|
| `driver_available_now_pence` | ~259p (£2.59) — Stripe allocation cap |
| `driver_pending_payout_pence` | portion of liability awaiting settlement |
| `payout_warning_reasons` | soft MK reconciliation warning |

Payout fields are **orthogonal** to the wallet presentation bug.

---

## 4. Root-cause classification

| Option | Verdict | Evidence |
|--------|---------|----------|
| **A) Legacy settlement formula** | **Partial / historical** | Pre-202604 migrations used `card_net_credits - cash_commission - payouts + adjustments`. Current repo migration uses ledger sum — but with **extra** `COMMISSION_RECOVERED` exclusion. |
| **B) Net owed to ONECAB** | **No** | `amount_owed_to_onecab` is a separate column (`cash_debt − debt_recovery`). Not used for wallet column. |
| **C) Trip aggregation** | **No** | Wallet column reads `balance_totals` ledger CTE, not `trip_totals`. Commission column is trip-derived but wallet is not `gross − commission`. |
| **D) Label incorrect only** | **No** | Value is arithmetically wrong vs SSOT, not just mislabelled. |
| **E) Other** | **Yes — primary** | **SSOT exclusion mismatch:** admin SQL / cache excludes `COMMISSION_RECOVERED`; Phase 3A.4 / driver app includes it. |

**Arithmetic proof for MK0002:**

```
admin_wallet = ssot_wallet − COMMISSION_RECOVERED
−807p = 1901p − 2708p
```

---

## 5. SSOT violation assessment

| Principle | Status |
|-----------|--------|
| Phase 3A.4: Wallet Balance = ledger wallet balance | **VIOLATED** on admin surfaces using `driver_financial_summary.wallet_balance` |
| Same label “Wallet Balance” on driver app vs admin | **VIOLATED** — opposite sign possible when debt recovery + COMMISSION_RECOVERED present |
| Phase 3A.1: COMMISSION_RECOVERED included in balance | **VIOLATED** in admin-new migrations `20260617180000` and `20260715120000` |
| Payout SSOT (`driver_available_now_pence`) | **Not violated** by this bug — uses separate finance-reconciliation path |

**Severity:** **High (presentation / ops)** — admins may mark drivers “in debt”, hide payout eligibility context, and mis-reconcile against driver-reported balances. Payout gating on Settlements uses SSOT panel, not wallet column — **partial mitigation**.

---

## 6. Affected pages and fields

| Page / surface | Field | Data source |
|----------------|-------|-------------|
| **Driver Settlements** (`AdminDriverSettlements.tsx`) | Wallet Balance column | `driver_financial_summary.wallet_balance` ❌ |
| **Driver Settlements** | “In Debt” tab | `wallet_balance < 0` ❌ |
| **Driver Settlements** | Detail “Wallet (informational)” | same ❌ |
| **Driver Settlements** | Manual payout modal “Wallet Balance” | `selectedDriverDetail.wallet_balance` ❌ |
| **Driver Wallet** (`DriverWallet.tsx`) | Wallet Balance column / totals | same view ❌ |
| **Financial Reconciliation** (SUMMARY fallback) | `driver_money.driver_wallet_balance_pence` | aggregated from same view ❌ |
| **admin-finance-reconciliation** | Region wallet total rollup | `SUM(driver_financial_summary.wallet_balance)` ❌ |
| **admin-payments-summary** | Wallet aggregates | same view ❌ |
| **DriverSSOTPayoutPanel** | SSOT Available Now | `admin-finance-reconciliation` ✅ |
| **Driver app Wallet** | Wallet / ready / awaiting | `driver-wallet-summary` ✅ |

---

## 7. Recommended fix (do not implement in this phase)

### 7.1 Database / SSOT alignment (required)

1. **Update `driver_financial_summary.balance_totals.wallet_balance`** to exclude only:
   - `PLATFORM_COMMISSION`
   - `CASH_TRIP_EARNING`  
   (Remove `COMMISSION_RECOVERED` from exclusion — match Phase 3A.4.)

2. **Update `recalculate_driver_wallet()`** with the same exclusion set.

3. **Update `walletBalanceSSOT.ts`** to match `onecabFinanceLedger.ts` / `computeLedgerWalletBalancePence()`.

4. **Migration + backfill verification** for MK0001/MK0002:
   - `driver_financial_summary.wallet_balance` = `computeLedgerWalletBalancePence(ledger)`
   - MK0002: −807p → **+1901p**

### 7.2 Admin UI (recommended)

1. **Driver Settlements wallet column** — either:
   - Read `driver_remaining_liability_pence` from per-driver finance SSOT, **or**
   - Rename column to clarify if showing a different metric (not recommended — align value instead).

2. **Remove misleading “informational” label** once SSOT-aligned; badge as **Finance SSOT**.

3. **“In Debt” tab** — base on `amount_owed_to_onecab > 0` or SSOT liability, not broken wallet sign.

4. **Manual payout modal** — show SSOT wallet from finance reconciliation, not `driver_financial_summary.wallet_balance`.

### 7.3 Tests

- Add regression: MK0002 fixture — admin view wallet = `computeLedgerWalletBalancePence()`.
- Cross-surface test: `driver_financial_summary.wallet_balance` = `driver-wallet-summary.net_balance_pence` for MK peers.

### 7.4 Deployment note

Repo migrations define the fix; **production must be checked** to confirm which `driver_financial_summary` revision is live. Local `.env` in this audit did not return MK0002 rows (likely non-prod project). **Post-deploy verification:** run ledger sum vs view for `cd8bae4c-3827-4b90-98c6-10be70eb0e52`.

---

## 8. Verification checklist (post-fix)

| Check | MK0002 expected |
|-------|-------------------|
| `computeLedgerWalletBalancePence(ledger)` | 1901p |
| `driver_financial_summary.wallet_balance` | 1901p |
| Driver app wallet | £19.01 |
| Admin Settlements wallet column | £19.01 |
| `driver_remaining_liability_pence` (finance SSOT) | 1901p |
| Ready + awaiting (driver app) | still sums to wallet |

---

## 9. References

- `drive-hub-buddy/docs/PHASE_3A1_FINANCE_ALIGNMENT.md` — COMMISSION_RECOVERED inclusion
- `drive-hub-buddy/src/lib/__tests__/phase3a1WalletVerification.test.ts` — MK0002 ledger fixture
- `admin-new/supabase/migrations/20260715120000_p0_finance_ledger_ssot.sql` — offending exclusion
- `admin-new/src/hooks/useDriverWallet.ts` — admin read path
- `admin-new/src/pages/AdminDriverSettlements.tsx` — UI binding

**End of audit — await approval before implementation.**
