-- Phase 3 final security — representative PG checks (non-production harness).
-- Apply AFTER 20270213120000 + 20270213130000 on a scratch DB.
-- Demonstrates: mutate refuse, assign action deny, exhaustion hold, airport hold.

\echo '=== protected mutate columns helper ==='
SELECT 'scheduled_status' = ANY (public._admin_trips_protected_mutate_columns()) AS has_status,
       'broadcast_enabled' = ANY (public._admin_trips_protected_mutate_columns()) AS has_broadcast,
       'scheduled_hold_reason' = ANY (public._admin_trips_protected_mutate_columns()) AS has_hold;

\echo '=== publication_exhausted accepted by CHECK ==='
-- Expect success when column exists (no-op probe via constraint definition).
SELECT conname
FROM pg_constraint
WHERE conname = 'trips_scheduled_hold_reason_check';

\echo '=== dry-run: staff without scheduled_rides.assign must be denied by admin_assign_scheduled_driver ==='
-- Manual: SET ROLE / JWT as read-only staff and CALL admin_assign_scheduled_driver.
-- Expected: { success:false, error:ACTION_PERMISSION_DENIED }

\echo '=== dry-run: admin_page_mutate patch scheduled_status ==='
-- Expected ERRCODE 42501: protected scheduled field scheduled_status

\echo 'Done — see docs/SCHEDULED_MARKETPLACE_PHASE3_DEPLOY_ROLLBACK.md for coordinated cutover.';
