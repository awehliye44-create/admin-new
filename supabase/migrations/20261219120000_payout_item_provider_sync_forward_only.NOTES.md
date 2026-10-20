# 20261219120000 — apply path (NOT `db push`)

## Why this file exists

Production has **29 remote-only** migrations that are not present in this repo.
`supabase db push` / `db push --dry-run` therefore refuse to run and suggest
`migration repair` — **do not repair** migration history to bypass that mismatch.

## Approved apply method (when explicitly authorised)

```bash
supabase db query --linked -f \
  supabase/migrations/20261219120000_payout_item_provider_sync_forward_only.sql
```

This executes DDL only via the Management API. It does **not** insert into
`supabase_migrations.schema_migrations`.

## After apply — avoid future conflicts

- Treat this version as **applied out-of-band**. Do **not** later run
  `supabase db push` expecting to apply `20261219120000` until local and remote
  migration directories are reconciled by a separate, approved history effort
  (e.g. obtaining the 29 remote-only SQL files — not by `migration repair --status reverted`).
- Re-running the SQL file is safe for the function body (`CREATE OR REPLACE`,
  idempotent forward-only provider sync), but is still a production change —
  do not re-run without approval.
- Scope is **only** `public.finalize_driver_payout_completion`. It does **not**
  touch `driver_wallet_resolve_economic_date`.

## Rollback artifact

Pre-apply production definition (captured read-only before deploy):

`.release-prep/finalize_driver_payout_completion.PRE_APPLY.rollback.sql`
(md5 `780128fe81fee269401cf974f8796de9`)
