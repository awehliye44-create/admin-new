# Test Day Reset — Report

Executed: 2026-06-01 (UTC)

## Rows removed

| Table | Before | After |
|---|---:|---:|
| trips | 1,446 | 0 |
| trip_stops | 3,132 | 0 |
| trip_stop_waiting | 0 | 0 |
| trip_change_requests | 20 | 0 |
| trip_messages | 45 | 0 |
| trip_driver_exclusions | 40 | 0 |
| trip_route_cache | 0 | 0 |
| trip_finance (deprecated) | 1 | 0 |
| ride_offers | 2,005 | 0 |
| dispatch_audit_log | 6,717 | 0 |
| dispatch_eligibility_log | 5,988 | 0 |
| dispatch_round_advance_log | 361 | 0 |
| dispatch_wave_snapshot | 1,837 | 0 |
| dispatch_wave_snapshots | 328 | 0 |
| dispatch_candidates_log | 0 | 0 |
| booking_delivery_log | 17,379 | 0 |
| scheduled_offer_attempts | 3 | 0 |
| driver_wallet_ledger | 600 | 0 |
| driver_ledger (deprecated) | 0 | 0 |
| customer_wallet_ledger | 0 | 0 |
| driver_statements | 0 | 0 |
| statement_runs | 4 | 0 |
| payout_items | 5 | 0 |
| payout_batches | 0 | 0 |

`driver_wallets` cache rows: all `available_pence`, `pending_pence`, and `lifetime_earned_pence` reset to 0.

## Rows retained (untouched)

- drivers: 5
- customers: 7
- vehicles: 5
- service_areas: 3
- All settings tables: dispatch_settings, global_dispatch_settings, stop_waiting_settings, qr_booking_config, statement_schedule_configs, preset_offers, preset_offer_configs, offers
- Documents, marketplace, merchants, Stripe configuration, payment configuration, edge functions, cron jobs — untouched
- Auth (auth.users), user_roles — untouched

## Payment-records retention

No deletes were issued against Stripe PaymentIntent IDs, payment audit logs, or webhook history. Stripe IDs that previously lived on `trips.stripe_payment_intent_id` were removed only as a consequence of clearing trip rows themselves (the trips that referenced them no longer exist). The Stripe-side records remain intact in Stripe; if you need a queryable archive of those PIs inside this DB, request a dedicated archive table and we will copy the IDs before any future reset.

## Verification (post-reset)

- Trips: 0 active / 0 completed / 0 cancelled ✅
- Revenue (driver_wallet_ledger): 0 entries → £0 earnings, £0 commission ✅
- Payouts: 0 payout_items, 0 payout_batches ✅
- driver_wallets balances: all zero ✅
- Drivers, customers, vehicles, service areas: unchanged ✅
- Settings & configuration: unchanged ✅

## Rollback notes

This reset is **destructive and not rollback-able from within the app**. Recovery options:

1. **Supabase PITR** — restore the project to a point-in-time before this migration ran via the Supabase dashboard (Database → Backups). Use the migration timestamp above.
2. **Logical backup** — if a `pg_dump` was taken before the reset, restore the affected tables only.
3. No application-level undo exists; do not re-run analogous DELETEs expecting reversal.

## Migration

Applied as a single transactional migration. Order of deletes was chosen so that `dispatch_wave_snapshot` (which has an `ON DELETE SET NULL` FK to `ride_offers` and a unique index that treats NULLs via `COALESCE`) is cleared before `ride_offers`, avoiding a unique-constraint violation.

## Stopped

Per instructions: no further migrations, no payment reconciliation, no settings changes, no driver/customer/Stripe deletions, no code removal.
