# Slice 5 — Financial Reconciliation consume-only

**Status:** Deployed & verified (2026-07-12).  
**Scope:** FR auditor only. No payouts, no historical invent, no Slice 6+.

## Hard rules

- No default BALANCED
- Unknown ≠ £0
- Missing release stays explicit (`MISSING_RELEASE` / `RELEASE_AMOUNT_UNCONFIRMED`)
- FR never executes release / refund / wallet credit / payout
- No cross-driver netting
- Widgets backend-supplied

## Required statuses

`BALANCED` · `PARTIAL` · `CAPTURE_MISMATCH` · `RELEASE_AMOUNT_UNCONFIRMED` · `MISSING_RELEASE` · `WALLET_MISMATCH` · `PAYOUT_MISMATCH` · `PROVIDER_EVIDENCE_PENDING` · `UNAVAILABLE` · `PENDING_SYNC`

## Exact files

| File | Role |
|---|---|
| `admin-new/shared/frConsumeOnlySSOT.ts` | Primary status + identity + fully-balanced gates |
| `admin-new/shared/__tests__/frConsumeOnlySSOT.test.ts` | Unit tests |
| `admin-new/.../frTripAuditComparisonSSOT.ts` | MISSING_RELEASE classifier + KPI widgets |
| `admin-new/.../financeSettlementSummary.ts` | Consume-only identity; fr_trip_audit_status |
| `admin-new/.../tripFinancialAuditStatus.ts` | Badge: no green on wallet pending / missing release |
| `admin-new/.../financialReconciliationSSOT.ts` | Stop inventing driver net from gross−commission |
| `admin-new/.../FinancialReconciliationOverviewTab.tsx` | Required widgets; no soft BALANCED |
| `admin-new/src/lib/frDriverAuditOverviewSSOT.ts` | settlement identity must be === true |

## Deploy

`admin-finance-reconciliation` only (admin-new).

## Acceptance

- Missing release cannot force global BALANCED
- Ahmed / Bosteyo independent
- Money truth unchanged
