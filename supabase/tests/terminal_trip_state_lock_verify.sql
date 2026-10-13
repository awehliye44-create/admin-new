-- Terminal trip state lock verification (scratch Postgres only — never production).
--
--   createdb onecab_terminal_lock_scratch
--   psql -v ON_ERROR_STOP=1 -d onecab_terminal_lock_scratch \
--     -f supabase/tests/terminal_trip_state_lock_verify.sql
--   dropdb onecab_terminal_lock_scratch
--
-- Bootstraps a production-shaped subset, applies
-- 20261216200000_terminal_trip_state_lock.sql, asserts every transition rule and
-- RPC guard, then applies the rollback and asserts the previous behaviour returns.

\set QUIET on
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.is_trip_terminal_cancel_status(p_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT lower(COALESCE(p_status, '')) IN (
    'cancelled', 'canceled', 'customer_cancelled', 'customer_canceled',
    'expired', 'expired_no_driver', 'no_show', 'declined', 'failed'
  );
$function$;

CREATE TABLE public.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_code text,
  status text NOT NULL,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text,
  cancellation_reason text,
  cancelled_by_role text,
  negotiation_owner_driver_id uuid,
  current_offer_driver_id uuid,
  negotiation_locked_until timestamptz,
  current_offer_expires_at timestamptz,
  searching_expires_at timestamptz,
  dispatch_status text,
  negotiation_status text,
  scheduled_status text,
  is_scheduled boolean DEFAULT false,
  scheduled_at timestamptz,
  special_instructions text,
  driver_id uuid,
  confirmed_driver_id uuid,
  passenger_id uuid,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.drivers (id uuid PRIMARY KEY, current_trip_id uuid, updated_at timestamptz);
CREATE TABLE public.customers (id uuid PRIMARY KEY, active_trip_id uuid, updated_at timestamptz);
CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid, status text, revoked_reason text, negotiation_status text, updated_at timestamptz
);
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  user_id uuid, driver_id uuid, trip_id uuid,
  details jsonb, ip_address text, user_agent text,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, UPDATE ON public.trips TO authenticated, service_role;
GRANT INSERT ON public.audit_logs TO service_role;

\ir ../migrations/20261216200000_terminal_trip_state_lock.sql

