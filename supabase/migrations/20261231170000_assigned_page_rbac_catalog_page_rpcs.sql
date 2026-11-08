-- ============================================================
-- Assigned-page RBAC — catalog / clear-ish table page RPCs
-- Branch: fix/assigned-page-rbac
-- LOCAL / UNAPPLIED — DO NOT apply until UI cutover lands.
--
-- Depends on: 20261231130000 (admin_assert_staff_page, admin_page_select/mutate helpers)
-- Does NOT change table RLS. Existing has_role(admin) JWT continues until 20261231180000.
--
-- Extends page allowlists for:
--   service_areas (SELECT lookup only — dedicated RPC with region join)
--   driver_service_areas, fare_pricing_settings, corporate_fare_rules,
--   document_types, service_area_document_rules
-- Exact page assert per call — no bare admin-role bypass.
-- Mutate pages are narrower than SELECT pages (no cross-page write exposure).
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- service_areas lookup page allowlist (labels / filters only)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._admin_service_areas_lookup_page_allowed(p_page_slug text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT lower(p_page_slug) = ANY (ARRAY[
    'dashboard','drivers','services','regions','fleet-tracking','active-trips',
    'scheduled-rides','missed-cancelled','trip-history','manual-trip','dispatch',
    'dispatch-metrics','driver-demand-zones','staff-work-patterns',
    'document-management','documents',
    'service-area-pricing','fare-simulator','custom-zones','zone-pricing','offers','promo-codes',
    'corporate-accounts','account-requests','corporate-billing','corporate-reports',
    'corporate-settings','corporate-fares',
    'payment-sessions','financial-reconciliation','driver-wallet-ledger','commission-wallet',
    'payout-ledger','invoices','statement-runs','invoice-templates','annual-taxi-report',
    'onecab-revenue-profit','lost-property','notifications','roles','disputes',
    'auto-dispatch'
  ]);
$fn$;

COMMENT ON FUNCTION public._admin_service_areas_lookup_page_allowed(text) IS
  'Pages allowed to call admin_service_areas_lookup (label/filter columns only).';

CREATE OR REPLACE FUNCTION public.admin_service_areas_lookup(
  p_page_slug text,
  p_args jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_page text := lower(btrim(p_page_slug));
  v_active_only boolean := COALESCE((p_args->>'active_only')::boolean, false);
  v_include_archived boolean := COALESCE((p_args->>'include_archived')::boolean, false);
  v_ids uuid[];
  v_limit int := LEAST(GREATEST(COALESCE((p_args->>'limit')::int, 500), 1), 1000);
  v_sql text;
  v_rows jsonb;
BEGIN
  PERFORM public.admin_assert_staff_page(v_page);
  IF NOT public._admin_service_areas_lookup_page_allowed(v_page) THEN
    RAISE EXCEPTION 'not authorized: page % cannot lookup service_areas', v_page
      USING ERRCODE = '42501';
  END IF;

  SELECT ARRAY(
    SELECT jsonb_array_elements_text(COALESCE(p_args->'ids', '[]'::jsonb))::uuid
  ) INTO v_ids;

  -- Label/filter columns for allowlisted pages.
  -- geo_boundary + management prefixes: services page only (not OR'd across pages).
  -- Commission/CW policy columns: services|service-area-pricing|commission-wallet|payout-ledger only.
  v_sql := format($q$
    SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.name), '[]'::jsonb)
    FROM (
      SELECT
        sa.id,
        sa.name,
        sa.code,
        sa.country,
        sa.timezone,
        sa.currency_code,
        sa.distance_unit,
        sa.region_id,
        sa.is_active,
        sa.archived_at,
        sa.center_lat,
        sa.center_lng,
        sa.created_at,
        sa.updated_at,
        sa.financial_model,
        sa.commission_wallet_enabled,
        sa.commission_wallet_currency,
        sa.welcome_credit_enabled,
        sa.welcome_credit_amount_minor,
        sa.welcome_credit_max_drivers,
        sa.payment_provider,
        sa.driver_payout_gateway,
        sa.customer_payment_gateway,
        %s AS tips_enabled,
        %s AS early_cashout_enabled,
        %s AS trip_id_prefix,
        %s AS driver_id_prefix,
        %s AS commission_reserve_enabled,
        %s AS commission_topup_provider,
        %s AS commission_wallet_topup_enabled,
        %s AS commission_wallet_minimum_balance_minor,
        %s AS customer_payment_policy,
        %s AS cash_upfront_policy_notice,
        %s AS geo_boundary,
        %s AS region
      FROM public.service_areas sa
      LEFT JOIN public.regions r ON r.id = sa.region_id
      WHERE ($1::uuid[] IS NULL OR cardinality($1::uuid[]) = 0 OR sa.id = ANY ($1::uuid[]))
        AND ($2::boolean OR sa.archived_at IS NULL)
        AND (NOT $3::boolean OR sa.is_active = true)
      ORDER BY sa.name
      LIMIT $4
    ) q
  $q$,
    CASE WHEN v_page = ANY (ARRAY['services','service-area-pricing','payout-ledger'])
      THEN 'sa.tips_enabled' ELSE 'NULL::boolean' END,
    CASE WHEN v_page = ANY (ARRAY['services','service-area-pricing','payout-ledger'])
      THEN 'sa.early_cashout_enabled' ELSE 'NULL::boolean' END,
    CASE WHEN v_page = 'services' THEN 'sa.trip_id_prefix' ELSE 'NULL::text' END,
    CASE WHEN v_page = 'services' THEN 'sa.driver_id_prefix' ELSE 'NULL::text' END,
    CASE WHEN v_page = ANY (ARRAY['services','service-area-pricing','commission-wallet','payout-ledger'])
      THEN 'sa.commission_reserve_enabled' ELSE 'NULL::boolean' END,
    CASE WHEN v_page = ANY (ARRAY['services','service-area-pricing','commission-wallet','payout-ledger'])
      THEN 'sa.commission_topup_provider' ELSE 'NULL::text' END,
    CASE WHEN v_page = ANY (ARRAY['services','service-area-pricing','commission-wallet','payout-ledger'])
      THEN 'sa.commission_wallet_topup_enabled' ELSE 'NULL::boolean' END,
    CASE WHEN v_page = ANY (ARRAY['services','service-area-pricing','commission-wallet','payout-ledger'])
      THEN 'sa.commission_wallet_minimum_balance_minor' ELSE 'NULL::bigint' END,
    CASE WHEN v_page = ANY (ARRAY['services','service-area-pricing','commission-wallet','payout-ledger','manual-trip'])
      THEN 'sa.customer_payment_policy' ELSE 'NULL::text' END,
    CASE WHEN v_page = ANY (ARRAY['services','service-area-pricing','commission-wallet','payout-ledger','manual-trip'])
      THEN 'sa.cash_upfront_policy_notice' ELSE 'NULL::text' END,
    CASE WHEN v_page = ANY (ARRAY['services','custom-zones','driver-demand-zones','zone-pricing'])
      THEN 'sa.geo_boundary' ELSE 'NULL::jsonb' END,
    CASE WHEN v_page = 'services' THEN
      $r$jsonb_build_object(
        'id', r.id,
        'name', r.name,
        'currency_code', r.currency_code,
        'distance_unit', r.distance_unit,
        'timezone', r.timezone,
        'status', r.status,
        'country_code', r.country_code,
        'geo_boundary', r.geo_boundary
      )$r$
    ELSE
      $r$jsonb_build_object(
        'currency_code', r.currency_code,
        'distance_unit', r.distance_unit,
        'name', r.name,
        'country_code', r.country_code
      )$r$
    END
  );

  EXECUTE v_sql
    INTO v_rows
    USING v_ids, v_include_archived, v_active_only, v_limit;

  RETURN jsonb_build_object('rows', COALESCE(v_rows, '[]'::jsonb), 'count', jsonb_array_length(COALESCE(v_rows, '[]'::jsonb)));
END;
$fn$;

COMMENT ON FUNCTION public.admin_service_areas_lookup(text, jsonb) IS
  'Page-gated service_areas label/filter lookup + region currency join. geo_boundary only for services page.';

REVOKE ALL ON FUNCTION public.admin_service_areas_lookup(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_service_areas_lookup(text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_service_areas_lookup(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_service_areas_lookup(text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Extend admin_page_select / mutate allowlists for catalog tables
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._admin_page_table_allowed(p_page_slug text, p_table text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE lower(p_table)
    WHEN 'trips' THEN lower(p_page_slug) = ANY (ARRAY[
      'dashboard','active-trips','trip-history','missed-cancelled','scheduled-rides',
      'manual-trip','fleet-tracking','dispatch','corporate-billing','corporate-reports',
      'rider-feedback','lost-property','payment-sessions','financial-reconciliation','riders',
      'service-area-pricing','driver-wallet-ledger','payout-ledger','commission-wallet','disputes'
    ])
    WHEN 'drivers' THEN lower(p_page_slug) = ANY (ARRAY[
      'drivers','fleet-tracking','active-trips','scheduled-rides','manual-trip','dashboard',
      'documents','document-management','services','regions','invoices','statement-runs',
      'annual-taxi-report','disputes','rider-feedback','lost-property','payout-ledger',
      'driver-wallet-ledger','live-chat','tickets','commission-wallet','vehicles',
      'service-area-pricing','dispatch','corporate-billing','corporate-reports','trip-history',
      'missed-cancelled'
    ])
    WHEN 'customers' THEN lower(p_page_slug) = ANY (ARRAY[
      'riders','pending-customer-signups','suspensions','live-chat','tickets','manual-trip',
      'rider-feedback','lost-property','dashboard','customer-receivables','trip-history',
      'active-trips','missed-cancelled','scheduled-rides','payment-sessions','dispatch',
      'service-area-pricing'
    ])
    WHEN 'documents' THEN lower(p_page_slug) = ANY (ARRAY[
      'documents','document-management','drivers'
    ])
    WHEN 'vehicles' THEN lower(p_page_slug) = ANY (ARRAY[
      'vehicles','drivers','commission-wallet'
    ])
    WHEN 'driver_service_areas' THEN lower(p_page_slug) = ANY (ARRAY[
      'drivers','services','fleet-tracking','statement-runs','payout-ledger','commission-wallet'
    ])
    WHEN 'fare_pricing_settings' THEN lower(p_page_slug) = ANY (ARRAY[
      'service-area-pricing','fare-simulator','services'
    ])
    WHEN 'corporate_fare_rules' THEN lower(p_page_slug) = 'corporate-fares'
    -- SELECT: document-management + drivers/documents review UIs. Writes stay document-management only.
    WHEN 'document_types' THEN lower(p_page_slug) = ANY (ARRAY[
      'document-management','drivers','documents'
    ])
    WHEN 'service_area_document_rules' THEN lower(p_page_slug) = ANY (ARRAY[
      'document-management','drivers','documents'
    ])
    WHEN 'stop_waiting_settings' THEN lower(p_page_slug) = 'service-area-pricing'
    WHEN 'dispatch_settings' THEN lower(p_page_slug) = ANY (ARRAY[
      'service-area-pricing','auto-dispatch'
    ])
    WHEN 'service_area_cancellation_fees' THEN lower(p_page_slug) = ANY (ARRAY[
      'services','service-area-pricing'
    ])
    WHEN 'service_area_vehicle_pricing' THEN lower(p_page_slug) = ANY (ARRAY[
      'services','service-area-pricing','fare-simulator','manual-trip'
    ])
    ELSE false
  END;
$fn$;

CREATE OR REPLACE FUNCTION public._admin_page_columns(p_table text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE lower(p_table)
    WHEN 'trips' THEN ARRAY[
      'id','trip_code','trip_number','status','financial_outcome','passenger_id','passenger_name',
      'passenger_phone','pickup_address','pickup_latitude','pickup_longitude','dropoff_address',
      'dropoff_latitude','dropoff_longitude','estimated_fare','fare','gross_fare_pence',
      'commission_pence','driver_net_pence','final_fare_pence','final_customer_fare_pence',
      'capture_amount_pence','commissionable_fare_pence','no_show_charge_pence',
      'locked_base_fare_pence','accepted_preset_offer_fare_pence','accepted_driver_offer_fare_pence',
      'customer_modification_charge_pence','destination_change_adjustment_pence',
      'modification_delta_pence','modification_status','modified_dropoff_address',
      'offer_discount_pence','voucher_discount_pence','discount_pence','applied_offer_code',
      'provider_fee_pence','onecab_net_pence','payment_status','payment_method','payment_provider',
      'provider_order_id','provider_payment_id','currency_code','estimated_distance_km',
      'estimated_duration_minutes','refund_amount_pence','refunded_at','total_stops','stops',
      'created_at','started_at','completed_at','cancelled_at','cancellation_reason',
      'surge_multiplier','driver_id','previous_driver_id','driver_location_lat','driver_location_lng',
      'stacked_trip_id','corporate_account_id','region_id','service_area_id','financial_model',
      'cancellation_fee_pence','pricing_mode','fare_locked','vehicle_type_id','vehicle_type',
      'fare_engine_config_id','waiting_charge_pence','pickup_waiting_charge_pence',
      'stop_waiting_charge_pence','total_waiting_charge_pence','stop_charge_total_pence',
      'waiting_minutes','fare_breakdown','tip_pence','tip_amount_pence','airport_charge_pence',
      'other_pass_through_charges_pence','accepted_commission_percent','driver_tier_commission_percent',
      'commission_pct','estimated_total_pence','fare_snapshot_json','arrival_cancellation_applied',
      'arrival_cancellation_fee','is_scheduled','scheduled_status','searching_expires_at',
      'invoice_no','invoice_pdf_url','invoice_generated_at','invoice_email_sent',
      'invoice_email_sent_at','invoice_email_status','invoice_email_error','invoice_pdf_error',
      'invoice_total_paid_pence','invoice_regenerated_at','invoice_payment_classification',
      'invoice_paid_pence','invoice_outstanding_pence','invoice_delivery_eligible',
      'trip_history_event_at','missed_cancelled_event_at',
      'scheduled_at','scheduled_broadcast_at','scheduled_accepted_at','scheduled_convert_at',
      'confirmed_driver_id','pending_release_kind','pending_release_at','pending_release_driver_id',
      'dispatch_mode','special_instructions','payment_type','job_type','trip_type','booking_source',
      'arrived_at','pickup_waiting_started_at','cancelled_by','cancelled_by_role','cancel_reason',
      'cancellation_note','late_cancel_fee_pence','arrival_cancellation_applied_at',
      'arrival_cancellation_reason','authorised_amount_pence','discount_source',
      'dispatch_status','broadcast_enabled','current_broadcast_round','updated_at',
      'commission_wallet_enabled'
    ]
    WHEN 'drivers' THEN ARRAY[
      'id','driver_code','user_id','first_name','last_name','email','phone','is_online',
      'approval_status','driver_status','deleted_at','rating','total_trips','profile_photo_url',
      'created_at','updated_at','region_id','residential_address','postcode','city','country',
      'country_code','service_area_id','is_pet_friendly','documents_approved','category_id',
      'current_trip_id','onboarding_complete','current_lat','current_lng','heading',
      'last_location_updated_at','last_seen_at','payouts_enabled','payout_operational_paused',
      'charges_enabled'
    ]
    WHEN 'customers' THEN ARRAY[
      'id','user_id','customer_code','first_name','last_name','phone','created_at','updated_at',
      'rider_status','email_verified','phone_verified','identity_verified_at','identity_provider',
      'name_edit_locked','name_unlocked_at','deleted_at','default_payment_method','wallet_balance'
    ]
    WHEN 'documents' THEN ARRAY[
      'id','driver_id','document_type','document_type_id','document_name','file_url','status',
      'expiry_date','notes','rejection_reason','reviewed_at','reviewed_by','created_at','updated_at',
      'is_current','superseded_by','last_reminded_at','reminder_sent_days','submission_idempotency_key'
    ]
    WHEN 'vehicles' THEN ARRAY[
      'id','driver_id','make','model','year','license_plate','color','approval_status','is_primary',
      'capacity','vehicle_type_id','rejection_reason','created_at','updated_at','is_enabled'
    ]
    WHEN 'driver_service_areas' THEN ARRAY[
      'id','driver_id','service_area_id','created_at'
    ]
    WHEN 'fare_pricing_settings' THEN ARRAY[
      'id','service_area_id','vehicle_type_id','pricing_mode','currency_code',
      'base_fare_pence','per_km_rate_pence','per_min_rate_pence','booking_fee_pence',
      'minimum_fare_pence','free_waiting_minutes','waiting_per_minute_pence',
      'extra_stop_flat_fee_pence','recalculate_on_waiting','recalculate_on_stop_added',
      'recalculate_on_dropoff_changed','enable_surge','surge_multiplier_default',
      'peak_hour_multiplier','zone_multiplier','traffic_multiplier','demand_supply_multiplier',
      'distance_pricing_bands','cancellation_grace_period_minutes','cancellation_fee_pence',
      'cancellation_apply_after_arrival_only','late_cancel_enabled','late_cancel_threshold_minutes',
      'late_cancel_fee_pence','late_cancel_airport_protection_enabled',
      'late_cancel_airport_fare_threshold_pence','late_cancel_airport_fee_type',
      'late_cancel_airport_fee_percentage','late_cancel_airport_protection_trigger',
      'no_show_wait_time_minutes','no_show_fee_pence','no_show_apply_after_arrival_only',
      'arrival_cancellation_enabled','arrival_cancellation_fee_pence',
      'arrival_cancellation_apply_after_free_waiting_expired',
      'arrival_cancellation_after_arrival_only',
      'stop_waiting_grace_period_minutes','stop_waiting_rate_pence_per_minute',
      'created_at','updated_at'
    ]
    WHEN 'corporate_fare_rules' THEN ARRAY[
      'id','name','description','corporate_account_id','rule_type','discount_percentage',
      'fixed_rate','fare_cap','applies_to_vehicle_types','applies_to_regions',
      'time_restrictions','booking_restrictions','priority','is_active',
      'valid_from','valid_until','created_at','updated_at'
    ]
    WHEN 'document_types' THEN ARRAY[
      'id','name','slug','description','is_required','has_expiry','show_in_driver_app',
      'reminder_days_before_expiry','display_order','is_active','created_at','updated_at'
    ]
    WHEN 'service_area_document_rules' THEN ARRAY[
      'id','service_area_id','doc_type_id','display_in_driver_app','mandatory',
      'expiry_required','sort_order','is_active','created_at','updated_at'
    ]
    WHEN 'stop_waiting_settings' THEN ARRAY[
      'id','service_area_id','stop_radius_enabled','stop_radius_meters',
      'stop_waiting_grace_period_seconds','stop_waiting_charge_interval_seconds',
      'stop_waiting_rate_pence_per_minute','stop_waiting_max_minutes','created_at','updated_at'
    ]
    WHEN 'dispatch_settings' THEN ARRAY[
      'id','service_area_id','enable_stop_waiting_charge','stop_radius_enabled','stop_radius_meters',
      'stop_waiting_charge_interval_seconds','stop_waiting_grace_period_seconds',
      'stop_waiting_rate_pence_per_minute','stop_waiting_max_minutes',
      'max_driver_find_time_minutes','stacked_rides_enabled',
      'wave1_offer_expiry_seconds','wave2_offer_expiry_seconds','wave3_offer_expiry_seconds',
      'wave1_size','wave2_size','wave3_size','distance_penalty_per_km',
      'waiting_bonus_per_minute','max_waiting_bonus_minutes','fairness_idle_minutes',
      'fairness_boost_score','search_radius_start_km','search_radius_expand_km',
      'search_radius_max_km','updated_at','created_at'
    ]
    WHEN 'service_area_cancellation_fees' THEN ARRAY[
      'id','service_area_id','free_cancellation_window_minutes','cancellation_fee',
      'no_show_fee','currency_code','created_at','updated_at'
    ]
    WHEN 'service_area_vehicle_pricing' THEN ARRAY[
      'id','service_area_id','vehicle_type_id','is_enabled','base_fare','minimum_fare',
      'currency_code','per_km_rate_pence','per_min_rate_pence','airport_charge_pence',
      'created_at','updated_at'
    ]
    ELSE ARRAY[]::text[]
  END;
$fn$;

CREATE OR REPLACE FUNCTION public._admin_page_mutate_columns(p_table text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE lower(p_table)
    WHEN 'drivers' THEN ARRAY[
      'first_name','last_name','email','phone','approval_status','driver_status','region_id',
      'residential_address','postcode','city','country','country_code','service_area_id',
      'is_pet_friendly','documents_approved','category_id','deleted_at','is_online','user_id'
    ]
    WHEN 'customers' THEN ARRAY[
      'first_name','last_name','phone','rider_status','updated_at','name_edit_locked','name_unlocked_at'
    ]
    WHEN 'documents' THEN ARRAY[
      'status','notes','rejection_reason','reviewed_at','reviewed_by','expiry_date','is_current',
      'superseded_by','last_reminded_at','reminder_sent_days','file_url','document_name'
    ]
    WHEN 'vehicles' THEN ARRAY[
      'approval_status','rejection_reason','is_primary','is_enabled','make','model','year',
      'license_plate','color','capacity','vehicle_type_id'
    ]
    WHEN 'trips' THEN ARRAY[
      'passenger_id','passenger_name','passenger_phone','pickup_address','pickup_latitude',
      'pickup_longitude','dropoff_address','dropoff_latitude','dropoff_longitude','driver_id',
      'vehicle_type_id','vehicle_type','estimated_fare','estimated_distance_km',
      'estimated_duration_minutes','special_instructions','is_scheduled','scheduled_at','status',
      'scheduled_status','dispatch_mode','scheduled_broadcast_at','scheduled_convert_at',
      'confirmed_driver_id','scheduled_accepted_at','pending_release_kind','pending_release_at',
      'pending_release_driver_id','payment_method','payment_type','job_type','trip_type',
      'currency_code','service_area_id','booking_source','corporate_account_id','region_id',
      'financial_model','fare','final_fare_pence','gross_fare_pence','commission_pence',
      'driver_net_pence','commissionable_fare_pence','dispatch_status','broadcast_enabled',
      'current_broadcast_round','searching_expires_at','updated_at'
    ]
    WHEN 'driver_service_areas' THEN ARRAY[
      'driver_id','service_area_id'
    ]
    WHEN 'fare_pricing_settings' THEN ARRAY[
      'service_area_id','vehicle_type_id','pricing_mode','currency_code',
      'base_fare_pence','per_km_rate_pence','per_min_rate_pence','booking_fee_pence',
      'minimum_fare_pence','free_waiting_minutes','waiting_per_minute_pence',
      'extra_stop_flat_fee_pence','recalculate_on_waiting','recalculate_on_stop_added',
      'recalculate_on_dropoff_changed','enable_surge','surge_multiplier_default',
      'peak_hour_multiplier','zone_multiplier','traffic_multiplier','demand_supply_multiplier',
      'distance_pricing_bands','cancellation_grace_period_minutes','cancellation_fee_pence',
      'cancellation_apply_after_arrival_only','late_cancel_enabled','late_cancel_threshold_minutes',
      'late_cancel_fee_pence','late_cancel_airport_protection_enabled',
      'late_cancel_airport_fare_threshold_pence','late_cancel_airport_fee_type',
      'late_cancel_airport_fee_percentage','late_cancel_airport_protection_trigger',
      'no_show_wait_time_minutes','no_show_fee_pence','no_show_apply_after_arrival_only',
      'arrival_cancellation_enabled','arrival_cancellation_fee_pence',
      'arrival_cancellation_apply_after_free_waiting_expired',
      'arrival_cancellation_after_arrival_only',
      'stop_waiting_grace_period_minutes','stop_waiting_rate_pence_per_minute'
    ]
    WHEN 'corporate_fare_rules' THEN ARRAY[
      'name','description','corporate_account_id','rule_type','discount_percentage',
      'fixed_rate','fare_cap','applies_to_vehicle_types','applies_to_regions',
      'time_restrictions','booking_restrictions','priority','is_active',
      'valid_from','valid_until'
    ]
    WHEN 'document_types' THEN ARRAY[
      'name','slug','description','is_required','has_expiry','show_in_driver_app',
      'reminder_days_before_expiry','display_order','is_active'
    ]
    WHEN 'service_area_document_rules' THEN ARRAY[
      'service_area_id','doc_type_id','display_in_driver_app','mandatory',
      'expiry_required','sort_order','is_active'
    ]
    WHEN 'stop_waiting_settings' THEN ARRAY[
      'service_area_id','stop_radius_enabled','stop_radius_meters',
      'stop_waiting_grace_period_seconds','stop_waiting_charge_interval_seconds',
      'stop_waiting_rate_pence_per_minute','stop_waiting_max_minutes'
    ]
    WHEN 'dispatch_settings' THEN ARRAY[
      'service_area_id','enable_stop_waiting_charge','stop_radius_enabled','stop_radius_meters',
      'stop_waiting_charge_interval_seconds','stop_waiting_grace_period_seconds',
      'stop_waiting_rate_pence_per_minute','stop_waiting_max_minutes',
      'max_driver_find_time_minutes','stacked_rides_enabled',
      'wave1_offer_expiry_seconds','wave2_offer_expiry_seconds','wave3_offer_expiry_seconds',
      'wave1_size','wave2_size','wave3_size','distance_penalty_per_km',
      'waiting_bonus_per_minute','max_waiting_bonus_minutes','fairness_idle_minutes',
      'fairness_boost_score','search_radius_start_km','search_radius_expand_km',
      'search_radius_max_km','updated_at'
    ]
    WHEN 'service_area_cancellation_fees' THEN ARRAY[
      'service_area_id','free_cancellation_window_minutes','cancellation_fee',
      'no_show_fee','currency_code'
    ]
    WHEN 'service_area_vehicle_pricing' THEN ARRAY[
      'service_area_id','vehicle_type_id','is_enabled','base_fare','minimum_fare',
      'currency_code','per_km_rate_pence','per_min_rate_pence','airport_charge_pence','updated_at'
    ]
    ELSE ARRAY[]::text[]
  END;
$fn$;

CREATE OR REPLACE FUNCTION public._admin_page_mutate_pages(p_table text, p_op text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE lower(p_table)
    WHEN 'drivers' THEN CASE lower(p_op)
      WHEN 'update' THEN ARRAY['drivers','services']
      ELSE ARRAY['drivers']
    END
    WHEN 'customers' THEN ARRAY['riders','pending-customer-signups','suspensions']
    WHEN 'documents' THEN CASE lower(p_op)
      WHEN 'select' THEN ARRAY['documents','document-management','drivers']
      ELSE ARRAY['documents','document-management','drivers']
    END
    WHEN 'vehicles' THEN ARRAY['vehicles','drivers']
    WHEN 'trips' THEN CASE lower(p_op)
      WHEN 'insert' THEN ARRAY['manual-trip']
      WHEN 'update' THEN ARRAY['scheduled-rides','manual-trip','active-trips','missed-cancelled']
      ELSE ARRAY[]::text[]
    END
    -- Writes narrower than SELECT: no statement-runs / fleet-tracking writes on DSA
    WHEN 'driver_service_areas' THEN CASE lower(p_op)
      WHEN 'select' THEN ARRAY['drivers','services','fleet-tracking','statement-runs','payout-ledger','commission-wallet']
      ELSE ARRAY['drivers','services']
    END
    WHEN 'fare_pricing_settings' THEN CASE lower(p_op)
      WHEN 'select' THEN ARRAY['service-area-pricing','fare-simulator','services']
      ELSE ARRAY['service-area-pricing']
    END
    WHEN 'corporate_fare_rules' THEN ARRAY['corporate-fares']
    WHEN 'document_types' THEN ARRAY['document-management']
    WHEN 'service_area_document_rules' THEN ARRAY['document-management']
    WHEN 'stop_waiting_settings' THEN ARRAY['service-area-pricing']
    WHEN 'dispatch_settings' THEN CASE lower(p_op)
      WHEN 'select' THEN ARRAY['service-area-pricing','auto-dispatch']
      ELSE ARRAY['service-area-pricing','auto-dispatch']
    END
    WHEN 'service_area_cancellation_fees' THEN CASE lower(p_op)
      WHEN 'select' THEN ARRAY['services','service-area-pricing']
      ELSE ARRAY['services','service-area-pricing']
    END
    WHEN 'service_area_vehicle_pricing' THEN CASE lower(p_op)
      WHEN 'select' THEN ARRAY['services','service-area-pricing','fare-simulator','manual-trip']
      ELSE ARRAY['service-area-pricing']
    END
    ELSE ARRAY[]::text[]
  END;
$fn$;

-- ---------------------------------------------------------------------------
-- Expand admin_page_mutate insert/delete for catalog tables
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_page_mutate(
  p_page_slug text,
  p_table text,
  p_op text,
  p_args jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_table text := lower(btrim(p_table));
  v_page text := lower(btrim(p_page_slug));
  v_op text := lower(btrim(p_op));
  v_pages text[];
  v_allowed text[];
  v_select_cols text[];
  v_patch jsonb := COALESCE(p_args->'patch', '{}'::jsonb);
  v_id uuid;
  v_ids uuid[];
  v_key text;
  v_set_parts text[] := ARRAY[]::text[];
  v_col_list text[] := ARRAY[]::text[];
  v_val_list text[] := ARRAY[]::text[];
  v_where text := 'TRUE';
  v_sql text;
  v_row jsonb;
  v_rows jsonb;
  v_count int := 0;
BEGIN
  PERFORM public.admin_assert_staff_page(v_page);

  v_pages := public._admin_page_mutate_pages(v_table, v_op);
  IF NOT (v_page = ANY (v_pages)) THEN
    RAISE EXCEPTION 'not authorized: page % cannot % %', v_page, v_op, v_table
      USING ERRCODE = '42501';
  END IF;

  v_allowed := public._admin_page_mutate_columns(v_table);
  IF cardinality(v_allowed) = 0 THEN
    RAISE EXCEPTION 'not authorized: mutate not allowed for %', v_table USING ERRCODE = '42501';
  END IF;

  IF v_op = 'update' THEN
    v_id := NULLIF(p_args->>'id', '')::uuid;
    v_select_cols := public._admin_page_columns(v_table);
    IF v_id IS NOT NULL THEN
      v_where := format('id = %L', v_id);
    END IF;
    IF p_args ? 'filters' OR p_args ? 'or_groups' OR p_args ? 'and_or_groups' THEN
      v_where := '(' || v_where || ' AND ' ||
        public._admin_page_build_where(v_table, COALESCE(p_args, '{}'::jsonb), v_select_cols) ||
        ')';
    END IF;
    IF v_id IS NULL AND v_where = 'TRUE' THEN
      RAISE EXCEPTION 'id or filters required for update';
    END IF;
    FOR v_key IN SELECT key FROM jsonb_each(v_patch) LOOP
      IF lower(v_key) = ANY (v_allowed) THEN
        v_set_parts := array_append(
          v_set_parts,
          format('%I = %s', lower(v_key), public._admin_page_quote_json_scalar(v_patch->v_key))
        );
      END IF;
    END LOOP;
    IF cardinality(v_set_parts) = 0 THEN
      RAISE EXCEPTION 'no allowed patch fields';
    END IF;
    v_sql := format(
      'UPDATE public.%I SET %s WHERE %s RETURNING to_jsonb(%I.*)',
      v_table,
      array_to_string(v_set_parts, ', '),
      v_where,
      v_table
    );
    EXECUTE 'SELECT COALESCE(jsonb_agg(q), ''[]''::jsonb) FROM (' || v_sql || ') q' INTO v_rows;
    v_row := CASE WHEN jsonb_array_length(COALESCE(v_rows, '[]'::jsonb)) > 0
      THEN v_rows->0 ELSE NULL END;
    RETURN jsonb_build_object('row', v_row, 'rows', COALESCE(v_rows, '[]'::jsonb));

  ELSIF v_op = 'insert' THEN
    IF v_table NOT IN (
      'drivers','trips','driver_service_areas','fare_pricing_settings',
      'corporate_fare_rules','document_types','service_area_document_rules',
      'stop_waiting_settings','dispatch_settings','service_area_cancellation_fees',
      'service_area_vehicle_pricing'
    ) THEN
      RAISE EXCEPTION 'not authorized: insert not allowed for % via this RPC', v_table
        USING ERRCODE = '42501';
    END IF;
    FOR v_key IN SELECT key FROM jsonb_each(v_patch) LOOP
      IF lower(v_key) = ANY (v_allowed) THEN
        v_col_list := array_append(v_col_list, lower(v_key));
        v_val_list := array_append(
          v_val_list,
          public._admin_page_quote_json_scalar(v_patch->v_key)
        );
      END IF;
    END LOOP;
    IF cardinality(v_col_list) = 0 THEN
      RAISE EXCEPTION 'no allowed insert fields';
    END IF;
    v_sql := format(
      'INSERT INTO public.%I (%s) VALUES (%s) RETURNING to_jsonb(%I.*)',
      v_table,
      array_to_string(ARRAY(SELECT format('%I', c) FROM unnest(v_col_list) AS c), ', '),
      array_to_string(v_val_list, ', '),
      v_table
    );
    EXECUTE v_sql INTO v_row;
    RETURN jsonb_build_object('row', v_row);

  ELSIF v_op = 'delete' THEN
    IF v_table NOT IN (
      'documents','driver_service_areas','corporate_fare_rules','document_types'
    ) THEN
      RAISE EXCEPTION 'not authorized: delete not allowed for % via this RPC', v_table
        USING ERRCODE = '42501';
    END IF;
    v_select_cols := public._admin_page_columns(v_table);
    SELECT ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_args->'ids', '[]'::jsonb))::uuid)
      INTO v_ids;
    IF v_ids IS NOT NULL AND cardinality(v_ids) > 0 THEN
      v_where := format('id = ANY (%L::uuid[])', v_ids);
    ELSIF p_args ? 'filters' OR p_args ? 'or_groups' OR p_args ? 'and_or_groups' THEN
      v_where := public._admin_page_build_where(v_table, COALESCE(p_args, '{}'::jsonb), v_select_cols);
    ELSE
      RAISE EXCEPTION 'ids or filters required for delete';
    END IF;
    v_sql := format('DELETE FROM public.%I WHERE %s', v_table, v_where);
    EXECUTE v_sql;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN jsonb_build_object('deleted', v_count);

  ELSE
    RAISE EXCEPTION 'not authorized: op %', v_op USING ERRCODE = '42501';
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.admin_page_mutate(text, text, text, jsonb) IS
  'Page-gated mutate. Catalog writes: DSA (drivers|services), fare_pricing (service-area-pricing), corporate_fare_rules, document_types/rules (document-management).';

COMMIT;
