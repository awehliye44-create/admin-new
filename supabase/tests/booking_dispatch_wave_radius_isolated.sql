-- ============================================================
-- Isolated Postgres integration — Admin booking dispatch wave radii.
--
-- Loads, unmodified:
--   * public.dispatch_trip_offers(uuid, text) from
--     20261203120000_dispatch_online_gate_intent_or_is_online_mk260926004.sql
--     (extracted by the runner into :dispatch_fn_file)
--   * 20261204140000_booking_dispatch_wave_radius_admin_ssot.sql (twice: idempotency)
-- on stub tables matching production for global_dispatch_settings: the
-- valid_radii constraint, RLS policy, grants and has_role are copied verbatim.
-- The dispatcher's other dependencies are stubs; the integration test drives
-- it through its search-window-elapsed branch, which returns the wave radius
-- it selected before any candidate query runs.
--
-- Run ONLY against a disposable database:
--   scripts/run-booking-dispatch-radius-isolated.sh
-- ============================================================
\set ON_ERROR_STOP 1
SET client_min_messages = warning;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('admin', 'driver', 'customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);

-- Production has_role (verbatim).
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND _user_id IS NOT DISTINCT FROM auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = _user_id
        AND user_roles.role = _role
    )
$function$;

CREATE TABLE public.global_dispatch_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE,
  start_radius_meters integer NOT NULL DEFAULT 4000,
  expand_radius_meters integer NOT NULL DEFAULT 8000,
  max_radius_meters integer NOT NULL DEFAULT 13000,
  wave1_size integer NOT NULL DEFAULT 3,
  wave2_size integer NOT NULL DEFAULT 5,
  wave3_size integer NOT NULL DEFAULT 10,
  wave1_offer_expiry_seconds integer NOT NULL DEFAULT 40,
  wave2_offer_expiry_seconds integer NOT NULL DEFAULT 45,
  wave3_offer_expiry_seconds integer NOT NULL DEFAULT 50,
  max_driver_find_time_minutes integer NOT NULL DEFAULT 3,
  max_dispatch_rounds integer NOT NULL DEFAULT 3,
  presence_max_age_seconds integer NOT NULL DEFAULT 60,
  stacked_search_radius_meters integer NOT NULL DEFAULT 2000,
  customer_nearby_drivers_radius_meters integer NOT NULL DEFAULT 25000,
  towards_destination_matching_tolerance_meters integer NOT NULL DEFAULT 200,
  towards_destination_arrival_radius_meters integer NOT NULL DEFAULT 500,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT singleton_must_be_true CHECK ((singleton = true)),
  CONSTRAINT valid_radii CHECK (((start_radius_meters > 0) AND (expand_radius_meters >= start_radius_meters) AND (max_radius_meters >= expand_radius_meters)))
);
-- Live values on 2026-10-02.
INSERT INTO public.global_dispatch_settings
  (start_radius_meters, expand_radius_meters, max_radius_meters, stacked_search_radius_meters)
VALUES (13000, 17000, 29000, 7000);

ALTER TABLE public.global_dispatch_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage global dispatch settings" ON public.global_dispatch_settings
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON public.global_dispatch_settings TO anon, authenticated, service_role;

-- ── Stubs for dispatch_trip_offers(uuid, text) up to its radius decision ──
CREATE TABLE public.trips (
  id uuid PRIMARY KEY,
  trip_code text,
  dispatch_mode text,
  scheduled_status text,
  is_scheduled boolean NOT NULL DEFAULT false,
  scheduled_at timestamptz,
  current_broadcast_round integer NOT NULL DEFAULT 0,
  max_broadcast_rounds integer,
  broadcast_enabled boolean NOT NULL DEFAULT true,
  negotiation_owner_driver_id uuid,
  status text NOT NULL DEFAULT 'searching',
  searching_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  max_wave_commission_reduction_percent numeric
);
CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid, driver_id uuid, status text, negotiation_status text,
  expires_at timestamptz, broadcast_round integer
);
CREATE TABLE public.dispatch_round_advance_log (
  trip_id uuid NOT NULL, previous_round integer NOT NULL, trigger_reason text,
  UNIQUE (trip_id, previous_round)
);
CREATE TABLE public.search_exhausted_calls (trip_id uuid, called_at timestamptz DEFAULT now());

