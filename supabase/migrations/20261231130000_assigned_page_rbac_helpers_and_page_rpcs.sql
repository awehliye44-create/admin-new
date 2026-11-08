-- ============================================================
-- Assigned-page RBAC — helpers + page RPCs (ADDITIVE / LOCAL / UNAPPLIED)
-- Branch: fix/assigned-page-rbac
--
-- DO NOT apply to production until explicitly approved.
--
-- Phase A (this file): additive only.
--   - Replace/extend staff_has_page_access + staff_has_any_page_access
--   - staff_is_active_owner, admin_assert_staff_page / any_page
--   - admin_page_select / admin_page_mutate + dashboard/sidebar/riders RPCs
-- Does NOT change table RLS policies. Existing admin-role JWT table access
-- continues to work for the pre-cutover Admin UI.
--
-- Deploy order:
--   1) Apply THIS migration
--   2) Deploy Admin UI (+ Edge) that calls the page RPCs / requirePageAccess
--   3) Apply 20261231140000 clear-table page RLS
--   4) Apply 20261231150000 shared-tables fail-closed
--
-- Timestamp sits after tip 20261231120000 (document_type…) so this cannot
-- sneak ahead of already-queued Dec 30 migrations in schema_migrations.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- A1) Page-access helpers (usable by later RLS; safe while old policies remain)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1) Page-access helpers (caller identity = auth.uid() only)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.staff_has_page_access(p_page_slug text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE(p_page_slug, '') <> ''
    AND auth.uid() IS NOT NULL
    AND (
      -- Owner bypass only while the Owner staff profile is active
      EXISTS (
        SELECT 1 FROM public.staff_profiles sp
        WHERE sp.user_id = auth.uid()
          AND sp.is_owner = true
          AND sp.is_active = true
      )
      OR (
        p_page_slug <> 'roles'
        AND EXISTS (
          SELECT 1
          FROM public.staff_profiles sp
          JOIN public.staff_roles_catalog c
            ON c.id = sp.role_id AND c.is_active
          JOIN public.role_page_permissions rpp
            ON rpp.role_id = sp.role_id
           AND rpp.page_slug = p_page_slug
           AND rpp.can_access = true
          WHERE sp.user_id = auth.uid()
            AND sp.is_active = true
        )
      )
    );
$fn$;

COMMENT ON FUNCTION public.staff_has_page_access(text) IS
  'Assigned-page RBAC: auth.uid() only; Owner bypass; deny missing/inactive profile; roles page Owner-only. Exact slug match.';

CREATE OR REPLACE FUNCTION public.staff_has_any_page_access(p_page_slugs text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM unnest(COALESCE(p_page_slugs, ARRAY[]::text[])) AS s(slug)
    WHERE public.staff_has_page_access(s.slug)
  );
$fn$;

COMMENT ON FUNCTION public.staff_has_any_page_access(text[]) IS
  'True when the JWT staff member has any of the listed page grants (or is Owner).';

REVOKE ALL ON FUNCTION public.staff_has_page_access(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_has_page_access(text) FROM anon;
REVOKE ALL ON FUNCTION public.staff_has_any_page_access(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_has_any_page_access(text[]) FROM anon;

GRANT EXECUTE ON FUNCTION public.staff_has_page_access(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_page_access(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.staff_has_any_page_access(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_any_page_access(text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- A2) Page-gated SECURITY DEFINER RPCs (additive)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.staff_is_active_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.staff_profiles sp
      WHERE sp.user_id = auth.uid()
        AND sp.is_owner = true
        AND sp.is_active = true
    );
$fn$;

REVOKE ALL ON FUNCTION public.staff_is_active_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_is_active_owner() FROM anon;
GRANT EXECUTE ON FUNCTION public.staff_is_active_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_is_active_owner() TO service_role;

CREATE OR REPLACE FUNCTION public.admin_assert_staff_page(p_page_slug text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF p_page_slug IS NULL OR btrim(p_page_slug) = '' THEN
    RAISE EXCEPTION 'not authorized: missing page slug' USING ERRCODE = '42501';
  END IF;
  IF NOT public.staff_has_page_access(p_page_slug) THEN
    RAISE EXCEPTION 'not authorized: missing page access (%)', p_page_slug
      USING ERRCODE = '42501';
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_assert_staff_page(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_assert_staff_page(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_assert_staff_page(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assert_staff_page(text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_assert_staff_any_page(p_page_slugs text[])
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_slug text;
BEGIN
  IF p_page_slugs IS NULL OR cardinality(p_page_slugs) = 0 THEN
    RAISE EXCEPTION 'not authorized: missing page slug list' USING ERRCODE = '42501';
  END IF;
  FOREACH v_slug IN ARRAY p_page_slugs LOOP
    IF public.staff_has_page_access(v_slug) THEN
      RETURN v_slug;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'not authorized: missing page access (any of %)', p_page_slugs
    USING ERRCODE = '42501';
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_assert_staff_any_page(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_assert_staff_any_page(text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_assert_staff_any_page(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assert_staff_any_page(text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Allowlists (page → table; columns; mutate fields)
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
      'active-trips','missed-cancelled','scheduled-rides','payment-sessions','dispatch'
    ])
    WHEN 'documents' THEN lower(p_page_slug) = ANY (ARRAY[
      'documents','document-management','drivers'
    ])
    WHEN 'vehicles' THEN lower(p_page_slug) = ANY (ARRAY[
      'vehicles','drivers','commission-wallet'
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
      -- insert (manual-trip) + scheduled-rides lifecycle updates
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
    ELSE ARRAY[]::text[]
  END;
$fn$;

-- ---------------------------------------------------------------------------
-- Predicate builder (allowlisted columns + ops only)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._admin_page_quote_json_scalar(p_val jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  IF p_val IS NULL OR p_val = 'null'::jsonb THEN
    RETURN 'NULL';
  END IF;
  IF jsonb_typeof(p_val) = 'number' THEN
    RETURN p_val #>> '{}';
  END IF;
  IF jsonb_typeof(p_val) = 'boolean' THEN
    RETURN CASE WHEN (p_val #>> '{}')::boolean THEN 'TRUE' ELSE 'FALSE' END;
  END IF;
  RETURN quote_literal(p_val #>> '{}');
END;
$fn$;

-- Computed trip columns (PostgREST-style) → SQL expressions over public.trips row.
CREATE OR REPLACE FUNCTION public._admin_page_col_expr(p_table text, p_col text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN lower(p_table) = 'trips' AND lower(p_col) = 'trip_history_event_at'
      THEN 'public.trip_history_event_at(trips)'
    WHEN lower(p_table) = 'trips' AND lower(p_col) = 'missed_cancelled_event_at'
      THEN 'public.missed_cancelled_event_at(trips)'
    ELSE format('%I', lower(p_col))
  END;
$fn$;

CREATE OR REPLACE FUNCTION public._admin_page_pred_one(
  p_table text,
  p_filter jsonb,
  p_allowed_cols text[]
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_op text := lower(coalesce(p_filter->>'op', ''));
  v_col text := lower(coalesce(p_filter->>'col', ''));
  v_val jsonb := p_filter->'val';
  v_parts text[] := ARRAY[]::text[];
  v_elem jsonb;
  v_expr text;
BEGIN
  IF v_col = '' OR NOT (v_col = ANY (p_allowed_cols)) THEN
    RAISE EXCEPTION 'not authorized: column not allowed (%)', v_col USING ERRCODE = '42501';
  END IF;

  v_expr := public._admin_page_col_expr(p_table, v_col);

  IF v_op = 'eq' THEN
    RETURN format('%s = %s', v_expr, public._admin_page_quote_json_scalar(v_val));
  ELSIF v_op = 'neq' THEN
    RETURN format('%s IS DISTINCT FROM %s', v_expr, public._admin_page_quote_json_scalar(v_val));
  ELSIF v_op = 'gt' THEN
    RETURN format('%s > %s', v_expr, public._admin_page_quote_json_scalar(v_val));
  ELSIF v_op = 'gte' THEN
    RETURN format('%s >= %s', v_expr, public._admin_page_quote_json_scalar(v_val));
  ELSIF v_op = 'lt' THEN
    RETURN format('%s < %s', v_expr, public._admin_page_quote_json_scalar(v_val));
  ELSIF v_op = 'lte' THEN
    RETURN format('%s <= %s', v_expr, public._admin_page_quote_json_scalar(v_val));
  ELSIF v_op = 'is_null' THEN
    RETURN format('%s IS NULL', v_expr);
  ELSIF v_op = 'not_null' THEN
    RETURN format('%s IS NOT NULL', v_expr);
  ELSIF v_op = 'ilike' THEN
    RETURN format('%s ILIKE %s', v_expr, public._admin_page_quote_json_scalar(v_val));
  ELSIF v_op = 'in' THEN
    IF jsonb_typeof(v_val) <> 'array' OR jsonb_array_length(v_val) = 0 THEN
      RETURN 'FALSE';
    END IF;
    FOR v_elem IN SELECT * FROM jsonb_array_elements(v_val) LOOP
      v_parts := array_append(v_parts, public._admin_page_quote_json_scalar(v_elem));
    END LOOP;
    RETURN format('%s IN (%s)', v_expr, array_to_string(v_parts, ','));
  ELSIF v_op = 'not_in' THEN
    IF jsonb_typeof(v_val) <> 'array' OR jsonb_array_length(v_val) = 0 THEN
      RETURN 'TRUE';
    END IF;
    FOR v_elem IN SELECT * FROM jsonb_array_elements(v_val) LOOP
      v_parts := array_append(v_parts, public._admin_page_quote_json_scalar(v_elem));
    END LOOP;
    RETURN format('%s NOT IN (%s)', v_expr, array_to_string(v_parts, ','));
  ELSE
    RAISE EXCEPTION 'not authorized: filter op not allowed (%)', v_op USING ERRCODE = '42501';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._admin_page_pred_group(
  p_table text,
  p_filters jsonb,
  p_allowed_cols text[]
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_parts text[] := ARRAY[]::text[];
  v_filter jsonb;
BEGIN
  IF p_filters IS NULL OR jsonb_typeof(p_filters) <> 'array' OR jsonb_array_length(p_filters) = 0 THEN
    RETURN 'TRUE';
  END IF;
  FOR v_filter IN SELECT * FROM jsonb_array_elements(p_filters) LOOP
    v_parts := array_append(v_parts, public._admin_page_pred_one(p_table, v_filter, p_allowed_cols));
  END LOOP;
  RETURN '(' || array_to_string(v_parts, ' AND ') || ')';
END;
$fn$;

CREATE OR REPLACE FUNCTION public._admin_page_build_or_groups(
  p_table text,
  p_or_groups jsonb,
  p_allowed_cols text[]
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_or_parts text[] := ARRAY[]::text[];
  v_group jsonb;
BEGIN
  IF p_or_groups IS NULL OR jsonb_typeof(p_or_groups) <> 'array' OR jsonb_array_length(p_or_groups) = 0 THEN
    RETURN NULL;
  END IF;
  FOR v_group IN SELECT * FROM jsonb_array_elements(p_or_groups) LOOP
    v_or_parts := array_append(
      v_or_parts,
      public._admin_page_pred_group(p_table, v_group, p_allowed_cols)
    );
  END LOOP;
  RETURN '(' || array_to_string(v_or_parts, ' OR ') || ')';
END;
$fn$;

CREATE OR REPLACE FUNCTION public._admin_page_build_where(
  p_table text,
  p_args jsonb,
  p_allowed_cols text[]
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_parts text[] := ARRAY[]::text[];
  v_and text;
  v_or text;
  v_extra jsonb;
  v_block jsonb;
  v_block_sql text;
BEGIN
  v_and := public._admin_page_pred_group(
    p_table,
    COALESCE(p_args->'filters', '[]'::jsonb),
    p_allowed_cols
  );
  v_parts := array_append(v_parts, v_and);

  v_or := public._admin_page_build_or_groups(p_table, p_args->'or_groups', p_allowed_cols);
  IF v_or IS NOT NULL THEN
    v_parts := array_append(v_parts, v_or);
  END IF;

  -- Additional OR-blocks ANDed together (PostgREST multi-.or() pattern).
  v_extra := p_args->'and_or_groups';
  IF v_extra IS NOT NULL AND jsonb_typeof(v_extra) = 'array' THEN
    FOR v_block IN SELECT * FROM jsonb_array_elements(v_extra) LOOP
      v_block_sql := public._admin_page_build_or_groups(p_table, v_block, p_allowed_cols);
      IF v_block_sql IS NOT NULL THEN
        v_parts := array_append(v_parts, v_block_sql);
      END IF;
    END LOOP;
  END IF;

  RETURN '(' || array_to_string(v_parts, ' AND ') || ')';
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Generic select
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_page_select(
  p_page_slug text,
  p_table text,
  p_args jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_table text := lower(btrim(p_table));
  v_page text := lower(btrim(p_page_slug));
  v_allowed text[];
  v_cols_in jsonb;
  v_col text;
  v_select_cols text[] := ARRAY[]::text[];
  v_select_sql text;
  v_where text;
  v_order jsonb;
  v_order_sql text := '';
  v_ord jsonb;
  v_ord_parts text[] := ARRAY[]::text[];
  v_ord_col text;
  v_limit int := 100;
  v_offset int := 0;
  v_count_only boolean := false;
  v_include_count boolean := false;
  v_sql text;
  v_rows jsonb := '[]'::jsonb;
  v_count bigint := NULL;
BEGIN
  PERFORM public.admin_assert_staff_page(v_page);

  IF NOT public._admin_page_table_allowed(v_page, v_table) THEN
    RAISE EXCEPTION 'not authorized: page % cannot read %', v_page, v_table
      USING ERRCODE = '42501';
  END IF;

  v_allowed := public._admin_page_columns(v_table);
  IF cardinality(v_allowed) = 0 THEN
    RAISE EXCEPTION 'not authorized: unknown table %', v_table USING ERRCODE = '42501';
  END IF;

  v_count_only := COALESCE((p_args->>'count_only')::boolean, false);
  v_include_count := COALESCE((p_args->>'include_count')::boolean, false);
  v_limit := LEAST(GREATEST(COALESCE((p_args->>'limit')::int, 100), 0), 500);
  v_offset := GREATEST(COALESCE((p_args->>'offset')::int, 0), 0);

  v_where := public._admin_page_build_where(v_table, COALESCE(p_args, '{}'::jsonb), v_allowed);

  IF v_count_only OR v_include_count THEN
    v_sql := format('SELECT count(*) FROM public.%I WHERE %s', v_table, v_where);
    EXECUTE v_sql INTO v_count;
    IF v_count_only THEN
      RETURN jsonb_build_object('count', v_count, 'rows', '[]'::jsonb);
    END IF;
  END IF;

  v_cols_in := p_args->'columns';
  IF v_cols_in IS NULL OR jsonb_typeof(v_cols_in) <> 'array' OR jsonb_array_length(v_cols_in) = 0 THEN
    v_select_cols := v_allowed;
  ELSE
    FOR v_col IN SELECT lower(value #>> '{}') FROM jsonb_array_elements(v_cols_in) LOOP
      IF v_col = ANY (v_allowed) THEN
        v_select_cols := array_append(v_select_cols, v_col);
      END IF;
    END LOOP;
    IF cardinality(v_select_cols) = 0 THEN
      RAISE EXCEPTION 'not authorized: no allowed columns requested' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_select_sql := array_to_string(
    ARRAY(
      SELECT format('%s AS %I', public._admin_page_col_expr(v_table, c), c)
      FROM unnest(v_select_cols) AS c
    ),
    ', '
  );

  v_order := p_args->'order';
  IF v_order IS NOT NULL AND jsonb_typeof(v_order) = 'array' THEN
    FOR v_ord IN SELECT * FROM jsonb_array_elements(v_order) LOOP
      v_ord_col := lower(coalesce(v_ord->>'col', ''));
      IF v_ord_col = ANY (v_allowed) THEN
        v_ord_parts := array_append(
          v_ord_parts,
          format(
            '%s %s NULLS LAST',
            public._admin_page_col_expr(v_table, v_ord_col),
            CASE WHEN COALESCE((v_ord->>'asc')::boolean, true) THEN 'ASC' ELSE 'DESC' END
          )
        );
      END IF;
    END LOOP;
  END IF;
  IF cardinality(v_ord_parts) > 0 THEN
    v_order_sql := ' ORDER BY ' || array_to_string(v_ord_parts, ', ');
  END IF;

  v_sql := format(
    'SELECT COALESCE(jsonb_agg(row_to_json(q)), ''[]''::jsonb) FROM (SELECT %s FROM public.%I WHERE %s%s LIMIT %s OFFSET %s) q',
    v_select_sql,
    v_table,
    v_where,
    v_order_sql,
    v_limit,
    v_offset
  );
  EXECUTE v_sql INTO v_rows;

  RETURN jsonb_build_object(
    'rows', COALESCE(v_rows, '[]'::jsonb),
    'count', v_count
  );
END;
$fn$;

COMMENT ON FUNCTION public.admin_page_select(text, text, jsonb) IS
  'Page-gated SELECT for trips|drivers|customers|documents|vehicles. Asserts exact page grant + table allowlist + column/filter allowlists.';

REVOKE ALL ON FUNCTION public.admin_page_select(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_page_select(text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_page_select(text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_page_select(text, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Generic mutate (update / insert / delete)
-- trips: insert=manual-trip only; update=scheduled-rides|manual-trip|active-trips|missed-cancelled
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
    -- Optional extra match filters (scheduled-rides race-safe updates).
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
    IF v_table NOT IN ('drivers', 'trips') THEN
      RAISE EXCEPTION 'not authorized: insert only allowed for drivers|trips via this RPC'
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
    IF v_table <> 'documents' THEN
      RAISE EXCEPTION 'not authorized: delete only allowed for documents via this RPC'
        USING ERRCODE = '42501';
    END IF;
    SELECT ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_args->'ids', '[]'::jsonb))::uuid)
      INTO v_ids;
    IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
      RAISE EXCEPTION 'ids required for delete';
    END IF;
    DELETE FROM public.documents WHERE id = ANY (v_ids);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN jsonb_build_object('deleted', v_count);

  ELSE
    RAISE EXCEPTION 'not authorized: op %', v_op USING ERRCODE = '42501';
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.admin_page_mutate(text, text, text, jsonb) IS
  'Page-gated mutate for drivers|customers|documents|vehicles. Trips writes excluded (Edges/Owner).';

REVOKE ALL ON FUNCTION public.admin_page_mutate(text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_page_mutate(text, text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_page_mutate(text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_page_mutate(text, text, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Riders list RPC (+ optional view for Owner/service tooling)
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.admin_riders_with_trip_stats;

CREATE VIEW public.admin_riders_with_trip_stats
WITH (security_invoker = true)
AS
SELECT
  c.id,
  c.user_id,
  c.customer_code,
  c.first_name,
  c.last_name,
  c.phone,
  public.admin_get_user_email(c.user_id) AS email,
  c.created_at,
  c.updated_at,
  c.rider_status,
  c.email_verified,
  c.phone_verified,
  c.identity_verified_at,
  c.identity_provider,
  c.name_edit_locked,
  c.name_unlocked_at,
  COALESCE(ts.trip_count, 0) AS trip_count,
  ts.last_trip_at
FROM public.customers c
LEFT JOIN (
  SELECT
    t.passenger_id,
    count(*)::integer AS trip_count,
    max(t.created_at) AS last_trip_at
  FROM public.trips t
  WHERE t.passenger_id IS NOT NULL
    AND t.status = 'completed'
  GROUP BY t.passenger_id
) ts ON ts.passenger_id = c.id
WHERE c.deleted_at IS NULL
  AND (
    public.staff_has_page_access('riders')
    OR auth.role() = 'service_role'
  );

COMMENT ON VIEW public.admin_riders_with_trip_stats IS
  'Riders list view (security_invoker). Non-Owner after fail-closed must use admin_list_riders_page.';

REVOKE ALL ON TABLE public.admin_riders_with_trip_stats FROM PUBLIC;
REVOKE ALL ON TABLE public.admin_riders_with_trip_stats FROM anon;
GRANT SELECT ON TABLE public.admin_riders_with_trip_stats TO authenticated;
GRANT SELECT ON TABLE public.admin_riders_with_trip_stats TO service_role;

CREATE OR REPLACE FUNCTION public.admin_list_riders_page(
  p_args jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_status text := NULLIF(lower(btrim(COALESCE(p_args->>'status', ''))), '');
  v_search text := NULLIF(btrim(COALESCE(p_args->>'search', '')), '');
  v_limit int := LEAST(GREATEST(COALESCE((p_args->>'limit')::int, 50), 1), 200);
  v_offset int := GREATEST(COALESCE((p_args->>'offset')::int, 0), 0);
  v_id uuid := NULLIF(p_args->>'id', '')::uuid;
  v_count_only boolean := COALESCE((p_args->>'count_only')::boolean, false);
  v_min_trips int := COALESCE((p_args->>'min_trip_count')::int, NULL);
  v_created_gte timestamptz := NULLIF(p_args->>'created_gte', '')::timestamptz;
  v_where text := 'c.deleted_at IS NULL';
  v_sql text;
  v_count bigint;
  v_rows jsonb;
BEGIN
  PERFORM public.admin_assert_staff_page('riders');

  IF v_id IS NOT NULL THEN
    v_where := v_where || format(' AND c.id = %L', v_id);
  END IF;
  IF v_status IS NOT NULL AND v_status <> 'all' THEN
    v_where := v_where || format(' AND c.rider_status = %L', v_status);
  END IF;
  IF v_search IS NOT NULL THEN
    v_where := v_where || format(
      ' AND (c.first_name ILIKE %L OR c.last_name ILIKE %L OR c.phone ILIKE %L OR c.customer_code ILIKE %L)',
      '%' || v_search || '%',
      '%' || v_search || '%',
      '%' || v_search || '%',
      '%' || v_search || '%'
    );
  END IF;
  IF v_created_gte IS NOT NULL THEN
    v_where := v_where || format(' AND c.created_at >= %L', v_created_gte);
  END IF;

  v_sql := format(
    $q$
    WITH base AS (
      SELECT
        c.id,
        c.user_id,
        c.customer_code,
        c.first_name,
        c.last_name,
        c.phone,
        public.admin_get_user_email(c.user_id) AS email,
        c.created_at,
        c.updated_at,
        c.rider_status,
        c.email_verified,
        c.phone_verified,
        c.identity_verified_at,
        c.identity_provider,
        c.name_edit_locked,
        c.name_unlocked_at,
        COALESCE(ts.trip_count, 0)::integer AS trip_count,
        ts.last_trip_at
      FROM public.customers c
      LEFT JOIN (
        SELECT t.passenger_id, count(*)::integer AS trip_count, max(t.created_at) AS last_trip_at
        FROM public.trips t
        WHERE t.passenger_id IS NOT NULL AND t.status = 'completed'
        GROUP BY t.passenger_id
      ) ts ON ts.passenger_id = c.id
      WHERE %s
    )
    SELECT * FROM base
    WHERE (%s IS NULL OR trip_count >= %s)
    $q$,
    v_where,
    v_min_trips,
    COALESCE(v_min_trips, 0)
  );

  EXECUTE 'SELECT count(*) FROM (' || v_sql || ') s' INTO v_count;
  IF v_count_only THEN
    RETURN jsonb_build_object('count', v_count, 'rows', '[]'::jsonb);
  END IF;

  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(row_to_json(q)), ''[]''::jsonb) FROM (%s ORDER BY created_at DESC LIMIT %s OFFSET %s) q',
    v_sql,
    v_limit,
    v_offset
  ) INTO v_rows;

  RETURN jsonb_build_object('rows', COALESCE(v_rows, '[]'::jsonb), 'count', v_count);
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_list_riders_page(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_riders_page(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_riders_page(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_riders_page(jsonb) TO service_role;

-- Back-compat alias used by earlier wave-2 notes
CREATE OR REPLACE FUNCTION public.admin_list_riders_with_trip_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN public.admin_list_riders_page(jsonb_build_object('limit', 500, 'offset', 0));
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_list_riders_with_trip_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_riders_with_trip_stats() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_riders_with_trip_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_riders_with_trip_stats() TO service_role;

-- ---------------------------------------------------------------------------
-- Dashboard + sidebar aggregates
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_dashboard_period_stats(
  p_start timestamptz,
  p_end timestamptz,
  p_service_area_id text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_sa uuid;
  v_total_drivers int;
  v_online int;
  v_pending int;
  v_inactive int;
  v_on_trip int;
  v_available int;
  v_riders int;
  v_total_trips int;
  v_completed int;
  v_cancelled int;
  v_in_progress int;
  v_active_rows jsonb;
BEGIN
  PERFORM public.admin_assert_staff_page('dashboard');
  IF p_service_area_id IS NOT NULL AND p_service_area_id <> 'all' THEN
    v_sa := p_service_area_id::uuid;
  END IF;

  SELECT count(*) INTO v_total_drivers FROM public.drivers
  WHERE deleted_at IS NULL AND driver_status IS DISTINCT FROM 'deleted';
  SELECT count(*) INTO v_online FROM public.drivers
  WHERE deleted_at IS NULL AND driver_status IS DISTINCT FROM 'deleted' AND is_online = true;
  SELECT count(*) INTO v_pending FROM public.drivers
  WHERE deleted_at IS NULL AND driver_status IS DISTINCT FROM 'deleted' AND approval_status = 'pending';
  SELECT count(*) INTO v_inactive FROM public.drivers
  WHERE deleted_at IS NULL AND driver_status IS DISTINCT FROM 'deleted' AND approval_status = 'rejected';
  SELECT count(*) INTO v_on_trip FROM public.drivers
  WHERE deleted_at IS NULL AND driver_status IS DISTINCT FROM 'deleted'
    AND is_online = true AND current_trip_id IS NOT NULL;
  SELECT count(*) INTO v_available FROM public.drivers
  WHERE deleted_at IS NULL AND driver_status IS DISTINCT FROM 'deleted'
    AND is_online = true AND current_trip_id IS NULL;
  SELECT count(*) INTO v_riders FROM public.customers WHERE deleted_at IS NULL;

  SELECT count(*) INTO v_total_trips FROM public.trips t
  WHERE t.created_at >= p_start AND t.created_at <= p_end
    AND (v_sa IS NULL OR t.service_area_id = v_sa);
  SELECT count(*) INTO v_completed FROM public.trips t
  WHERE t.created_at >= p_start AND t.created_at <= p_end AND t.status = 'completed'
    AND (v_sa IS NULL OR t.service_area_id = v_sa);
  SELECT count(*) INTO v_cancelled FROM public.trips t
  WHERE t.created_at >= p_start AND t.created_at <= p_end AND t.status = 'cancelled'
    AND (v_sa IS NULL OR t.service_area_id = v_sa);
  SELECT count(*) INTO v_in_progress FROM public.trips t
  WHERE t.created_at >= p_start AND t.created_at <= p_end
    AND t.status = ANY (ARRAY['in_progress','started','on_trip','ongoing','trip_started'])
    AND (v_sa IS NULL OR t.service_area_id = v_sa);

  SELECT COALESCE(jsonb_agg(row_to_json(q)), '[]'::jsonb) INTO v_active_rows
  FROM (
    SELECT t.id, t.status, t.searching_expires_at, t.created_at
    FROM public.trips t
    WHERE t.status = ANY (ARRAY[
      'searching','accepted','arriving','arrived','in_progress','started','on_trip','ongoing','trip_started'
    ])
      AND (v_sa IS NULL OR t.service_area_id = v_sa)
    ORDER BY t.created_at DESC
    LIMIT 500
  ) q;

  RETURN jsonb_build_object(
    'totalDrivers', v_total_drivers,
    'onlineDrivers', v_online,
    'offlineDrivers', GREATEST(v_total_drivers - v_online, 0),
    'pendingDrivers', v_pending,
    'inactiveDrivers', v_inactive,
    'onTripDrivers', v_on_trip,
    'availableOnlineDrivers', v_available,
    'totalRiders', v_riders,
    'totalTrips', v_total_trips,
    'completedTrips', v_completed,
    'cancelledTrips', v_cancelled,
    'inProgressTrips', v_in_progress,
    'activeTripRows', COALESCE(v_active_rows, '[]'::jsonb)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_dashboard_period_stats(timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_dashboard_period_stats(timestamptz, timestamptz, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_period_stats(timestamptz, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_period_stats(timestamptz, timestamptz, text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_dashboard_chart_rows(
  p_start timestamptz,
  p_end timestamptz,
  p_service_area_id text DEFAULT 'all',
  p_limit int DEFAULT 2000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_sa uuid;
  v_rows jsonb;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 2000), 1), 5000);
BEGIN
  PERFORM public.admin_assert_staff_page('dashboard');
  IF p_service_area_id IS NOT NULL AND p_service_area_id <> 'all' THEN
    v_sa := p_service_area_id::uuid;
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(q)), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT t.status, t.created_at
    FROM public.trips t
    WHERE t.created_at >= p_start AND t.created_at <= p_end
      AND t.status = ANY (ARRAY['completed','cancelled'])
      AND (v_sa IS NULL OR t.service_area_id = v_sa)
    ORDER BY t.created_at DESC
    LIMIT v_limit
  ) q;

  RETURN COALESCE(v_rows, '[]'::jsonb);
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_dashboard_chart_rows(timestamptz, timestamptz, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_dashboard_chart_rows(timestamptz, timestamptz, text, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_chart_rows(timestamptz, timestamptz, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_chart_rows(timestamptz, timestamptz, text, int) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_sidebar_badge_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_active int := 0;
  v_scheduled int := 0;
  v_feedback int := 0;
  v_docs int := 0;
  v_promo int := 0;
  v_account int := 0;
  v_drivers int := 0;
  v_vehicle_changes int := 0;
  v_setting jsonb;
BEGIN
  -- Each badge requires the matching page grant (Owner passes via helper).
  IF public.staff_has_page_access('active-trips') THEN
    -- Mirror adminActiveBoardScheduledExclusivityOrFilter:
    -- instant (is_scheduled null/false) OR scheduled with a driver assigned.
    SELECT count(*) INTO v_active
    FROM public.trips t
    WHERE t.status = ANY (ARRAY[
      'searching','accepted','arriving','arrived','in_progress','started','on_trip','ongoing','trip_started'
    ])
      AND (
        t.is_scheduled IS NULL
        OR t.is_scheduled = false
        OR t.driver_id IS NOT NULL
      );
  END IF;

  IF public.staff_has_page_access('scheduled-rides') THEN
    SELECT count(*) INTO v_scheduled
    FROM public.trips t
    WHERE t.is_scheduled = true
      AND t.driver_id IS NULL
      AND t.status NOT IN ('completed','cancelled','no_show','expired')
      AND (t.scheduled_status IS NULL OR t.scheduled_status NOT IN ('cancelled','expired','no_driver_found'));
  END IF;

  IF public.staff_has_page_access('rider-feedback') THEN
    SELECT count(*) INTO v_feedback
    FROM public.rider_feedback rf
    WHERE rf.status = ANY (ARRAY['pending','new']);
  END IF;

  IF public.staff_has_page_access('documents') OR public.staff_has_page_access('document-management') THEN
    SELECT count(*) INTO v_docs
    FROM public.documents d
    JOIN public.drivers dr ON dr.id = d.driver_id
    WHERE d.status = 'pending' AND d.is_current = true AND dr.deleted_at IS NULL;
  END IF;

  IF public.staff_has_page_access('promo-codes') THEN
    SELECT count(*) INTO v_promo
    FROM public.promo_codes pc
    WHERE pc.is_active = true
      AND (pc.valid_until IS NULL OR pc.valid_until >= now());
  END IF;

  IF public.staff_has_page_access('account-requests') THEN
    SELECT setting_value INTO v_setting
    FROM public.admin_settings
    WHERE setting_key = 'account_requests'
    LIMIT 1;
    IF v_setting IS NOT NULL AND jsonb_typeof(v_setting) = 'array' THEN
      SELECT count(*) INTO v_account
      FROM jsonb_array_elements(v_setting) e
      WHERE e.value->>'status' = 'pending';
    END IF;
  END IF;

  IF public.staff_has_page_access('drivers') THEN
    SELECT count(*) INTO v_drivers
    FROM public.drivers d
    WHERE d.approval_status = 'pending' AND d.deleted_at IS NULL;
  END IF;

  IF public.staff_has_page_access('vehicles') OR public.staff_has_page_access('drivers') THEN
    SELECT count(*) INTO v_vehicle_changes
    FROM public.vehicle_change_requests vcr
    JOIN public.drivers dr ON dr.id = vcr.driver_id
    WHERE vcr.status = 'pending' AND dr.deleted_at IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'activeTrips', v_active,
    'scheduledRides', v_scheduled,
    'pendingFeedback', v_feedback,
    'pendingDocuments', v_docs,
    'activePromoCodes', v_promo,
    'pendingAccountRequests', v_account,
    'pendingDrivers', v_drivers,
    'pendingVehicleChanges', v_vehicle_changes
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_sidebar_badge_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_sidebar_badge_counts() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_sidebar_badge_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_sidebar_badge_counts() TO service_role;

COMMIT;
