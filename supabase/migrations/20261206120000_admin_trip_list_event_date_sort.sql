-- Admin Trip History + Missed & Cancelled: canonical list event date.
--
-- PostgREST computed columns so both Admin lists ORDER BY the canonical event
-- date on the database, before LIMIT / RANGE / keyset cursor boundaries.
-- Read-only expressions over existing columns: no writes, no backfill, and
-- completed_at is never manufactured for terminal outcomes.
--
-- Mirrored in src/lib/adminTripListDateSort.ts (tripHistoryEventAt /
-- missedCancelledEventAt); adminTripListDateSort.test.ts locks the parity.

create or replace function public.trip_history_event_at(t public.trips)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  -- COMPLETED -> completed_at. ARRIVAL_CANCELLATION / NO_SHOW /
  -- LATE_PASSENGER_CANCELLATION keep completed_at NULL -> terminal cancelled_at,
  -- then created_at (same precedence as the Trip History date window).
  select coalesce(t.completed_at, t.cancelled_at, t.created_at)
$$;

comment on function public.trip_history_event_at(public.trips) is
  'Admin Trip History canonical event date: completed_at, else terminal cancelled_at, else created_at. Sort/display only.';

create or replace function public.missed_cancelled_event_at(t public.trips)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  -- Cancellation time; missed / expired bookings without cancelled_at use
  -- created_at (their search window starts at booking).
  select coalesce(t.cancelled_at, t.created_at)
$$;

comment on function public.missed_cancelled_event_at(public.trips) is
  'Admin Missed & Cancelled canonical event date: cancelled_at, else created_at. Sort/display only.';

revoke all on function public.trip_history_event_at(public.trips) from public, anon;
revoke all on function public.missed_cancelled_event_at(public.trips) from public, anon;
grant execute on function public.trip_history_event_at(public.trips) to authenticated, service_role;
grant execute on function public.missed_cancelled_event_at(public.trips) to authenticated, service_role;
