# P0 Audit — Financial Reconciliation (SSOT) Trips Tab

**Date:** 2026-07-05  
**Scope:** `admin-finance-reconciliation` → `trip_financial_audit` → `FinancialReconciliationTripsTab`

## Executive summary

**Trips (0) was NOT caused by filtering to reconciliation mismatches only.**  
The tab shows every trip returned by the backend audit query. Root causes were:

1. **Date filter bug** — `YYYY-MM-DD` end date treated as midnight (fixed: London day bounds)
2. **Hard row cap** — default `audit_limit` was **100** (max 500), silently truncating large periods
3. **Narrow default date** — single-day "today" when no trips completed yet
4. **UI gaps** — required audit columns not displayed (data existed in payload)

**Mismatch-only filter:** **NOT PRESENT** — verified in code and production.

---

## Data flow

```
FinancialReconciliation.tsx
  └─ useFinancialReconciliationSSOT
       └─ invokeFinanceReconciliation()  [GET admin-finance-reconciliation]
            └─ trip_financial_audit[]
                 └─ FinancialReconciliationTripsTab (rows prop)
```

---

## SQL / query audit

### Base query (trips table)

| Filter | Mismatch-only? |
|--------|----------------|
| `completed_at` range | No |
| Terminal OR (same as Trip History) | No |
| `capture_mismatch` in WHERE | **No** |
| `payment_status` in WHERE | **No** |
| `dispatch_status` | Not used |
| `reconciliation_check` in WHERE | **No** |

### Row limit (P0 defect — fixed)

| Mode | Old default | New default |
|------|-------------|-------------|
| Full FR page | **100** | **10,000** |

---

## Hard rule compliance

> Financial Reconciliation is an audit console for every financial trip, not only exception trips.

- **Before:** Compliant on mismatch filter; **non-compliant** on row cap for high-volume days
- **After:** All terminal trips in scope up to 10,000 rows; badges never gate visibility
