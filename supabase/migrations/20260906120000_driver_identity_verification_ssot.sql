-- Driver identity re-verification SSOT (additive).
-- Authoritative workspace: admin-new (see docs/guides/DRIVER_IDENTITY_VERIFICATION_BACKEND_OWNERSHIP.md).
-- Do not duplicate into onecab-comfy-ride.

BEGIN;

-- ---------------------------------------------------------------------------
-- Service-area configuration (API/SQL-first; Admin UI later)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.service_area_identity_verification_settings (
  service_area_id uuid PRIMARY KEY REFERENCES public.service_areas(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  provider text NOT NULL DEFAULT 'veriff',
  provider_workflow_id text NULL,
  periodic_check_days integer NULL,
  random_check_percentage numeric(5,2) NOT NULL DEFAULT 0,
  verification_validity_days integer NULL,
  new_device_check_enabled boolean NOT NULL DEFAULT false,
  suspicious_login_check_enabled boolean NOT NULL DEFAULT false,
  unusual_location_check_enabled boolean NOT NULL DEFAULT false,
  maximum_attempts integer NOT NULL DEFAULT 3,
  manual_review_enabled boolean NOT NULL DEFAULT true,
  block_online_while_required boolean NOT NULL DEFAULT true,
  reminder_interval_hours integer NULL,
  session_expiry_minutes integer NOT NULL DEFAULT 30,
  active_work_deferral_enabled boolean NOT NULL DEFAULT true,
  declined_maps_to text NOT NULL DEFAULT 'rejected'
    CHECK (declined_maps_to IN ('rejected', 'manual_review', 'retry_required')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.service_area_identity_verification_settings IS
  'Per-service-area identity re-verification policy. App never chooses provider/workflow.';

ALTER TABLE public.service_area_identity_verification_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage SA identity verification settings"
  ON public.service_area_identity_verification_settings;
CREATE POLICY "Admins manage SA identity verification settings"
  ON public.service_area_identity_verification_settings
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Drivers read own SA identity verification settings"
  ON public.service_area_identity_verification_settings;
CREATE POLICY "Drivers read own SA identity verification settings"
  ON public.service_area_identity_verification_settings
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.user_id = auth.uid()
        AND d.deleted_at IS NULL
        AND d.service_area_id = service_area_id
    )
  );

-- ---------------------------------------------------------------------------
-- Verification attempts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.driver_identity_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_session_id text NULL,
  provider_reference text NULL,
  reason text NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NULL,
  liveness_result text NULL,
  face_match_result text NULL,
  image_quality_result text NULL,
  failure_code text NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  submitted_at timestamptz NULL,
  decided_at timestamptz NULL,
  expires_at timestamptz NULL,
  device_id text NULL,
  service_area_id uuid NULL REFERENCES public.service_areas(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_identity_verifications_status_check CHECK (
    status IN (
      'required',
      'deferred_active_work',
      'started',
      'processing',
      'approved',
      'retry_required',
      'manual_review',
      'rejected',
      'expired',
      'cancelled',
      'reference_unavailable'
    )
  ),
  CONSTRAINT driver_identity_verifications_reason_check CHECK (
    reason IN (
      'periodic_check',
      'random_check',
      'new_device',
      'suspicious_login',
      'unusual_location',
      'admin_requested',
      'expired_verification',
      'account_reactivation',
      'risk_rule',
      'provider_retry'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_identity_verifications_provider_session_uidx
  ON public.driver_identity_verifications (provider_session_id)
  WHERE provider_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS driver_identity_verifications_driver_idx
  ON public.driver_identity_verifications (driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS driver_identity_verifications_status_idx
  ON public.driver_identity_verifications (status);

CREATE INDEX IF NOT EXISTS driver_identity_verifications_expires_idx
  ON public.driver_identity_verifications (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS driver_identity_verifications_service_area_idx
  ON public.driver_identity_verifications (service_area_id);

-- One active blocking/in-flight verification per driver (transaction-safe).
CREATE UNIQUE INDEX IF NOT EXISTS driver_identity_verifications_one_active_per_driver_uidx
  ON public.driver_identity_verifications (driver_id)
  WHERE status IN (
    'required',
    'deferred_active_work',
    'started',
    'processing',
    'manual_review',
    'reference_unavailable'
  );

COMMENT ON TABLE public.driver_identity_verifications IS
  'Driver biometric re-verification attempts. Approval is server/webhook SSOT only; no client writes.';

ALTER TABLE public.driver_identity_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Drivers read own identity verifications"
  ON public.driver_identity_verifications;
CREATE POLICY "Drivers read own identity verifications"
  ON public.driver_identity_verifications
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.id = driver_id
        AND d.user_id = auth.uid()
        AND d.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "Admins read identity verifications"
  ON public.driver_identity_verifications;
CREATE POLICY "Admins read identity verifications"
  ON public.driver_identity_verifications
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- No INSERT/UPDATE/DELETE policies for authenticated clients — service_role / Edge only.

CREATE OR REPLACE FUNCTION public.tg_driver_identity_verifications_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_driver_identity_verifications_updated_at
  ON public.driver_identity_verifications;
CREATE TRIGGER tr_driver_identity_verifications_updated_at
  BEFORE UPDATE ON public.driver_identity_verifications
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_driver_identity_verifications_updated_at();

DROP TRIGGER IF EXISTS tr_sa_identity_verification_settings_updated_at
  ON public.service_area_identity_verification_settings;
CREATE TRIGGER tr_sa_identity_verification_settings_updated_at
  BEFORE UPDATE ON public.service_area_identity_verification_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_driver_identity_verifications_updated_at();

-- ---------------------------------------------------------------------------
-- Webhook idempotency
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.driver_identity_provider_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  provider_session_id text NULL,
  verification_id uuid NULL REFERENCES public.driver_identity_verifications(id) ON DELETE SET NULL,
  event_kind text NOT NULL,
  payload_hash text NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT driver_identity_provider_webhook_events_uidx
    UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS driver_identity_provider_webhook_events_session_idx
  ON public.driver_identity_provider_webhook_events (provider_session_id);

ALTER TABLE public.driver_identity_provider_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages identity webhook events"
  ON public.driver_identity_provider_webhook_events;
CREATE POLICY "Service role manages identity webhook events"
  ON public.driver_identity_provider_webhook_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

GRANT ALL ON public.driver_identity_provider_webhook_events TO service_role;

-- ---------------------------------------------------------------------------
-- Audit events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.driver_identity_verification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id uuid NULL REFERENCES public.driver_identity_verifications(id) ON DELETE SET NULL,
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  actor_user_id uuid NULL,
  actor_role text NOT NULL DEFAULT 'system',
  event_type text NOT NULL,
  from_status text NULL,
  to_status text NULL,
  reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS driver_identity_verification_events_driver_idx
  ON public.driver_identity_verification_events (driver_id, created_at DESC);

ALTER TABLE public.driver_identity_verification_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read identity verification events"
  ON public.driver_identity_verification_events;
CREATE POLICY "Admins read identity verification events"
  ON public.driver_identity_verification_events
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Drivers read own identity verification events"
  ON public.driver_identity_verification_events;
CREATE POLICY "Drivers read own identity verification events"
  ON public.driver_identity_verification_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.id = driver_id AND d.user_id = auth.uid() AND d.deleted_at IS NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Helpers: active accepted work + blocking identity gate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_has_accepted_active_or_stacked_work(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.id = p_driver_id
        AND d.current_trip_id IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM public.trips t
      WHERE t.driver_id = p_driver_id
        AND lower(COALESCE(t.dispatch_status, '')) = 'stacked_committed'
        AND lower(COALESCE(t.status, '')) NOT IN (
          'completed', 'cancelled', 'canceled', 'no_show', 'expired'
        )
    );
$$;

COMMENT ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) IS
  'True when driver has current_trip_id or stacked_committed accepted queued work.';

CREATE OR REPLACE FUNCTION public.get_driver_identity_verification_gate(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver public.drivers%ROWTYPE;
  v_settings public.service_area_identity_verification_settings%ROWTYPE;
  v_row public.driver_identity_verifications%ROWTYPE;
  v_has_work boolean;
BEGIN
  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = p_driver_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'blocking', false,
      'code', 'OK',
      'status', null,
      'verification_id', null
    );
  END IF;

  IF v_driver.service_area_id IS NULL THEN
    RETURN jsonb_build_object(
      'blocking', false,
      'code', 'OK',
      'status', null,
      'verification_id', null
    );
  END IF;

  SELECT * INTO v_settings
  FROM public.service_area_identity_verification_settings
  WHERE service_area_id = v_driver.service_area_id;

  IF NOT FOUND OR COALESCE(v_settings.enabled, false) <> true THEN
    RETURN jsonb_build_object(
      'blocking', false,
      'code', 'OK',
      'status', null,
      'verification_id', null
    );
  END IF;

  SELECT * INTO v_row
  FROM public.driver_identity_verifications
  WHERE driver_id = p_driver_id
    AND status IN (
      'required',
      'deferred_active_work',
      'started',
      'processing',
      'manual_review',
      'rejected',
      'reference_unavailable'
    )
  ORDER BY created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'blocking', false,
      'code', 'OK',
      'status', null,
      'verification_id', null
    );
  END IF;

  v_has_work := public.driver_has_accepted_active_or_stacked_work(p_driver_id);

  -- Never interrupt accepted work: treat as deferred for navigation, but still
  -- block NEW dispatch when policy says so.
  IF v_has_work AND COALESCE(v_settings.active_work_deferral_enabled, true) THEN
    RETURN jsonb_build_object(
      'blocking', false,
      'dispatch_blocked', COALESCE(v_settings.block_online_while_required, true),
      'code', 'IDENTITY_VERIFICATION_DEFERRED_ACTIVE_WORK',
      'status', v_row.status,
      'verification_id', v_row.id
    );
  END IF;

  IF v_row.status = 'rejected'
     OR (v_row.status = 'manual_review' AND COALESCE(v_settings.block_online_while_required, true))
     OR v_row.status = 'reference_unavailable'
  THEN
    RETURN jsonb_build_object(
      'blocking', COALESCE(v_settings.block_online_while_required, true),
      'dispatch_blocked', COALESCE(v_settings.block_online_while_required, true),
      'code', CASE
        WHEN v_row.status = 'manual_review' THEN 'IDENTITY_VERIFICATION_UNDER_REVIEW'
        WHEN v_row.status = 'reference_unavailable' THEN 'IDENTITY_REFERENCE_UNAVAILABLE'
        ELSE 'IDENTITY_VERIFICATION_BLOCKED'
      END,
      'status', v_row.status,
      'verification_id', v_row.id
    );
  END IF;

  IF v_row.status IN ('required', 'deferred_active_work', 'started', 'processing') THEN
    RETURN jsonb_build_object(
      'blocking', COALESCE(v_settings.block_online_while_required, true),
      'dispatch_blocked', COALESCE(v_settings.block_online_while_required, true),
      'code', CASE
        WHEN v_row.status = 'processing' THEN 'IDENTITY_VERIFICATION_PROCESSING'
        WHEN v_row.status = 'deferred_active_work' THEN 'IDENTITY_VERIFICATION_DEFERRED_ACTIVE_WORK'
        ELSE 'IDENTITY_VERIFICATION_REQUIRED'
      END,
      'status', v_row.status,
      'verification_id', v_row.id
    );
  END IF;

  RETURN jsonb_build_object(
    'blocking', false,
    'code', 'OK',
    'status', v_row.status,
    'verification_id', v_row.id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_driver_identity_verification_gate(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Patch go-online eligibility SSOT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_driver_presence_online_eligible(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver public.drivers%ROWTYPE;
  v_doc jsonb;
  v_has_vehicle boolean;
  v_identity jsonb;
BEGIN
  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = p_driver_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_NOT_FOUND',
      'message', 'Driver profile not found.'
    );
  END IF;

  IF lower(COALESCE(v_driver.approval_status, '')) <> 'approved' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_NOT_APPROVED',
      'message', 'Driver is not approved.'
    );
  END IF;

  IF lower(COALESCE(v_driver.driver_status::text, '')) <> 'active' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_ACCOUNT_DISABLED',
      'message', 'Driver account is disabled.'
    );
  END IF;

  IF COALESCE(v_driver.phone_verified, false) <> true THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'PHONE_UNVERIFIED',
      'message', 'Phone verification required before going online.'
    );
  END IF;

  IF v_driver.service_area_id IS NULL THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_SERVICE_AREA_NOT_ASSIGNED',
      'message', 'Assign a service area before going online.'
    );
  END IF;

  IF COALESCE(v_driver.vehicle_edit_request_status, '') = 'pending' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'VEHICLE_CHANGE_PENDING',
      'message', 'Vehicle change request is pending admin approval.'
    );
  END IF;

  v_doc := public.get_driver_document_eligibility(p_driver_id);
  IF COALESCE((v_doc ->> 'approved')::boolean, false) <> true THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', COALESCE(v_doc ->> 'code', 'DOCUMENTS_NOT_APPROVED'),
      'message', COALESCE(v_doc ->> 'message', 'Documents must be approved before going online.')
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.vehicles v
    WHERE v.driver_id = p_driver_id
      AND COALESCE(v.is_primary, false) = true
      AND lower(COALESCE(v.approval_status, '')) = 'approved'
  ) INTO v_has_vehicle;

  IF NOT v_has_vehicle THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'VEHICLE_NOT_APPROVED',
      'message', 'An approved primary vehicle is required before going online.'
    );
  END IF;

  v_identity := public.get_driver_identity_verification_gate(p_driver_id);
  IF COALESCE((v_identity ->> 'blocking')::boolean, false) = true THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', COALESCE(v_identity ->> 'code', 'IDENTITY_VERIFICATION_REQUIRED'),
      'message', 'Identity verification is required before going online.',
      'identity_status', v_identity ->> 'status',
      'verification_id', v_identity ->> 'verification_id'
    );
  END IF;

  RETURN jsonb_build_object('eligible', true, 'code', 'OK', 'message', '');
END;
$$;

-- Realtime for driver-owned verification rows (RLS still authorises).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'driver_identity_verifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.driver_identity_verifications;
  END IF;
END $$;

COMMIT;
