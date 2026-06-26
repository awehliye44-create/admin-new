# Admin Payout Pages Unification

**Date:** 2026-06-26  
**Repo:** `admin-new`  
**Route (SSOT):** `/payout-batches`  
**Nav label:** Finance & Payouts → **Payouts & Ledger Audit**

## Problem

Two overlapping admin surfaces covered payout operations:

| Former page | Route | Overlap |
|-------------|-------|---------|
| Drivers & Payouts | `/drivers-and-payouts` | Driver wallets, manual payout, ledger audit, today payout cards |
| Payout Batches & Audit | `/payout-batches` | Batches, early cashouts, payout audit, SSOT totals cards |

Financial Reconciliation also duplicated payout audit widgets and hosted Stripe Connect balance — splitting “accounting SSOT” from “payout operations.”

## Decision

**Keep one operational SSOT:** Payout Batches & Audit → renamed **Payouts & Ledger Audit**.

- **Remove** Drivers & Payouts from navigation (legacy routes redirect).
- **Move** ledger audit + Connect balance into the unified page as tabs.
- **Keep** Financial Reconciliation as read-only accounting SSOT (totals, trip audit, backend checks) — no payout action widgets.

## Unified page structure

### Tabs (`?tab=` query)

| Tab | Value | Content |
|-----|-------|---------|
| Payout Batches | `batches` (default) | Weekly Monday settlement, payout activity today, audit table, batch list + detail dialog |
| Early Cashouts | `early-cashouts` | `driver_early_cashouts` table |
| Ledger Audit | `ledger` | `FinanceLedgerPanel` (from former Drivers & Payouts) |
| Stripe Connect Balance | `connect-balance` | `ConnectBalancePanel` + per-driver SSOT detail (from former Financial Reconciliation tab) |

### Payout Batches tab includes

- Weekly / manual admin / early-cashout **batch** runs
- Status, amount, success/failed counts
- Batch detail: Stripe payout ID, failed reason, ledger debit, wallet recalc, retry actions
- `FinancePayoutAuditSection` (today activity + full payout audit table)

### Early Cashouts tab includes

- Driver, requested amount, fee, net to bank, method, Stripe payout ID, status

### Ledger Audit tab includes

- Driver wallet ledger with filters: trip earnings, commission recovery, debt recovery, adjustments, payout debits, wallet before/after, trip/payout references

### Stripe Connect Balance tab includes

- Connected account ID, account type, payouts enabled
- Connect available / instantly available / pending / in transit to bank
- Per-driver cash-out decision (`DriverPayoutSsotDetailPanel`)

## Financial Reconciliation changes

**Removed from Financial Reconciliation:**

- `FinancePayoutAuditSection` (today cards + payout audit table)
- Stripe Connect Balance tab

**Retained (read-only SSOT):**

- `FinanceReconciliationTotalsCards`
- `OnecabCommissionVisibility`
- Card/cash reconciliation, trip financial audit, `finance_backend_audit_v1`

**Redirect:** `/financial-reconciliation?tab=connect-balance` → `/payout-batches?tab=connect-balance`

## Misleading “sent today” copy fix

| Before | After |
|--------|-------|
| Driver Payout Sent Today | **Driver payout activity today** |
| (none) | Sub-label: *Recorded payout items today. Bank arrival depends on Stripe payout status.* |

Related today cards renamed: **Failed today**, **Pending today**.

Status display uses human labels via `src/lib/payoutStatusLabels.ts`:

- Created · Pending · In transit · Paid · Failed · Returned to wallet

“Paid” reflects ledger/provider completion — not guaranteed bank arrival.

## Legacy redirects

| Old route | New target |
|-----------|------------|
| `/drivers-and-payouts` | `/payout-batches` |
| `/drivers-and-payouts?tab=ledger` | `/payout-batches?tab=ledger` |
| `/driver-wallet` | `/payout-batches?tab=connect-balance` |
| `/admin-settlements` | `/payout-batches` |
| `/finance-ledger-transactions` | `/payout-batches?tab=ledger` |
| `/connect-payout-lockdown` | `/payout-batches?tab=connect-balance` |

## Files changed

| File | Change |
|------|--------|
| `src/pages/AdminPayoutBatches.tsx` | Renamed UI; 4 tabs; removed duplicate SSOT totals cards |
| `src/pages/FinancialReconciliation.tsx` | Removed payout audit + Connect tab; redirect legacy tab |
| `src/pages/LegacyDriversPayoutsRedirect.tsx` | New redirect helper |
| `src/App.tsx` | Route redirects; removed `DriversAndPayouts` mount |
| `src/components/layout/AdminSidebar.tsx` | Single nav item “Payouts & Ledger Audit” |
| `src/components/finance/MondayPayoutTodayCards.tsx` | Activity today copy + sub-label |
| `src/components/finance/MondayPayoutDiagnosticsTable.tsx` | Status label mapping |
| `src/lib/payoutStatusLabels.ts` | Shared status labels |
| `src/lib/financePageSSOT.ts` | Audit table description |
| `src/hooks/useStaffProfile.tsx` | RBAC aliases merged under `payout-batches` |
| `src/pages/Dashboard.tsx` | Quick action → `/payout-batches` |
| `src/pages/RolesPermissions.tsx` | Finance page list |

**Deprecated (unmounted):** `src/pages/DriversAndPayouts.tsx` — kept in repo for reference; all traffic redirects.

## Verification

1. Sidebar: Finance & Payouts shows only **Payouts & Ledger Audit** (no Drivers & Payouts).
2. `/payout-batches` — four tabs render; batch detail dialog works.
3. `/drivers-and-payouts` redirects to unified page.
4. Financial Reconciliation — no “Driver payout activity today” cards; totals remain.
5. `/financial-reconciliation?tab=connect-balance` redirects to Connect tab on unified page.

```bash
cd admin-new && npm run build
```

Build verified after changes.
