# RETIRED — canonical path

This migration was promoted to:

`supabase/migrations/20261112200000_reserve_driver_payout_item_early_cashout_allowlist.sql`

Rollback remains:

`supabase/migrations/rollback/rollback_20261112200000_reserve_driver_payout_item_early_cashout_allowlist.sql`

Live RPC body already matches the forward migration (applied 2026-09-16 out-of-band).
Do **not** re-apply the CREATE body. After merging this hygiene PR, record the version as applied via:

`supabase migration repair 20261112200000 --status applied --project-ref thazislrdkjpvvghtvzo`

(only if `schema_migrations` still lacks `20261112200000`).
