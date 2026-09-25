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

- Forward `20261201120000_…sql`: `6f337c59dc29d5d938eb47e855f8b81843279f0ef666c1ee17ccc22bf3f2d144`
- Rollback `rollback_20261201120000_…sql`: `36bddc517fa4017bbee374226000d51dd9167998c81557df1eeda7c1f0ba0019`
- Live-parity `20261130120000_capture_composition_components.sql`: `323d723737c65692fb697b1e87505b19f53e71f16281fd989ad9cf607c6e28b2`
- Live-parity `20261130130000_payment_session_acquire_capture_composition.sql`: `761c235e24fed675d994a69645bf18e7d244955ecc69b9fe6de5caca6baa6438`

## db push --dry-run (after source parity)

```
Would push these migrations:
 • 20261201120000_certification_non_payable_financial_outcome.sql
Finished supabase db push.
```
Does **not** propose 20261130120000 or 20261130130000.
