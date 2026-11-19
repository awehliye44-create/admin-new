# Database steps that visitors can run without signing in (46)

Nothing has been changed yet. Each step was checked for its own safety check and for who actually uses it (admin site, backend, scheduled jobs).

## Real holes: 14 (fix recommended)
A visitor using only the public app key could run these. None of them check who is calling.

**Fake driver locations**
- `submit_driver_location_sample`: someone who isn't signed in can post GPS positions for **any driver**. That would move them on the Live Fleet map and could affect dispatch and trip location proof.
- `record_driver_location_publish_diag`: someone who isn't signed in can write fake location-diagnostic records for any driver.
- These two are used by the driver and rider apps, so signed-in use stays. The fix makes them reject callers who aren't signed in.

**Trip, fare and scheduling changes.** Only the backend or other database steps use these:
- `apply_consumed_server_fare_airport_split_to_trip`: rewrites a trip's airport and fare split
- `claim_and_apply_fare_increase_modification`: applies a fare increase to a trip
- `realign_trip_nav_after_modification`: changes a trip's route progress
- `claim_corporate_schedule_hold`: blocks a corporate account's booking slot
- `release_scheduled_assignment_for_compliance`: removes a driver from a scheduled ride
- `release_scheduled_assignment_for_driver_cancel`: removes a driver from a scheduled ride
- `release_ineligible_scheduled_assignments_for_driver`: removes a driver from all their scheduled rides
- `release_scheduled_airport_broadcast_hold`: releases a scheduled airport ride to drivers early
- `reconcile_scheduled_journey_compliance`: runs the scheduled-ride compliance sweep
- `classify_scheduled_capture_deadline_backfill`: payment-deadline repair tool
- `normalise_payment_gate_blocked_terminal_rows`: scheduled-ride status repair tool
- `purge_driver_location_publish_diagnostics`: deletes diagnostic history; only the nightly job needs it

Fix: only the backend can run these 12. Visitors and signed-in app users can't.

## Information leaks: 8 (fix recommended)
These only read data, but they tell a stranger things about drivers and trips: whether a driver's documents are valid, whether they're verified, whether they're eligible for a ride, schedule clashes, and pending fare increases.
- `check_driver_documents_valid_through`, `driver_has_completed_registration_verification`, `driver_eligible_for_scheduled_journey`, `assert_driver_scheduled_journey_compliance`, `evaluate_trip_schedule_conflict`, `trip_has_unresolved_fare_increase_modification`, `assert_trip_completion_customer_payment_gate`, `resolve_scheduled_overlap_buffer_minutes`

They're used only inside the database and by the backend. Fix: backend only.

## Already safe: 7 (tidy-up only)
Each one checks the caller and refuses anyone who isn't signed in, or who doesn't have the right staff permission or account:
- `admin_assign_scheduled_driver`, `admin_submit_driver_document`, `admin_driver_financial_repair_lock`, `get_customer_live_for_driver`, `get_driver_own_online_duration_seconds`, `touch_driver_offer_realtime_seen`, `upsert_customer_live_location`

Fix: remove access for visitors who aren't signed in. Signed-in staff and app users keep it.

## Not a risk: 17 (tidy-up only)
These only run automatically when a record changes. Nobody can start them directly. Removing visitor access just clears the warning.
- `deny_*` (7), `require_*_guc` (2), `enforce_trip_change_payment_before_apply`, `freeze_finance_shortfall_exception_evidence`, `release_scheduled_on_driver_account_change`, `seed_service_area_rules_for_document_type`, `tr_restamp_pending_offers_on_airport_stamp_fn`, `tr_trip_messages_reject_blocked_pair`, `trg_enqueue_driver_trip_bonus_progress`, `trips_enforce_customer_schedule_overlap`

## One thing I can't check
The driver and rider app code isn't in this project. If either app calls one of the "backend only" steps above directly, that screen would get a permission error after the fix. In this project's code, only the backend calls them.
