-- DETERMINISTIC ROLLBACK for P0 security hardening (20260831120000–20260831120300)
-- Generated from live production ACL snapshot captured 2026-08-31 (project thazislrdkjpvvghtvzo)
-- Execute ONLY to revert a failed P0 deploy. Does NOT restore pre-P0 security posture intentionally.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) OTP country — drop new RPC, restore table read policy + grants
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_enabled_otp_country_codes();
DROP POLICY IF EXISTS "Anyone can read enabled OTP countries" ON public.otp_allowed_countries;
CREATE POLICY "Anyone can read enabled OTP countries"
  ON public.otp_allowed_countries FOR SELECT TO public USING (is_enabled = true);
GRANT SELECT ON TABLE public.otp_allowed_countries TO anon;

-- ---------------------------------------------------------------------------
-- 2) Corporate requests — restore anonymous direct INSERT policy
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anonymous can submit account requests" ON public.corporate_account_requests;
CREATE POLICY "Anonymous can submit account requests"
  ON public.corporate_account_requests FOR INSERT TO anon
  WITH CHECK ((user_id IS NULL) AND (status = 'pending'::text));
GRANT INSERT ON TABLE public.corporate_account_requests TO anon;

-- ---------------------------------------------------------------------------
-- 3) search_path — restore pre-P0 values from production snapshot
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.driver_wallet_provider_funds_cleared(text) RESET search_path;
ALTER FUNCTION public.enforce_negotiation_pre_hold_assignment() RESET search_path;
ALTER FUNCTION public.is_scheduled_instant_conversion_pending(text,text,boolean,timestamp with time zone) RESET search_path;
ALTER FUNCTION public.trg_payout_item_ledger_allocations_immutable() RESET search_path;
ALTER FUNCTION public.payout_item_status_releases_ledger_allocation(text,text) RESET search_path;
ALTER FUNCTION public.payout_ledger_type_is_payout_eligible(text) RESET search_path;
ALTER FUNCTION public.resolve_trip_locked_promotion_pence(trips) RESET search_path;
ALTER FUNCTION public.trip_promotion_superseded_by_negotiation(trips) RESET search_path;
ALTER FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(trips) RESET search_path;
ALTER FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(trips,integer) RESET search_path;
ALTER FUNCTION public.resolve_trip_commissionable_fare_pence(trips,integer,integer,integer) RESET search_path;

