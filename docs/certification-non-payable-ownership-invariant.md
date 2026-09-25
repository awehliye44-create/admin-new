# CERTIFICATION_NON_PAYABLE — ownership invariant + migration gate

## Schema decision (A)
Reuse `trips.financial_outcome` = `CERTIFICATION_NON_PAYABLE`. No new outcome column.

## Migration version
- Forward: `20261201120000_certification_non_payable_financial_outcome.sql`
- Rollback: `rollback/rollback_20261201120000_certification_non_payable_financial_outcome.sql`
- Live collision avoided: `20261130120000` = `capture_composition_components`

### Exact DDL
1. COMMENT ON `trips.financial_outcome`
2. Expand repair audit `event_type` CHECK (+2 events)
3. CREATE `admin_apply_certification_non_payable_repair`
4. GRANT EXECUTE TO `service_role` only

Not changed: financial_outcome CHECK/enum (none), invoice CHECK (none), trips indexes/grants, ownership triggers.

## Atomic Apply
Single PG txn RPC: advisory_xact_lock → trip FOR UPDATE → 14-guard revalidation → lock stale session →
confirm owner → minimal trip mutation → request + audits → trip-scoped recompute.
Never modifies MK-010, payment_sessions, provider, wallet, payout.

## Duplicate audit (read-only)
| Session | Trips | Owner |
|---|---|---|
| bfab32d2-… | MK-010 + MK-011 | MK-010 |
| 413ad088-… | MK-031 + MK-032 | NULL |

Do not enforce ownership trigger in this PR. Cert producer must insert `payment_session_id=NULL`.

## SHA-256 (frozen at draft tip)

- Forward `20261201120000_…sql`: `5cf7602ecd087aa685018cb1bcd3a4865102983f4bbacdbfaba21dca7ec37060`
- Rollback `rollback_20261201120000_…sql`: `075e152a0fec54f1cb06a3a816f00c3b712b4d19e62a1f653870dce1949a0e92`

## db push --dry-run note

Live already applied `20261130120000` (`capture_composition_components`) and
`20261130130000` (`payment_session_acquire_capture_composition`). Those files live
on other branches; this draft branch correctly **does not** reuse `20261130120000`.
`20261201120000` is absent from live `schema_migrations` and is the only new financial
migration introduced here. Duplicate local migration prefixes = 0.
