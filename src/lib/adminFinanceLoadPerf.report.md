# Admin finance page load performance — local report

**Date:** 2026-08-25  
**Scope:** UI / React Query / invoke params only. No money logic, Edge ownership, SQL repairs, or provider calls changed.  
**Status:** Local patch only — **no deploy**.

## Audit findings (before)

| Page | Blocking behaviour | Slowest path | Cache / refetch issues |
|------|--------------------|--------------|------------------------|
| Payment Sessions | Table blocked on full fetch; tab→active_holds forced `refresh_provider_state` | Provider refresh on holds/recovery tabs | OK staleTime 60s; unnecessary provider round-trips |
| Financial Reconciliation | Full-page wait until summary; always `audit_limit=10000` even for helpers | Full trip audit + platform KPIs | `visibilitychange` invalidated + refetch; Refresh used 3s critical-button toast (felt like payment risk) |
| Driver Wallet Ledger | Generally OK (paginated list) | Fleet “all pages” for overview cards | Detail staleTime 30s; no timing logs |
| Payout Ledger | Overview + tab share one request | Mode/tab payload | `staleTime: 0` + `refetchOnWindowFocus: true` |

## Patches applied

1. **`adminFinanceLoadPerf.ts`** — shared staleTime 45s, no window-focus refetch, 8s slow-section message, `ADMIN_FINANCE_QUERY_TIMING` logs (`page`, `tab`, `query_name`, `duration_ms`, `row_count`; no secrets).
2. **`LoadingTimeout`** — 8s default; named section; optional partial content (soft banner, not payment-risk copy).
3. **FR** — summary-first (`summary_only=1`, no forced 10k limit); full audit only for heavy tabs; shell paints with filters; no visibility auto-refetch; no critical-button toast on Refresh; backend audit only on Alerts tab.
4. **Payment Sessions** — DB-first always; provider refresh only when explicitly requested; `keepPreviousData`; section `LoadingTimeout`.
5. **Payout Ledger** — finance cache defaults + `keepPreviousData` + timing.
6. **Driver Wallet** — timing + `keepPreviousData` + finance query defaults.

## Expected first-paint (local, after patch)

| Page | Target | Mechanism |
|------|--------|-----------|
| Payment Sessions | &lt;2s usable | DB list, no provider refresh on open |
| FR overview | &lt;3s usable | summary_only first; trip audit deferred |
| Driver Wallet overview | &lt;2s usable | paginated SSOT + cache |
| Payout Ledger overview | &lt;2s usable | 45s stale, no focus refetch |

Heavy FR tabs may still take longer independently; banner names “reconciliation audit” / “trip audit” after 8s.

## How to verify locally

1. Open Admin → each finance page with Network throttling optional.
2. Confirm console `ADMIN_FINANCE_QUERY_TIMING` lines per query.
3. FR: open Overview → only `fr_summary`; open Trips → `fr_full_audit`.
4. Payment Sessions: switch to Active Holds → no provider refresh unless “Force refresh provider”.
5. Blur/focus browser tab → Payout / FR must not refetch automatically.
6. Run: `npx vitest run src/lib/__tests__/adminFinanceLoadPerf.test.ts src/lib/__tests__/adminFinanceLoadPerfContract.test.ts`

## Index recommendation (read-only; not applied)

If FR summary still scans slowly with 7-day + service_area filter, consider a **read-only** composite index on `trips (financial_model, service_area_id, completed_at DESC)` where completed_at is not null — prove with `EXPLAIN` before any migration. Not written here.
