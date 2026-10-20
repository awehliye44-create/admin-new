# 20261220120000 — apply path (NOT `db push`)

## Why

Production has remote-only migrations not present locally. `supabase db push`
refuses and suggests `migration repair` — **do not repair**.

## Predicate (narrow)

Capture evidence counts when, among existing verified/positive-capture gates:

- `status = CAPTURED` (existing residual-buffer exception), **or**
- `status = PARTIAL_CAPTURE_ONLY`
  AND `financial_operation_state = CAPTURED`
  AND `released_amount_pence = 0` (explicit; **NULL does not qualify**), **or**
- no release stamps (`released_at` null, released amount 0, hold_release_state not RELEASE*)

Still fail-closed for refunds, unverified provider state, missing capture, destructive
`released_amount_pence > 0` / NULL-with-release-stamps on PARTIAL_CAPTURE_ONLY, and
`status = RELEASED`.

## Approved apply (when owner authorises)

```bash
supabase db query --linked -f \
  supabase/migrations/20261220120000_economic_date_partial_capture_non_destructive_release.sql
```

Does **not** write `schema_migrations`. Record as out-of-band like `20261219120000`.

## Rollback

Restore pre-apply dump:
`.release-prep/driver_wallet_resolve_economic_date.PRE_PARTIAL.rollback.sql`
(md5 `d9bbc46e01a80cfcab4789bd5846efc4`)

## Production verification (read-only after apply)

```sql
SELECT economic_date_status, economic_earned_at, clearing_status
FROM driver_wallet_resolve_economic_date(
  'TRIP_EARNING_NET',
  (SELECT id FROM trips WHERE trip_code = 'MK-260923-017'),
  (SELECT created_at FROM driver_wallet_ledger
   WHERE related_trip_id = (SELECT id FROM trips WHERE trip_code = 'MK-260923-017')
     AND type = 'TRIP_EARNING_NET' LIMIT 1)
);
-- expect RESOLVED + economic_earned_at = session captured_at
```

Do not pay until a separate supplementary-weekly approval.