CREATE FUNCTION public.is_scheduled_instant_conversion_pending(text, text, boolean, timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$;
CREATE FUNCTION public.assert_payment_gate(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION public.dispatch_max_broadcast_rounds(jsonb, integer) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 9 $$;
CREATE FUNCTION public.expire_trip_when_search_exhausted(p_trip_id uuid) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.search_exhausted_calls(trip_id) VALUES (p_trip_id); END $$;

-- Legacy overloads (production signatures) that ignore Admin radii.
CREATE FUNCTION public.dispatch_trip_offers(p_trip_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ BEGIN END $$;
CREATE FUNCTION public.dispatch_trip_offers(p_trip_id uuid, p_internal boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ BEGIN END $$;
REVOKE ALL ON FUNCTION public.dispatch_trip_offers(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_trip_offers(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_trip_offers(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dispatch_trip_offers(uuid, boolean) TO service_role;

-- Real production dispatcher.
\i :dispatch_fn_file
REVOKE ALL ON FUNCTION public.dispatch_trip_offers(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_trip_offers(uuid, text) TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.trips, public.ride_offers TO service_role;

-- ── Migration under test (applied twice: must be idempotent) ──
\ir ../migrations/20261204140000_booking_dispatch_wave_radius_admin_ssot.sql
\ir ../migrations/20261204140000_booking_dispatch_wave_radius_admin_ssot.sql

-- ── Assertions ──
DO $assert$
DECLARE
  r record;
  v_failed boolean;
BEGIN
  SELECT * INTO r FROM public.global_dispatch_settings WHERE singleton;
  IF (r.start_radius_meters, r.expand_radius_meters, r.max_radius_meters) <> (13000, 17000, 29000) THEN
    RAISE EXCEPTION 'migration changed live wave radii: %/%/%', r.start_radius_meters, r.expand_radius_meters, r.max_radius_meters;
  END IF;
  IF r.towards_destination_match_radius_meters IS DISTINCT FROM 13000 THEN
    RAISE EXCEPTION 'towards-destination radius not initialised from Wave 1: %', r.towards_destination_match_radius_meters;
  END IF;
  IF r.customer_nearby_drivers_radius_meters <> 25000 OR r.stacked_search_radius_meters <> 7000 THEN
    RAISE EXCEPTION 'migration touched customer nearby or stacked radius';
  END IF;

  IF (SELECT string_agg(pg_get_expr(d.adbin, d.adrelid), ',' ORDER BY a.attname)
        FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       WHERE d.adrelid = 'public.global_dispatch_settings'::regclass
         AND a.attname IN ('start_radius_meters', 'expand_radius_meters', 'max_radius_meters'))
     <> '17000,29000,13000' THEN
    RAISE EXCEPTION 'column defaults not set to the live effective values';
  END IF;

  IF col_description('public.global_dispatch_settings'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.global_dispatch_settings'::regclass
          AND attname = 'expand_radius_meters')) NOT LIKE '%Wave 2 radius%NOT an increment%' THEN
    RAISE EXCEPTION 'expand_radius_meters comment missing absolute Wave 2 semantics';
  END IF;

  IF NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.global_dispatch_settings'::regclass
            AND attname = 'towards_destination_match_radius_meters') THEN
    RAISE EXCEPTION 'towards_destination_match_radius_meters must be NOT NULL';
  END IF;

  IF has_function_privilege('service_role', 'public.dispatch_trip_offers(uuid)', 'execute')
     OR has_function_privilege('service_role', 'public.dispatch_trip_offers(uuid, boolean)', 'execute')
     OR has_function_privilege('authenticated', 'public.dispatch_trip_offers(uuid)', 'execute') THEN
    RAISE EXCEPTION 'legacy dispatch_trip_offers overloads still executable';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.dispatch_trip_offers(uuid, text)', 'execute') THEN
    RAISE EXCEPTION 'Admin-driven dispatch_trip_offers(uuid, text) lost service_role EXECUTE';
  END IF;

  -- Constraint matrix (service role bypasses RLS; constraints still apply).
  FOR r IN SELECT * FROM (VALUES
    ('wave1 below 500 m',         'UPDATE public.global_dispatch_settings SET start_radius_meters = 499 WHERE singleton'),
    ('wave3 above 100 km',        'UPDATE public.global_dispatch_settings SET max_radius_meters = 100001 WHERE singleton'),
    ('wave2 below wave1',         'UPDATE public.global_dispatch_settings SET expand_radius_meters = 12000 WHERE singleton'),
    ('wave3 below wave2',         'UPDATE public.global_dispatch_settings SET max_radius_meters = 16000 WHERE singleton'),
    ('towards radius zero',       'UPDATE public.global_dispatch_settings SET towards_destination_match_radius_meters = 0 WHERE singleton'),
    ('towards radius null',       'UPDATE public.global_dispatch_settings SET towards_destination_match_radius_meters = NULL WHERE singleton')
  ) AS t(label, stmt) LOOP
    v_failed := false;
    BEGIN
      EXECUTE r.stmt;
    EXCEPTION WHEN check_violation OR not_null_violation THEN
      v_failed := true;
    END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'constraint did not reject: %', r.label;
    END IF;
  END LOOP;

  -- Boundaries accepted, then restored.
  UPDATE public.global_dispatch_settings
     SET start_radius_meters = 500, expand_radius_meters = 500, max_radius_meters = 100000 WHERE singleton;
  UPDATE public.global_dispatch_settings
     SET start_radius_meters = 13000, expand_radius_meters = 17000, max_radius_meters = 29000 WHERE singleton;
END
$assert$;

\echo 'booking_dispatch_wave_radius_isolated: schema + migration assertions passed'
