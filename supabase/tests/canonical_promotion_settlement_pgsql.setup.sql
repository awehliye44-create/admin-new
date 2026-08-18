-- Minimal schema for canonical promotion settlement pg harness.
\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS public;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres SUPERUSER LOGIN;
  END IF;
END;
$roles$;

CREATE TABLE IF NOT EXISTS public.trips (
  id uuid PRIMARY KEY,
  discount_source text,
  offer_discount_pence integer,
  discount_pence integer,
  locked_base_fare_pence integer,
  gross_fare_pence integer,
  base_fare_pence integer,
  estimated_total_pence integer,
  estimated_fare numeric,
  fare numeric,
  final_fare_pence integer,
  final_customer_fare_pence integer,
  fare_snapshot_json jsonb,
  airport_charge_pence integer DEFAULT 0,
  other_pass_through_charges_pence integer DEFAULT 0,
  customer_modification_charge_pence integer DEFAULT 0,
  accepted_commission_percent numeric,
  accepted_dispatch_wave integer,
  accepted_dispatch_round integer,
  max_wave_commission_reduction_percent numeric,
  commissionable_fare_pence integer,
  commission_pence integer,
  driver_net_pence integer,
  driver_net_before_tip_pence integer,
  driver_total_earnings_pence integer,
  platform_gross_revenue_pence integer,
  platform_net_revenue_pence integer,
  onecab_net_pence integer,
  settlement_formula_version text,
  commission_pct numeric,
  driver_tier_commission_percent numeric,
  snapshotted_commission_rate_bps integer,
  locked_offer_type text,
  accepted_driver_offer_fare_pence integer,
  accepted_preset_offer_fare_pence integer,
  accepted_ride_offer_id uuid,
  fare_locked boolean,
  fare_locked_at timestamptz,
  fare_breakdown jsonb,
  service_area_id uuid,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ride_offers (
  id uuid PRIMARY KEY,
  trip_id uuid REFERENCES public.trips(id),
  effective_commission_percent numeric,
  dispatch_wave integer,
  dispatch_round integer,
  wave_commission_reduction_percent numeric,
  offered_driver_net_pence integer,
  counter_fare integer,
  offer_snapshot jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.resolve_driver_tier_commission_percent(p_driver_id uuid, p_service_area_id uuid)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 15::numeric; $$;

TRUNCATE public.ride_offers, public.trips CASCADE;
