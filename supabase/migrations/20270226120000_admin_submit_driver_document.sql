-- Admin-assisted driver document upload entry point.
-- Reuses documents / document_attachments / supersession / compliance SSOT.
-- Does NOT redefine submit_driver_document (driver path remains locked).
-- Historical rows keep NULL audit fields (never invent upload_source='driver').

-- ---------------------------------------------------------------------------
-- 1. Audit columns (nullable — do not backfill historical uploads)
-- ---------------------------------------------------------------------------
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS upload_source text,
  ADD COLUMN IF NOT EXISTS uploaded_by uuid,
  ADD COLUMN IF NOT EXISTS admin_staff_id uuid,
  ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_upload_source_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_upload_source_check
      CHECK (upload_source IS NULL OR upload_source IN ('admin', 'driver'));
  END IF;
END $$;

COMMENT ON COLUMN public.documents.upload_source IS
  'Who submitted: admin | driver. NULL = historical / unknown — never invent.';
COMMENT ON COLUMN public.documents.uploaded_by IS
  'auth.users id of the uploader when known (admin auth uid for admin uploads).';
COMMENT ON COLUMN public.documents.admin_staff_id IS
  'staff_profiles.id when upload_source=admin.';
COMMENT ON COLUMN public.documents.uploaded_at IS
  'Submission timestamp when known. NULL for historical rows.';

CREATE INDEX IF NOT EXISTS idx_documents_admin_staff_id
  ON public.documents (admin_staff_id)
  WHERE admin_staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_upload_source
  ON public.documents (upload_source)
  WHERE upload_source IS NOT NULL;