CREATE OR REPLACE FUNCTION pg_temp.expect_locked(p_id uuid, p_sql text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql USING p_id;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'TERMINAL_STATE_LOCKED:%' THEN
      RAISE EXCEPTION 'unexpected error for %: %', p_sql, SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL: expected TERMINAL_STATE_LOCKED for %', p_sql;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.expect_ok(p_id uuid, p_sql text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql USING p_id;
END $$;

DO $$
DECLARE
  v_completed uuid; v_cust_cancel uuid; v_cust_cancel2 uuid; v_drv_cancel uuid;
  v_drv_reason_cancel uuid; v_expired uuid; v_expired2 uuid; v_active uuid;
  v_sched uuid; v_neg_done uuid; v_neg_cancelled uuid; v_neg_active uuid;
  v_driver uuid := gen_random_uuid(); v_customer uuid := gen_random_uuid();
  v_res jsonb; v_row public.trips%ROWTYPE;
BEGIN
  INSERT INTO public.drivers VALUES (v_driver, NULL, now());
  INSERT INTO public.customers VALUES (v_customer, NULL, now());

  INSERT INTO public.trips (status, completed_at, driver_id, passenger_id)
    VALUES ('completed', now(), v_driver, v_customer) RETURNING id INTO v_completed;
  INSERT INTO public.trips (status, cancelled_by) VALUES ('cancelled', 'rider') RETURNING id INTO v_cust_cancel;
  INSERT INTO public.trips (status, cancelled_by) VALUES ('customer_cancelled', 'customer') RETURNING id INTO v_cust_cancel2;
  INSERT INTO public.trips (status, cancelled_by) VALUES ('cancelled', 'driver') RETURNING id INTO v_drv_cancel;
  INSERT INTO public.trips (status, cancel_reason) VALUES ('cancelled', 'driver_cancelled') RETURNING id INTO v_drv_reason_cancel;
  INSERT INTO public.trips (status) VALUES ('expired') RETURNING id INTO v_expired;
  INSERT INTO public.trips (status, is_scheduled) VALUES ('expired', true) RETURNING id INTO v_expired2;
  INSERT INTO public.trips (status, driver_id, passenger_id) VALUES ('in_progress', v_driver, v_customer) RETURNING id INTO v_active;
  INSERT INTO public.trips (status, is_scheduled, scheduled_at, scheduled_status, driver_id)
    VALUES ('scheduled', true, now() + interval '1 day', 'driver_assigned', v_driver) RETURNING id INTO v_sched;
  INSERT INTO public.trips (status, completed_at, driver_id) VALUES ('completed', now(), v_driver) RETURNING id INTO v_neg_done;
  INSERT INTO public.trips (status, driver_id) VALUES ('cancelled', v_driver) RETURNING id INTO v_neg_cancelled;
  INSERT INTO public.trips (status, is_scheduled, scheduled_status) VALUES ('offered', true, 'broadcasting') RETURNING id INTO v_neg_active;

  -- Completed trips are immutable in status and completed_at (MK-260923-017).
  PERFORM pg_temp.expect_locked(v_completed, 'UPDATE public.trips SET status = ''cancelled'' WHERE id = $1');
  PERFORM pg_temp.expect_locked(v_completed, 'UPDATE public.trips SET status = ''searching'' WHERE id = $1');
  PERFORM pg_temp.expect_locked(v_completed, 'UPDATE public.trips SET completed_at = NULL WHERE id = $1');
  PERFORM pg_temp.expect_ok(v_completed, 'UPDATE public.trips SET updated_at = now() WHERE id = $1');

  -- Customer-cancelled trips cannot be resurrected by dispatch (MK-260916-029/030, MK-261003-003).
  PERFORM pg_temp.expect_locked(v_cust_cancel, 'UPDATE public.trips SET status = ''searching'' WHERE id = $1');
  PERFORM pg_temp.expect_locked(v_cust_cancel, 'UPDATE public.trips SET status = ''scheduled'' WHERE id = $1');
  PERFORM pg_temp.expect_locked(v_cust_cancel, 'UPDATE public.trips SET status = ''searching_new_driver'' WHERE id = $1');
  PERFORM pg_temp.expect_locked(v_cust_cancel2, 'UPDATE public.trips SET status = ''offered'' WHERE id = $1');
  PERFORM pg_temp.expect_locked(v_expired2, 'UPDATE public.trips SET status = ''scheduled'' WHERE id = $1');

  -- Carve-outs used by customer-resume-driver-search.
  PERFORM pg_temp.expect_ok(v_drv_cancel, 'UPDATE public.trips SET status = ''searching_new_driver'' WHERE id = $1');
  PERFORM pg_temp.expect_ok(v_drv_reason_cancel, 'UPDATE public.trips SET status = ''searching_new_driver'' WHERE id = $1');
  PERFORM pg_temp.expect_ok(v_expired, 'UPDATE public.trips SET status = ''searching_new_driver'' WHERE id = $1');

  -- Terminal-to-terminal and normal lifecycle remain allowed.
  PERFORM pg_temp.expect_ok(v_cust_cancel, 'UPDATE public.trips SET status = ''customer_cancelled'' WHERE id = $1');
  PERFORM pg_temp.expect_ok(v_active, 'UPDATE public.trips SET status = ''completed'', completed_at = now() WHERE id = $1');

  -- apply_terminal_trip_cancellation refuses completed trips and terminalises scheduled_status.
  v_res := public.apply_terminal_trip_cancellation(v_completed, 'admin', 'cancelled_by_admin');
  IF v_res->>'error' IS DISTINCT FROM 'COMPLETED_TRIP_NOT_CANCELLABLE' OR (v_res->>'success')::boolean THEN
    RAISE EXCEPTION 'FAIL apply_terminal_trip_cancellation(completed): %', v_res;
  END IF;
  SELECT * INTO v_row FROM public.trips WHERE id = v_completed;
  IF v_row.status <> 'completed' OR v_row.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL completed trip mutated: % %', v_row.status, v_row.cancelled_at;
  END IF;

  v_res := public.apply_terminal_trip_cancellation(v_sched, 'admin', NULL);
  SELECT * INTO v_row FROM public.trips WHERE id = v_sched;
  IF NOT (v_res->>'success')::boolean OR v_row.status <> 'cancelled' OR v_row.scheduled_status <> 'cancelled'
     OR v_row.driver_id IS DISTINCT FROM v_driver THEN
    RAISE EXCEPTION 'FAIL scheduled cancel: % status=% scheduled_status=% driver=%', v_res, v_row.status, v_row.scheduled_status, v_row.driver_id;
  END IF;

  v_res := public.apply_terminal_trip_cancellation(v_sched, 'admin', NULL);
  IF NOT (v_res->>'already_terminal')::boolean THEN
    RAISE EXCEPTION 'FAIL already_terminal not reported: %', v_res;
  END IF;

  -- admin_cancel_trip_negotiation guards.
  v_res := public.admin_cancel_trip_negotiation(v_neg_done, 'admin_cancelled');
  SELECT * INTO v_row FROM public.trips WHERE id = v_neg_done;
  IF v_res->>'error' IS DISTINCT FROM 'COMPLETED_TRIP_NOT_CANCELLABLE' OR v_row.status <> 'completed' OR v_row.driver_id IS NULL THEN
    RAISE EXCEPTION 'FAIL negotiation cancel on completed: % %', v_res, v_row.status;
  END IF;
  v_res := public.admin_cancel_trip_negotiation(v_neg_cancelled, 'admin_cancelled');
  SELECT * INTO v_row FROM public.trips WHERE id = v_neg_cancelled;
  IF NOT (v_res->>'already_terminal')::boolean OR v_row.driver_id IS DISTINCT FROM v_driver THEN
    RAISE EXCEPTION 'FAIL negotiation cancel on cancelled: % driver=%', v_res, v_row.driver_id;
  END IF;
  v_res := public.admin_cancel_trip_negotiation(v_neg_active, 'admin_cancelled');
  SELECT * INTO v_row FROM public.trips WHERE id = v_neg_active;
  IF NOT (v_res->>'success')::boolean OR v_row.status <> 'cancelled' OR v_row.scheduled_status <> 'cancelled' THEN
    RAISE EXCEPTION 'FAIL negotiation cancel on active: % % %', v_res, v_row.status, v_row.scheduled_status;
  END IF;
  v_res := public.admin_cancel_trip_negotiation(gen_random_uuid(), 'admin_cancelled');
  IF v_res->>'error' IS DISTINCT FROM 'TRIP_NOT_FOUND' THEN
    RAISE EXCEPTION 'FAIL negotiation cancel missing trip: %', v_res;
  END IF;

  CREATE TEMP TABLE lock_ids (k text PRIMARY KEY, id uuid);
  INSERT INTO lock_ids VALUES ('completed', v_completed), ('cust_cancel', v_cust_cancel2);
  GRANT SELECT ON lock_ids TO authenticated, service_role;
  RAISE NOTICE 'PASS transitions and RPC guards';
END $$;

-- An earlier BEFORE trigger rewriting status on an update that never set status
-- is still caught, because the lock fires last on every update.
CREATE FUNCTION pg_temp.rewrite_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.special_instructions = 'rewrite' THEN NEW.status := 'searching'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aa_rewrite_status BEFORE UPDATE ON public.trips FOR EACH ROW EXECUTE FUNCTION pg_temp.rewrite_status();
DO $$
BEGIN
  PERFORM pg_temp.expect_locked((SELECT id FROM lock_ids WHERE k = 'cust_cancel'),
    'UPDATE public.trips SET special_instructions = ''rewrite'' WHERE id = $1');
  RAISE NOTICE 'PASS lock sees status rewritten by an earlier trigger';
END $$;
DROP TRIGGER aa_rewrite_status ON public.trips;

-- Override: an authenticated caller cannot bypass with the GUC.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('onecab.terminal_state_override', 'attempted bypass', true) \g /dev/null
DO $$
BEGIN
  PERFORM pg_temp.expect_locked((SELECT id FROM lock_ids WHERE k = 'completed'),
    'UPDATE public.trips SET status = ''cancelled'' WHERE id = $1');
  RAISE NOTICE 'PASS authenticated override refused';
END $$;
ROLLBACK;

-- Override: service_role with a reason may restore a trip, and it is audited.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('onecab.terminal_state_override', 'verify restore', true) \g /dev/null
UPDATE public.trips SET status = 'searching' WHERE id = (SELECT id FROM lock_ids WHERE k = 'cust_cancel');
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.audit_logs
  WHERE event_type = 'TERMINAL_STATE_OVERRIDE'
    AND trip_id = (SELECT id FROM lock_ids WHERE k = 'cust_cancel')
    AND details->>'reason' = 'verify restore'
    AND details->>'violation' = 'TERMINAL_TRIP_REOPENED'
    AND details->>'db_current_user' = 'service_role';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL override audit rows = %', v_n; END IF;
  RAISE NOTICE 'PASS service_role override audited';
END $$;
ROLLBACK;

-- Override does not persist past the transaction.
DO $$
BEGIN
  PERFORM pg_temp.expect_locked((SELECT id FROM lock_ids WHERE k = 'cust_cancel'),
    'UPDATE public.trips SET status = ''searching'' WHERE id = $1');
  RAISE NOTICE 'PASS override is transaction-scoped';
END $$;

-- ACL: only service_role may execute the cancellation RPCs.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.apply_terminal_trip_cancellation(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.apply_terminal_trip_cancellation(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_cancel_trip_negotiation(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admin_cancel_trip_negotiation(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.apply_terminal_trip_cancellation(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.admin_cancel_trip_negotiation(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL RPC ACL';
  END IF;
  RAISE NOTICE 'PASS RPC ACL';
END $$;

\ir ../migrations/rollback/rollback_20261216200000_terminal_trip_state_lock.sql

DO $$
DECLARE v_res jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_enforce_trip_terminal_state_lock')
     OR to_regprocedure('public.enforce_trip_terminal_state_lock()') IS NOT NULL
     OR to_regprocedure('public.trip_terminal_state_override_reason()') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL rollback left lock objects';
  END IF;
  v_res := public.apply_terminal_trip_cancellation((SELECT id FROM lock_ids WHERE k = 'completed'), 'admin', NULL);
  IF NOT (v_res->>'success')::boolean
     OR (SELECT status FROM public.trips WHERE id = (SELECT id FROM lock_ids WHERE k = 'completed')) <> 'cancelled' THEN
    RAISE EXCEPTION 'FAIL rollback did not restore previous RPC behaviour: %', v_res;
  END IF;
  RAISE NOTICE 'PASS rollback restores previous definitions';
END $$;