-- ---------------------------------------------------------------------------
-- 4) RPC EXECUTE privileges — restore exact production ACLs
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_driver_financial_summaries(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_driver_financial_summaries(uuid,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_driver_financial_summaries(uuid,uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.admin_driver_financial_summaries(uuid,uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_driver_financial_summaries(uuid,uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_driver_financial_summaries(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_driver_financial_summaries(uuid,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_driver_wallet_eligibility_balances(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_driver_wallet_eligibility_balances(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.admin_driver_wallet_eligibility_balances(uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.admin_driver_wallet_eligibility_balances(uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_driver_wallet_eligibility_balances(uuid[]) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_driver_wallet_eligibility_balances(uuid[]) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_driver_wallet_eligibility_balances(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_driver_wallet_eligibility_balances(uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.assert_payout_item_ledger_lineage(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_payout_item_ledger_lineage(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_payout_item_ledger_lineage(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_payout_item_ledger_lineage(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.assert_payout_item_ledger_lineage(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.assert_payout_item_ledger_lineage(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_payout_item_ledger_lineage(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_email_available_for_change(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_email_available_for_change(text,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.check_email_available_for_change(text,uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.check_email_available_for_change(text,uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.check_email_available_for_change(text,uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.check_email_available_for_change(text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_email_available_for_change(text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_identity_exists(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_identity_exists(text,text) FROM anon;
REVOKE ALL ON FUNCTION public.check_identity_exists(text,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.check_identity_exists(text,text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.check_identity_exists(text,text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_identity_exists(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_identity_exists(text,text) TO service_role;

REVOKE ALL ON FUNCTION public.check_phone_available_for_change(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_phone_available_for_change(uuid,text,text) FROM anon;
REVOKE ALL ON FUNCTION public.check_phone_available_for_change(uuid,text,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.check_phone_available_for_change(uuid,text,text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.check_phone_available_for_change(uuid,text,text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_phone_available_for_change(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_phone_available_for_change(uuid,text,text) TO service_role;

REVOKE ALL ON FUNCTION public.customer_counter_ride_offer(uuid,integer,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_counter_ride_offer(uuid,integer,uuid,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.customer_counter_ride_offer(uuid,integer,uuid,uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.customer_counter_ride_offer(uuid,integer,uuid,uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.customer_counter_ride_offer(uuid,integer,uuid,uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_counter_ride_offer(uuid,integer,uuid,uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.customer_counter_ride_offer(uuid,integer,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_counter_ride_offer(uuid,integer,uuid,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_send_preset_offer(uuid,integer,integer[],integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_send_preset_offer(uuid,integer,integer[],integer) FROM anon;
REVOKE ALL ON FUNCTION public.driver_send_preset_offer(uuid,integer,integer[],integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_send_preset_offer(uuid,integer,integer[],integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.driver_send_preset_offer(uuid,integer,integer[],integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_send_preset_offer(uuid,integer,integer[],integer) TO anon;
GRANT EXECUTE ON FUNCTION public.driver_send_preset_offer(uuid,integer,integer[],integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_send_preset_offer(uuid,integer,integer[],integer) TO service_role;

REVOKE ALL ON FUNCTION public.driver_wallet_eligibility_balances(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_wallet_eligibility_balances(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_wallet_eligibility_balances(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_wallet_eligibility_balances(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_eligibility_balances(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_wallet_eligibility_balances(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.driver_wallet_eligibility_balances(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_eligibility_balances(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() FROM anon;
REVOKE ALL ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() FROM service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() TO anon;
GRANT EXECUTE ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() TO service_role;

REVOKE ALL ON FUNCTION public.driver_wallet_provider_funds_cleared(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_wallet_provider_funds_cleared(text) FROM anon;
REVOKE ALL ON FUNCTION public.driver_wallet_provider_funds_cleared(text) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_wallet_provider_funds_cleared(text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_provider_funds_cleared(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_wallet_provider_funds_cleared(text) TO anon;
GRANT EXECUTE ON FUNCTION public.driver_wallet_provider_funds_cleared(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_provider_funds_cleared(text) TO service_role;

REVOKE ALL ON FUNCTION public.enforce_commission_wallet_ledger_financial_model() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_commission_wallet_ledger_financial_model() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_commission_wallet_ledger_financial_model() FROM authenticated;
REVOKE ALL ON FUNCTION public.enforce_commission_wallet_ledger_financial_model() FROM service_role;
GRANT EXECUTE ON FUNCTION public.enforce_commission_wallet_ledger_financial_model() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_commission_wallet_ledger_financial_model() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_commission_wallet_ledger_financial_model() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_commission_wallet_ledger_financial_model() TO service_role;

REVOKE ALL ON FUNCTION public.enforce_negotiation_pre_hold_assignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_negotiation_pre_hold_assignment() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_negotiation_pre_hold_assignment() FROM authenticated;
REVOKE ALL ON FUNCTION public.enforce_negotiation_pre_hold_assignment() FROM service_role;
GRANT EXECUTE ON FUNCTION public.enforce_negotiation_pre_hold_assignment() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_negotiation_pre_hold_assignment() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_negotiation_pre_hold_assignment() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_negotiation_pre_hold_assignment() TO service_role;

REVOKE ALL ON FUNCTION public.enforce_payment_session_financial_model() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_payment_session_financial_model() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_payment_session_financial_model() FROM authenticated;
REVOKE ALL ON FUNCTION public.enforce_payment_session_financial_model() FROM service_role;
GRANT EXECUTE ON FUNCTION public.enforce_payment_session_financial_model() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_payment_session_financial_model() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_payment_session_financial_model() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_payment_session_financial_model() TO service_role;

REVOKE ALL ON FUNCTION public.enforce_payout_item_financial_model() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_payout_item_financial_model() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_payout_item_financial_model() FROM authenticated;
REVOKE ALL ON FUNCTION public.enforce_payout_item_financial_model() FROM service_role;
GRANT EXECUTE ON FUNCTION public.enforce_payout_item_financial_model() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_payout_item_financial_model() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_payout_item_financial_model() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_payout_item_financial_model() TO service_role;

REVOKE ALL ON FUNCTION public.enforce_trip_financial_model_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_trip_financial_model_immutable() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_trip_financial_model_immutable() FROM authenticated;
REVOKE ALL ON FUNCTION public.enforce_trip_financial_model_immutable() FROM service_role;
GRANT EXECUTE ON FUNCTION public.enforce_trip_financial_model_immutable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_trip_financial_model_immutable() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_trip_financial_model_immutable() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_trip_financial_model_immutable() TO service_role;

REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text,text,text,text,text,text,uuid,uuid[],text,text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text,text,text,text,text,text,uuid,uuid[],text,text,integer,text,text) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text,text,text,text,text,text,uuid,uuid[],text,text,integer,text,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text,text,text,text,text,text,uuid,uuid[],text,text,integer,text,text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.finalize_driver_onboarding_registration(text,text,text,text,text,text,uuid,uuid[],text,text,integer,text,text) TO anon;
GRANT EXECUTE ON FUNCTION public.finalize_driver_onboarding_registration(text,text,text,text,text,text,uuid,uuid[],text,text,integer,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_driver_onboarding_registration(text,text,text,text,text,text,uuid,uuid[],text,text,integer,text,text) TO service_role;

REVOKE ALL ON FUNCTION public.get_driver_document_compliance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_document_compliance(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_document_compliance(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_document_compliance(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_document_compliance(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_driver_document_compliance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_document_compliance(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision,double precision,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision,double precision,text) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision,double precision,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision,double precision,text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_location_options(double precision,double precision,text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_location_options(double precision,double precision,text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_location_options(double precision,double precision,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_location_options(double precision,double precision,text) TO service_role;

REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_service_areas(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_service_areas(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_service_areas(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_service_areas(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.insert_payout_ledger_debit_if_missing(uuid,integer,text,text,text,text,text,timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.insert_payout_ledger_debit_if_missing(uuid,integer,text,text,text,text,text,timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.insert_payout_ledger_debit_if_missing(uuid,integer,text,text,text,text,text,timestamp with time zone) FROM authenticated;
REVOKE ALL ON FUNCTION public.insert_payout_ledger_debit_if_missing(uuid,integer,text,text,text,text,text,timestamp with time zone) FROM service_role;
GRANT EXECUTE ON FUNCTION public.insert_payout_ledger_debit_if_missing(uuid,integer,text,text,text,text,text,timestamp with time zone) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_payout_ledger_debit_if_missing(uuid,integer,text,text,text,text,text,timestamp with time zone) TO anon;
GRANT EXECUTE ON FUNCTION public.insert_payout_ledger_debit_if_missing(uuid,integer,text,text,text,text,text,timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.insert_payout_ledger_debit_if_missing(uuid,integer,text,text,text,text,text,timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.is_scheduled_instant_conversion_pending(text,text,boolean,timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_scheduled_instant_conversion_pending(text,text,boolean,timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.is_scheduled_instant_conversion_pending(text,text,boolean,timestamp with time zone) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_scheduled_instant_conversion_pending(text,text,boolean,timestamp with time zone) FROM service_role;
GRANT EXECUTE ON FUNCTION public.is_scheduled_instant_conversion_pending(text,text,boolean,timestamp with time zone) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_scheduled_instant_conversion_pending(text,text,boolean,timestamp with time zone) TO anon;
GRANT EXECUTE ON FUNCTION public.is_scheduled_instant_conversion_pending(text,text,boolean,timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_scheduled_instant_conversion_pending(text,text,boolean,timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM anon;
REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM authenticated;
REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM service_role;
GRANT EXECUTE ON FUNCTION public.list_driver_signup_countries() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_driver_signup_countries() TO anon;
GRANT EXECUTE ON FUNCTION public.list_driver_signup_countries() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_driver_signup_countries() TO service_role;

REVOKE ALL ON FUNCTION public.passenger_has_live_immediate_trip(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.passenger_has_live_immediate_trip(uuid,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.passenger_has_live_immediate_trip(uuid,uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.passenger_has_live_immediate_trip(uuid,uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid,uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid,uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.payment_authorisation_valid(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_authorisation_valid(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.payment_authorisation_valid(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.payment_authorisation_valid(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.payment_authorisation_valid(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.payment_authorisation_valid(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.payment_authorisation_valid(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payment_authorisation_valid(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.payout_item_status_releases_ledger_allocation(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payout_item_status_releases_ledger_allocation(text,text) FROM anon;
REVOKE ALL ON FUNCTION public.payout_item_status_releases_ledger_allocation(text,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.payout_item_status_releases_ledger_allocation(text,text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.payout_item_status_releases_ledger_allocation(text,text) TO anon;
GRANT EXECUTE ON FUNCTION public.payout_item_status_releases_ledger_allocation(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payout_item_status_releases_ledger_allocation(text,text) TO service_role;

REVOKE ALL ON FUNCTION public.payout_ledger_type_is_payout_eligible(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payout_ledger_type_is_payout_eligible(text) FROM anon;
REVOKE ALL ON FUNCTION public.payout_ledger_type_is_payout_eligible(text) FROM authenticated;
REVOKE ALL ON FUNCTION public.payout_ledger_type_is_payout_eligible(text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.payout_ledger_type_is_payout_eligible(text) TO anon;
GRANT EXECUTE ON FUNCTION public.payout_ledger_type_is_payout_eligible(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payout_ledger_type_is_payout_eligible(text) TO service_role;

REVOKE ALL ON FUNCTION public.persist_pickup_waiting_admin_ssot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_pickup_waiting_admin_ssot() FROM anon;
REVOKE ALL ON FUNCTION public.persist_pickup_waiting_admin_ssot() FROM authenticated;
REVOKE ALL ON FUNCTION public.persist_pickup_waiting_admin_ssot() FROM service_role;
GRANT EXECUTE ON FUNCTION public.persist_pickup_waiting_admin_ssot() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.persist_pickup_waiting_admin_ssot() TO anon;
GRANT EXECUTE ON FUNCTION public.persist_pickup_waiting_admin_ssot() TO authenticated;
GRANT EXECUTE ON FUNCTION public.persist_pickup_waiting_admin_ssot() TO service_role;

REVOKE ALL ON FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip() FROM anon;
REVOKE ALL ON FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip() FROM authenticated;
REVOKE ALL ON FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip() FROM service_role;
GRANT EXECUTE ON FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip() TO anon;
GRANT EXECUTE ON FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip() TO service_role;

REVOKE ALL ON FUNCTION public.protect_owner_staff_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_owner_staff_profile() FROM anon;
REVOKE ALL ON FUNCTION public.protect_owner_staff_profile() FROM authenticated;
REVOKE ALL ON FUNCTION public.protect_owner_staff_profile() FROM service_role;
GRANT EXECUTE ON FUNCTION public.protect_owner_staff_profile() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.protect_owner_staff_profile() TO anon;
GRANT EXECUTE ON FUNCTION public.protect_owner_staff_profile() TO authenticated;
GRANT EXECUTE ON FUNCTION public.protect_owner_staff_profile() TO service_role;

REVOKE ALL ON FUNCTION public.refresh_driver_document_approval_flags() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_driver_document_approval_flags() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_driver_document_approval_flags() FROM authenticated;
REVOKE ALL ON FUNCTION public.refresh_driver_document_approval_flags() FROM service_role;
GRANT EXECUTE ON FUNCTION public.refresh_driver_document_approval_flags() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_driver_document_approval_flags() TO anon;
GRANT EXECUTE ON FUNCTION public.refresh_driver_document_approval_flags() TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_driver_document_approval_flags() TO service_role;

REVOKE ALL ON FUNCTION public.resolve_trip_commissionable_fare_pence(trips,integer,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_trip_commissionable_fare_pence(trips,integer,integer,integer) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_trip_commissionable_fare_pence(trips,integer,integer,integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_trip_commissionable_fare_pence(trips,integer,integer,integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.resolve_trip_commissionable_fare_pence(trips,integer,integer,integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_trip_commissionable_fare_pence(trips,integer,integer,integer) TO anon;
GRANT EXECUTE ON FUNCTION public.resolve_trip_commissionable_fare_pence(trips,integer,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_trip_commissionable_fare_pence(trips,integer,integer,integer) TO service_role;

REVOKE ALL ON FUNCTION public.resolve_trip_locked_promotion_pence(trips) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_trip_locked_promotion_pence(trips) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_trip_locked_promotion_pence(trips) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_trip_locked_promotion_pence(trips) FROM service_role;
GRANT EXECUTE ON FUNCTION public.resolve_trip_locked_promotion_pence(trips) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_trip_locked_promotion_pence(trips) TO anon;
GRANT EXECUTE ON FUNCTION public.resolve_trip_locked_promotion_pence(trips) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_trip_locked_promotion_pence(trips) TO service_role;

REVOKE ALL ON FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(trips,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(trips,integer) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(trips,integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(trips,integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(trips,integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(trips,integer) TO anon;
GRANT EXECUTE ON FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(trips,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(trips,integer) TO service_role;

REVOKE ALL ON FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(trips) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(trips) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(trips) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(trips) FROM service_role;
GRANT EXECUTE ON FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(trips) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(trips) TO anon;
GRANT EXECUTE ON FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(trips) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(trips) TO service_role;

REVOKE ALL ON FUNCTION public.schedule_dispatch_sweep() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.schedule_dispatch_sweep() FROM anon;
REVOKE ALL ON FUNCTION public.schedule_dispatch_sweep() FROM authenticated;
REVOKE ALL ON FUNCTION public.schedule_dispatch_sweep() FROM service_role;
GRANT EXECUTE ON FUNCTION public.schedule_dispatch_sweep() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_dispatch_sweep() TO anon;
GRANT EXECUTE ON FUNCTION public.schedule_dispatch_sweep() TO authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_dispatch_sweep() TO service_role;

REVOKE ALL ON FUNCTION public.scheduled_dispatch_sweep() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scheduled_dispatch_sweep() FROM anon;
REVOKE ALL ON FUNCTION public.scheduled_dispatch_sweep() FROM authenticated;
REVOKE ALL ON FUNCTION public.scheduled_dispatch_sweep() FROM service_role;
GRANT EXECUTE ON FUNCTION public.scheduled_dispatch_sweep() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.scheduled_dispatch_sweep() TO anon;
GRANT EXECUTE ON FUNCTION public.scheduled_dispatch_sweep() TO authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_dispatch_sweep() TO service_role;

REVOKE ALL ON FUNCTION public.stamp_trip_financial_model_on_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stamp_trip_financial_model_on_insert() FROM anon;
REVOKE ALL ON FUNCTION public.stamp_trip_financial_model_on_insert() FROM authenticated;
REVOKE ALL ON FUNCTION public.stamp_trip_financial_model_on_insert() FROM service_role;
GRANT EXECUTE ON FUNCTION public.stamp_trip_financial_model_on_insert() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.stamp_trip_financial_model_on_insert() TO anon;
GRANT EXECUTE ON FUNCTION public.stamp_trip_financial_model_on_insert() TO authenticated;
GRANT EXECUTE ON FUNCTION public.stamp_trip_financial_model_on_insert() TO service_role;

REVOKE ALL ON FUNCTION public.trg_commission_wallet_on_trip_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_commission_wallet_on_trip_complete() FROM anon;
REVOKE ALL ON FUNCTION public.trg_commission_wallet_on_trip_complete() FROM authenticated;
REVOKE ALL ON FUNCTION public.trg_commission_wallet_on_trip_complete() FROM service_role;
GRANT EXECUTE ON FUNCTION public.trg_commission_wallet_on_trip_complete() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_commission_wallet_on_trip_complete() TO anon;
GRANT EXECUTE ON FUNCTION public.trg_commission_wallet_on_trip_complete() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_commission_wallet_on_trip_complete() TO service_role;

REVOKE ALL ON FUNCTION public.trg_commission_wallet_release_on_cancel() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_commission_wallet_release_on_cancel() FROM anon;
REVOKE ALL ON FUNCTION public.trg_commission_wallet_release_on_cancel() FROM authenticated;
REVOKE ALL ON FUNCTION public.trg_commission_wallet_release_on_cancel() FROM service_role;
GRANT EXECUTE ON FUNCTION public.trg_commission_wallet_release_on_cancel() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_commission_wallet_release_on_cancel() TO anon;
GRANT EXECUTE ON FUNCTION public.trg_commission_wallet_release_on_cancel() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_commission_wallet_release_on_cancel() TO service_role;

REVOKE ALL ON FUNCTION public.trg_payout_item_ledger_allocations_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_payout_item_ledger_allocations_immutable() FROM anon;
REVOKE ALL ON FUNCTION public.trg_payout_item_ledger_allocations_immutable() FROM authenticated;
REVOKE ALL ON FUNCTION public.trg_payout_item_ledger_allocations_immutable() FROM service_role;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_ledger_allocations_immutable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_ledger_allocations_immutable() TO anon;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_ledger_allocations_immutable() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_ledger_allocations_immutable() TO service_role;

REVOKE ALL ON FUNCTION public.trg_payout_item_ledger_allocations_validate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_payout_item_ledger_allocations_validate() FROM anon;
REVOKE ALL ON FUNCTION public.trg_payout_item_ledger_allocations_validate() FROM authenticated;
REVOKE ALL ON FUNCTION public.trg_payout_item_ledger_allocations_validate() FROM service_role;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_ledger_allocations_validate() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_ledger_allocations_validate() TO anon;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_ledger_allocations_validate() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_ledger_allocations_validate() TO service_role;

REVOKE ALL ON FUNCTION public.trg_payout_item_require_lineage_before_execute() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_payout_item_require_lineage_before_execute() FROM anon;
REVOKE ALL ON FUNCTION public.trg_payout_item_require_lineage_before_execute() FROM authenticated;
REVOKE ALL ON FUNCTION public.trg_payout_item_require_lineage_before_execute() FROM service_role;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_require_lineage_before_execute() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_require_lineage_before_execute() TO anon;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_require_lineage_before_execute() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_payout_item_require_lineage_before_execute() TO service_role;

REVOKE ALL ON FUNCTION public.trg_scheduled_handover_block_premature_search_ttl() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_scheduled_handover_block_premature_search_ttl() FROM anon;
REVOKE ALL ON FUNCTION public.trg_scheduled_handover_block_premature_search_ttl() FROM authenticated;
REVOKE ALL ON FUNCTION public.trg_scheduled_handover_block_premature_search_ttl() FROM service_role;
GRANT EXECUTE ON FUNCTION public.trg_scheduled_handover_block_premature_search_ttl() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_scheduled_handover_block_premature_search_ttl() TO anon;
GRANT EXECUTE ON FUNCTION public.trg_scheduled_handover_block_premature_search_ttl() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_scheduled_handover_block_premature_search_ttl() TO service_role;

REVOKE ALL ON FUNCTION public.trg_trip_invoice_on_completion() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_trip_invoice_on_completion() FROM anon;
REVOKE ALL ON FUNCTION public.trg_trip_invoice_on_completion() FROM authenticated;
REVOKE ALL ON FUNCTION public.trg_trip_invoice_on_completion() FROM service_role;
GRANT EXECUTE ON FUNCTION public.trg_trip_invoice_on_completion() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_trip_invoice_on_completion() TO anon;
GRANT EXECUTE ON FUNCTION public.trg_trip_invoice_on_completion() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_trip_invoice_on_completion() TO service_role;

REVOKE ALL ON FUNCTION public.trip_promotion_superseded_by_negotiation(trips) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trip_promotion_superseded_by_negotiation(trips) FROM anon;
REVOKE ALL ON FUNCTION public.trip_promotion_superseded_by_negotiation(trips) FROM authenticated;
REVOKE ALL ON FUNCTION public.trip_promotion_superseded_by_negotiation(trips) FROM service_role;
GRANT EXECUTE ON FUNCTION public.trip_promotion_superseded_by_negotiation(trips) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.trip_promotion_superseded_by_negotiation(trips) TO anon;
GRANT EXECUTE ON FUNCTION public.trip_promotion_superseded_by_negotiation(trips) TO authenticated;
GRANT EXECUTE ON FUNCTION public.trip_promotion_superseded_by_negotiation(trips) TO service_role;

REVOKE ALL ON FUNCTION public.upsert_pending_customer_signup(uuid,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_pending_customer_signup(uuid,text,text,text,text,text) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_pending_customer_signup(uuid,text,text,text,text,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.upsert_pending_customer_signup(uuid,text,text,text,text,text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.upsert_pending_customer_signup(uuid,text,text,text,text,text) TO anon;
GRANT EXECUTE ON FUNCTION public.upsert_pending_customer_signup(uuid,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pending_customer_signup(uuid,text,text,text,text,text) TO service_role;

REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid,uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid,uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid,uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid,uuid[]) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid,uuid[]) TO anon;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid,uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid,uuid[]) TO service_role;

-- ---------------------------------------------------------------------------
-- 5) Backend-only table REVOKEs — restore client table grants (pre-P0 live state)
-- ---------------------------------------------------------------------------
GRANT ALL ON TABLE public.historical_settlement_correction_audit TO anon;
GRANT ALL ON TABLE public.historical_settlement_correction_audit TO authenticated;
GRANT ALL ON TABLE public.onecab_assistant_config TO anon;
GRANT ALL ON TABLE public.onecab_assistant_config TO authenticated;
GRANT ALL ON TABLE public.onecab_assistant_events TO anon;
GRANT ALL ON TABLE public.onecab_assistant_events TO authenticated;
GRANT ALL ON TABLE public.onecab_assistant_rate_limits TO anon;
GRANT ALL ON TABLE public.onecab_assistant_rate_limits TO authenticated;
GRANT ALL ON TABLE public.whatsapp_conversations TO anon;
GRANT ALL ON TABLE public.whatsapp_conversations TO authenticated;
GRANT ALL ON TABLE public.whatsapp_inbound_messages TO anon;
GRANT ALL ON TABLE public.whatsapp_inbound_messages TO authenticated;

COMMIT;
