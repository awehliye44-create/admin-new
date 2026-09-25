# CERTIFICATION_NON_PAYABLE — ownership invariant + migration gate

## Schema decision (A)

Reuse existing `trips.financial_outcome` (unconstrained `text`).
Value: `CERTIFICATION_NON_PAYABLE`.
No new outcome column.

## Migration version

**Forward:** `20261201120000_certification_non_payable_financial_outcome.sql`  
**Rollback:** `rollback/rollback_20261201120000_certification_non_payable_financial_outcome.sql`

`20261130120000` is **live** as `capture_composition_components` — must not reuse.

### Exact DDL (this migration only)

1. `COMMENT ON COLUMN public.trips.financial_outcome`
2. Expand `driver_financial_repair_audit_event_type_check` (+`CERTIFICATION_NON_PAYABLE_MARKED`, +`STALE_PAYMENT_SESSION_LINK_CLEARED`)
3. `CREATE FUNCTION public.admin_apply_certification_non_payable_repair(...)`
4. `REVOKE ALL` / `GRANT EXECUTE … TO service_role`

**Not changed:** financial_outcome CHECK/enum (none), invoice_payment_classification CHECK (none), trips indexes, trips grants, ownership triggers.

## Atomic Apply RPC

`admin_apply_certification_non_payable_repair` — one PG transaction:
advisory_xact_lock → trip `FOR UPDATE` → 14-guard revalidation → lock stale session →
confirm owner ≠ target → minimal trip mutation → request + 3 audits → trip-scoped recompute.

Never modifies: MK-010, `payment_sessions`, provider, wallet, payout.

## Read-only duplicate audit (2026-09-25)

| payment_session_id | trips | session.trip_id |
|---|---|---|
| `bfab32d2-…` | MK-010 + **MK-011** | MK-010 |
| `413ad088-…` | MK-031 + MK-032 | `NULL` |

Do **not** enforce a global ownership trigger in this PR.
Out-of-repo certification producer must insert `payment_session_id=NULL`.
