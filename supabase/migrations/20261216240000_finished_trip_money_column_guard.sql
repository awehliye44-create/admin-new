-- Finished-trip money column guard (security follow-up to P1).
--
-- The driver UPDATE policies on trips ("Drivers can update assigned trips",
-- "Drivers can update their assigned trips") have no status or column limit.
-- zz_enforce_trip_terminal_state_lock already stops a finished trip changing
-- status or losing completed_at, but a driver could still PATCH the fare,
-- capture, commission, payment or outcome columns of their own completed or
-- cancelled trip straight through the REST API.
--
-- This guard rejects those direct writes. It only applies when the statement
-- runs as the `authenticated` role, i.e. a client writing through RLS:
--   - service_role (Edge Functions) and postgres are unaffected;
--   - SECURITY DEFINER RPCs (driver_rate_passenger, accept_scheduled_ride, ...)
--     run as their owner and are unaffected;
--   - Admin web writes are allowed (has_role admin);
--   - live trips are unaffected.
--
-- Rollback: supabase/migrations/rollback/rollback_20261216240000_finished_trip_money_column_guard.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.finished_trip_locked_money_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'accepted_commission_percent', 'accepted_driver_offer_fare_pence', 'accepted_preset_offer_fare_pence',
    'airport_charge_pence', 'applied_offer_code', 'applied_offer_id', 'applied_personal_voucher_code',
    'applied_personal_voucher_id', 'arrival_cancellation_fee', 'authorised_amount_pence',
    'authorized_amount_pence', 'base_fare_pence', 'cancellation_fee_pence', 'capture_amount_pence',
    'commission_pct', 'commission_pence', 'commission_wallet_enabled', 'commissionable_fare_pence',
    'currency', 'currency_code', 'customer_modification_charge_pence', 'debt_recovery_pence',
    'destination_change_adjustment_pence', 'discount_pence', 'discount_source', 'driver_net_amount',
    'driver_net_before_tip_pence', 'driver_net_pence', 'driver_payment_confirmed_at',
    'driver_tier_commission_percent', 'driver_total_earnings_pence', 'estimated_fare',
    'estimated_total_pence', 'extras_pence', 'fare', 'fare_amount', 'fare_breakdown',
    'fare_engine_config_id', 'fare_locked', 'fare_locked_at', 'fare_revision_number', 'fare_snapshot_json',
    'final_customer_fare_pence', 'final_fare_pence', 'final_payout_pence', 'financial_model',
    'financial_outcome', 'gross_fare_pence', 'invoice_outstanding_pence', 'invoice_paid_pence',
    'invoice_payment_classification', 'invoice_payment_evidence_ids', 'invoice_payment_evidence_source',
    'invoice_payment_resolved_at', 'invoice_total_paid_pence', 'late_cancel_fee_pence',
    'locked_base_fare_pence', 'locked_offer_type', 'max_wave_commission_reduction_percent',
    'modification_delta_pence', 'no_show_charge_pence', 'offer_currency', 'offer_discount_pence',
    'offer_snapshot', 'onecab_net_pence', 'original_payment_method', 'other_pass_through_charges_pence',
    'outstanding_balance_pence', 'payment_collection_model', 'payment_coverage_status', 'payment_deferred',
    'payment_hold_status', 'payment_intent_id', 'payment_intent_version', 'payment_method',
    'payment_provider', 'payment_reauth_at', 'payment_reauth_status', 'payment_session_id',
    'payment_state', 'payment_status', 'payment_type', 'pickup_waiting_charge_pence',
    'pickup_waiting_chargeable_seconds', 'pickup_waiting_intervals_charged', 'platform_commission_amount',
    'platform_gross_revenue_pence', 'platform_net_revenue_pence', 'platform_promotion_subsidy_pence',
    'preauth_buffer_pence', 'provider_charge_id', 'provider_fee_pence', 'provider_payment_id',
    'provider_payout_id', 'quoted_fare_pence', 'refund_amount_pence', 'refund_reason', 'refunded_at',
    'settlement_formula_version', 'snapshotted_commission_currency', 'snapshotted_commission_rate_bps',
    'stop_charge_total_pence', 'stop_waiting_charge_amount', 'stop_waiting_charge_pence',
    'tip_amount_pence', 'tip_pence', 'tip_window_capture_idempotency_key', 'total_authorized_amount_pence',
    'total_waiting_charge_pence', 'voucher_discount_pence', 'waiting_charge_pence', 'wallet_applied_pence'
  ]::text[];
$function$;

CREATE OR REPLACE FUNCTION public.guard_finished_trip_money_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_changed text[];
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF lower(COALESCE(OLD.status, '')) <> 'completed'
     AND OLD.completed_at IS NULL
     AND NOT public.is_trip_terminal_cancel_status(lower(COALESCE(OLD.status, ''))) THEN
    RETURN NEW;
  END IF;

  IF public.has_role(auth.uid(), 'admin'::app_role) THEN
    RETURN NEW;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  SELECT array_agg(c ORDER BY c) INTO v_changed
  FROM unnest(public.finished_trip_locked_money_columns()) AS c
  WHERE v_old -> c IS DISTINCT FROM v_new -> c;

  IF v_changed IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'FINISHED_TRIP_MONEY_LOCKED: % (trip %)', array_to_string(v_changed, ', '), OLD.id
    USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS aa_guard_finished_trip_money_columns ON public.trips;
-- Named to fire before every other BEFORE UPDATE trigger on trips (alphabetical
-- order) so it judges only the columns the caller sent, not values that later
-- triggers derive (trg_stamp_platform_promotion_subsidy).
CREATE TRIGGER aa_guard_finished_trip_money_columns
  BEFORE UPDATE ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_finished_trip_money_columns();

-- Runs with caller rights from the trips trigger.
GRANT EXECUTE ON FUNCTION public.finished_trip_locked_money_columns() TO authenticated, service_role;

COMMIT;