-- Keep versioning-only demotes valid after new columns land.
CREATE OR REPLACE FUNCTION public.document_update_is_versioning_only(
  p_old public.documents,
  p_new public.documents
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public'
AS $function$
  SELECT
    p_old.id IS NOT DISTINCT FROM p_new.id
    AND p_old.driver_id IS NOT DISTINCT FROM p_new.driver_id
    AND p_old.document_type IS NOT DISTINCT FROM p_new.document_type
    AND p_old.document_name IS NOT DISTINCT FROM p_new.document_name
    AND p_old.file_url IS NOT DISTINCT FROM p_new.file_url
    AND p_old.status IS NOT DISTINCT FROM p_new.status
    AND p_old.expiry_date IS NOT DISTINCT FROM p_new.expiry_date
    AND p_old.notes IS NOT DISTINCT FROM p_new.notes
    AND p_old.rejection_reason IS NOT DISTINCT FROM p_new.rejection_reason
    AND p_old.reviewed_by IS NOT DISTINCT FROM p_new.reviewed_by
    AND p_old.reviewed_at IS NOT DISTINCT FROM p_new.reviewed_at
    AND p_old.created_at IS NOT DISTINCT FROM p_new.created_at
    AND p_old.document_type_id IS NOT DISTINCT FROM p_new.document_type_id
    AND p_old.last_reminded_at IS NOT DISTINCT FROM p_new.last_reminded_at
    AND p_old.reminder_sent_days IS NOT DISTINCT FROM p_new.reminder_sent_days
    AND p_old.submission_idempotency_key IS NOT DISTINCT FROM p_new.submission_idempotency_key
    AND p_old.upload_source IS NOT DISTINCT FROM p_new.upload_source
    AND p_old.uploaded_by IS NOT DISTINCT FROM p_new.uploaded_by
    AND p_old.admin_staff_id IS NOT DISTINCT FROM p_new.admin_staff_id
    AND p_old.uploaded_at IS NOT DISTINCT FROM p_new.uploaded_at;
$function$;

COMMENT ON FUNCTION public.document_update_is_versioning_only(public.documents, public.documents) IS
  'True when NEW differs from OLD only in is_current, superseded_by, and/or updated_at.';

-- ---------------------------------------------------------------------------
-- 2. RBAC: documents.admin_upload (page access alone is insufficient)
-- ---------------------------------------------------------------------------
INSERT INTO public.role_action_permissions (role_id, action_key, is_allowed)
SELECT c.id, 'documents.admin_upload',
       CASE
         WHEN c.is_owner_role THEN true
         WHEN c.base_role = 'admin' THEN true
         WHEN c.base_role = 'compliance_officer' THEN true
         ELSE false
       END
FROM public.staff_roles_catalog c
ON CONFLICT (role_id, action_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Registration verification eligibility (reuse drivers SSOT columns)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_has_completed_registration_verification(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.drivers d
    WHERE d.id = p_driver_id
      AND d.deleted_at IS NULL
      AND d.email_verified IS TRUE
      AND d.phone_verified IS TRUE
      AND d.terms_accepted_at IS NOT NULL
  );
$$;

COMMENT ON FUNCTION public.driver_has_completed_registration_verification(uuid) IS
  'Email verified + phone verified + Terms accepted. Used by Admin document upload eligibility.';

REVOKE ALL ON FUNCTION public.driver_has_completed_registration_verification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_has_completed_registration_verification(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_has_completed_registration_verification(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Storage: staff with documents.admin_upload may write under {driver_id}/
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Staff admin_upload insert driver documents" ON storage.objects;
CREATE POLICY "Staff admin_upload insert driver documents"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'driver-documents'
    AND public.staff_has_action(auth.uid(), 'documents.admin_upload')
    AND (storage.foldername(name))[1] IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.id::text = (storage.foldername(name))[1]
        AND d.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "Staff admin_upload update driver documents" ON storage.objects;
CREATE POLICY "Staff admin_upload update driver documents"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'driver-documents'
    AND public.staff_has_action(auth.uid(), 'documents.admin_upload')
  )
  WITH CHECK (
    bucket_id = 'driver-documents'
    AND public.staff_has_action(auth.uid(), 'documents.admin_upload')
  );

DROP POLICY IF EXISTS "Staff admin_upload select driver documents" ON storage.objects;
CREATE POLICY "Staff admin_upload select driver documents"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'driver-documents'
    AND public.staff_has_action(auth.uid(), 'documents.admin_upload')
  );

-- ---------------------------------------------------------------------------
-- 5. admin_submit_driver_document — Pending Review only; same supersession SSOT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_submit_driver_document(
  p_driver_id uuid,
  p_document_type_id uuid,
  p_storage_path text,
  p_side text DEFAULT 'front',
  p_expiry_date date DEFAULT NULL,
  p_mime_type text DEFAULT NULL,
  p_original_filename text DEFAULT NULL,
  p_file_size_bytes bigint DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_staff public.staff_profiles%ROWTYPE;
  v_driver public.drivers%ROWTYPE;
  v_dtype public.document_types%ROWTYPE;
  v_side text := lower(btrim(coalesce(p_side, 'front')));
  v_path text := btrim(coalesce(p_storage_path, ''));
  v_doc public.documents%ROWTYPE;
  v_att_id uuid;
  v_existing_att uuid;
  v_existing_doc_id uuid;
  v_reuse_pending boolean := false;
  v_can_replace boolean;
  v_expiry_status text;
  v_approval text;
  v_sa_expiry_required boolean;
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHENTICATED', 'message', 'Authentication required');
  END IF;

  IF NOT public.staff_has_action(v_uid, 'documents.admin_upload') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'FORBIDDEN',
      'message', 'documents.admin_upload permission required'
    );
  END IF;

  SELECT * INTO v_staff
  FROM public.staff_profiles
  WHERE user_id = v_uid AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Active staff profile required');
  END IF;

  IF p_driver_id IS NULL OR p_document_type_id IS NULL OR v_path = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_ARGS', 'message', 'driver, document type and storage path are required');
  END IF;

  IF v_side NOT IN ('front', 'back', 'single') THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_SIDE', 'message', 'side must be front, back, or single');
  END IF;

  -- Prevent path traversal / cross-driver uploads.
  IF v_path ~ '\.\.' OR position('/' in v_path) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_STORAGE_PATH', 'message', 'Invalid storage path');
  END IF;
  IF split_part(v_path, '/', 1) IS DISTINCT FROM p_driver_id::text THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'STORAGE_OWNERSHIP',
      'message', 'Storage path must be under the target driver id'
    );
  END IF;

  -- Object must already exist in the private bucket (upload happens via storage policies first).
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'driver-documents'
      AND o.name = v_path
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'STORAGE_MISSING',
      'message', 'File not found in driver-documents storage'
    );
  END IF;

  SELECT * INTO v_driver FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND OR v_driver.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_NOT_FOUND', 'message', 'Driver not found');
  END IF;

  IF NOT public.driver_has_completed_registration_verification(p_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DRIVER_NOT_ELIGIBLE',
      'message', 'Driver must complete email verification, phone verification and Terms acceptance before Admin upload'
    );
  END IF;

  SELECT * INTO v_dtype
  FROM public.document_types
  WHERE id = p_document_type_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'DOCUMENT_TYPE_NOT_FOUND', 'message', 'Document type not found or inactive');
  END IF;

  -- Service-area expiry requirement when driver has an assigned SA rule.
  SELECT coalesce(bool_or(r.expiry_required), v_dtype.has_expiry)
    INTO v_sa_expiry_required
  FROM public.driver_service_areas dsa
  JOIN public.service_area_document_rules r
    ON r.service_area_id = dsa.service_area_id
   AND r.doc_type_id = v_dtype.id
   AND r.is_active = true
  WHERE dsa.driver_id = p_driver_id;

  v_sa_expiry_required := coalesce(v_sa_expiry_required, v_dtype.has_expiry);

  IF v_sa_expiry_required AND p_expiry_date IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'EXPIRY_REQUIRED', 'message', 'Expiry date is required for this document type');
  END IF;

  -- Idempotency on attachment key (same as driver submit contract intent).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT da.id, da.document_id
      INTO v_existing_att, v_existing_doc_id
    FROM public.document_attachments da
    WHERE da.submission_idempotency_key = p_idempotency_key::text
    LIMIT 1;
    IF FOUND THEN
      SELECT * INTO v_doc FROM public.documents WHERE id = v_existing_doc_id;
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'document_id', v_doc.id,
        'attachment_id', v_existing_att,
        'status', v_doc.status
      );
    END IF;
  END IF;

  -- Replacement rules from compliance SSOT — same behaviour as Driver App.
  SELECT c.can_upload_replacement, c.expiry_status, c.approval_status
    INTO v_can_replace, v_expiry_status, v_approval
  FROM public.driver_document_compliance_ssot c
  WHERE c.driver_id = p_driver_id
    AND c.document_type_id = p_document_type_id
  LIMIT 1;

  IF v_approval = 'approved'
     AND v_expiry_status IN ('approved_valid', 'expiring_soon')
     AND coalesce(v_can_replace, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'REPLACEMENT_NOT_ALLOWED',
      'message', 'An approved document is still valid; replacement is not open yet'
    );
  END IF;

  -- Reuse current pending document for the other side; otherwise insert a new current pending row.
  SELECT * INTO v_doc
  FROM public.documents d
  WHERE d.driver_id = p_driver_id
    AND d.document_type_id = p_document_type_id
    AND d.is_current = true
    AND d.status = 'pending'
  ORDER BY d.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- Same-side resubmit on pending: create a fresh pending current row (supersession).
    IF EXISTS (
      SELECT 1 FROM public.document_attachments da
      WHERE da.document_id = v_doc.id
        AND da.side = v_side
        AND da.is_current = true
    ) THEN
      v_reuse_pending := false;
    ELSE
      v_reuse_pending := true;
    END IF;
  END IF;

  IF v_reuse_pending THEN
    -- Refresh expiry / audit on the pending shell when attaching another side.
    UPDATE public.documents
       SET expiry_date = coalesce(p_expiry_date, expiry_date),
           upload_source = 'admin',
           uploaded_by = v_uid,
           admin_staff_id = v_staff.id,
           uploaded_at = coalesce(uploaded_at, v_now),
           updated_at = v_now,
           status = 'pending',
           reviewed_by = NULL,
           reviewed_at = NULL,
           rejection_reason = NULL
     WHERE id = v_doc.id
    RETURNING * INTO v_doc;
  ELSE
    INSERT INTO public.documents (
      driver_id,
      document_type,
      document_type_id,
      document_name,
      status,
      expiry_date,
      is_current,
      file_url,
      submission_idempotency_key,
      upload_source,
      uploaded_by,
      admin_staff_id,
      uploaded_at
    ) VALUES (
      p_driver_id,
      v_dtype.slug,
      v_dtype.id,
      v_dtype.name,
      'pending',
      p_expiry_date,
      true,
      NULL,
      CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key::text ELSE NULL END,
      'admin',
      v_uid,
      v_staff.id,
      v_now
    )
    RETURNING * INTO v_doc;
  END IF;

  -- Force pending even if a trigger/admin bypass tried otherwise.
  IF v_doc.status IS DISTINCT FROM 'pending' THEN
    UPDATE public.documents
       SET status = 'pending',
           reviewed_by = NULL,
           reviewed_at = NULL
     WHERE id = v_doc.id
    RETURNING * INTO v_doc;
  END IF;

  INSERT INTO public.document_attachments (
    document_id,
    driver_id,
    document_type,
    document_type_id,
    side,
    storage_path,
    file_url,
    mime_type,
    original_filename,
    file_size_bytes,
    is_current,
    submission_idempotency_key
  ) VALUES (
    v_doc.id,
    p_driver_id,
    v_dtype.slug,
    v_dtype.id,
    v_side,
    v_path,
    v_path,
    p_mime_type,
    p_original_filename,
    p_file_size_bytes,
    true,
    CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key::text ELSE NULL END
  )
  RETURNING id INTO v_att_id;

  -- Demote prior current attachments of the same side on this document.
  UPDATE public.document_attachments
     SET is_current = false,
         superseded_by = v_att_id,
         updated_at = v_now
   WHERE document_id = v_doc.id
     AND side = v_side
     AND id IS DISTINCT FROM v_att_id
     AND is_current = true;

  BEGIN
    PERFORM public.sync_document_primary_file_url(v_doc.id);
  EXCEPTION WHEN undefined_function THEN
    -- sync helper is remote-managed; fall back to primary path on the document.
    UPDATE public.documents
       SET file_url = v_path,
           updated_at = v_now
     WHERE id = v_doc.id;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'document_id', v_doc.id,
    'attachment_id', v_att_id,
    'status', 'pending',
    'upload_source', 'admin',
    'admin_staff_id', v_staff.id,
    'side', v_side
  );
END;
$fn$;

COMMENT ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid) IS
  'Admin-assisted document submit. Requires documents.admin_upload + driver registration verification. Always pending review; uses existing supersession SSOT.';

REVOKE ALL ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid) TO service_role;


-- ---------------------------------------------------------------------------
-- 6. Page select allowlists: verification + audit columns for Drivers UI
-- ---------------------------------------------------------------------------
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
      'charges_enabled','email_verified','phone_verified','terms_accepted_at'
    ]
    WHEN 'customers' THEN ARRAY[
      'id','user_id','customer_code','first_name','last_name','phone','created_at','updated_at',
      'rider_status','email_verified','phone_verified','identity_verified_at','identity_provider',
      'name_edit_locked','name_unlocked_at','deleted_at','default_payment_method','wallet_balance'
    ]
    WHEN 'documents' THEN ARRAY[
      'id','driver_id','document_type','document_type_id','document_name','file_url','status',
      'expiry_date','notes','rejection_reason','reviewed_at','reviewed_by','created_at','updated_at',
      'is_current','superseded_by','last_reminded_at','reminder_sent_days','submission_idempotency_key',
      'upload_source','uploaded_by','admin_staff_id','uploaded_at'
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
