# 20261112200000 — already applied live

The SQL body in `20261112200000_reserve_driver_payout_item_early_cashout_allowlist.sql`
matches production `reserve_driver_payout_item` (PHASE8 apply 2026-09-16).

**Do not run the forward SQL again.**

If `supabase_migrations.schema_migrations` lacks version `20261112200000`, after
merging this hygiene PR only:

```bash
supabase migration repair 20261112200000 --status applied --project-ref thazislrdkjpvvghtvzo
```

Confirm with:

```sql
SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261112200000';
```
