-- Customer identity: switch decision path from Veriff to manual Admin review.
-- Keep SA modes, attempt budget, name lock, gate RPC.

-- Explicit image columns (metadata still allowed for extras)
ALTER TABLE public.customer_identity_verifications
  ADD COLUMN IF NOT EXISTS document_type text NULL
    CHECK (
      document_type IS NULL
      OR document_type IN ('driving_licence', 'passport', 'residence_permit')
    ),
  ADD COLUMN IF NOT EXISTS id_front_path text NULL,
  ADD COLUMN IF NOT EXISTS id_back_path text NULL,
  ADD COLUMN IF NOT EXISTS selfie_path text NULL;

COMMENT ON COLUMN public.customer_identity_verifications.document_type IS
  'Customer-selected ID type for manual review capture.';
COMMENT ON COLUMN public.customers.identity_verified_at IS
  'Set by Admin manual approve (or legacy Veriff webhook). Never trust client.';

-- Prefer manual review for new/updated SA settings defaults
UPDATE public.service_area_customer_identity_settings
SET provider = 'manual',
    updated_at = now()
WHERE provider = 'veriff' OR provider IS NULL OR provider = '';

ALTER TABLE public.service_area_customer_identity_settings
  ALTER COLUMN provider SET DEFAULT 'manual';

-- Pending submissions are readable by admins (already covered by admin SELECT).
CREATE INDEX IF NOT EXISTS idx_customer_identity_verifications_pending_review
  ON public.customer_identity_verifications (status, created_at DESC)
  WHERE status IN ('submitted', 'processing');

-- ---------------------------------------------------------------------------
-- Private storage bucket
-- Path: {customer_id}/{verification_id}/{kind}.jpg
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'customer-identity-documents',
  'customer-identity-documents',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Customers upload own identity documents"
  ON storage.objects;
CREATE POLICY "Customers upload own identity documents"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'customer-identity-documents'
    AND (storage.foldername(name))[1] IN (
      SELECT c.id::text
      FROM public.customers c
      WHERE c.user_id = auth.uid()
        AND c.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "Customers read own identity documents"
  ON storage.objects;
CREATE POLICY "Customers read own identity documents"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'customer-identity-documents'
    AND (storage.foldername(name))[1] IN (
      SELECT c.id::text
      FROM public.customers c
      WHERE c.user_id = auth.uid()
        AND c.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "Customers update own identity documents"
  ON storage.objects;
CREATE POLICY "Customers update own identity documents"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'customer-identity-documents'
    AND (storage.foldername(name))[1] IN (
      SELECT c.id::text
      FROM public.customers c
      WHERE c.user_id = auth.uid()
        AND c.deleted_at IS NULL
    )
  )
  WITH CHECK (
    bucket_id = 'customer-identity-documents'
    AND (storage.foldername(name))[1] IN (
      SELECT c.id::text
      FROM public.customers c
      WHERE c.user_id = auth.uid()
        AND c.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "Admins read customer identity documents"
  ON storage.objects;
CREATE POLICY "Admins read customer identity documents"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'customer-identity-documents'
    AND public.has_role(auth.uid(), 'admin'::app_role)
  );

DROP POLICY IF EXISTS "Service role manage customer identity documents"
  ON storage.objects;
CREATE POLICY "Service role manage customer identity documents"
  ON storage.objects FOR ALL
  USING (
    bucket_id = 'customer-identity-documents'
    AND auth.role() = 'service_role'
  )
  WITH CHECK (
    bucket_id = 'customer-identity-documents'
    AND auth.role() = 'service_role'
  );

-- ---------------------------------------------------------------------------
-- Admin decide identity (approve / decline / resubmission)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_decide_customer_identity(
  p_verification_id uuid,
  p_decision text,
  p_first_name text DEFAULT NULL,
  p_last_name text DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.customer_identity_verifications%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_now timestamptz := now();
  v_first text;
  v_last text;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_decision NOT IN ('approved', 'declined', 'resubmission_requested') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_DECISION');
  END IF;

  SELECT * INTO v_row
  FROM public.customer_identity_verifications
  WHERE id = p_verification_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  IF v_row.status = 'approved' THEN
    RETURN jsonb_build_object('ok', true, 'code', 'ALREADY_APPROVED', 'verification_id', v_row.id);
  END IF;

  IF v_row.status NOT IN ('submitted', 'processing', 'resubmission_requested', 'started') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'INVALID_STATUS',
      'status', v_row.status
    );
  END IF;

  UPDATE public.customer_identity_verifications
  SET
    status = p_decision,
    decided_at = v_now,
    submitted_at = COALESCE(submitted_at, v_now),
    failure_code = CASE
      WHEN p_decision = 'declined' THEN COALESCE(NULLIF(trim(p_note), ''), 'admin_declined')
      WHEN p_decision = 'resubmission_requested' THEN COALESCE(NULLIF(trim(p_note), ''), 'admin_resubmit')
      ELSE failure_code
    END,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'decided_via', 'admin_manual',
      'decided_by', v_uid,
      'admin_note', NULLIF(trim(p_note), '')
    ),
    updated_at = v_now
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  IF p_decision = 'approved' THEN
    SELECT * INTO v_customer
    FROM public.customers
    WHERE id = v_row.customer_id
      AND deleted_at IS NULL;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_NOT_FOUND');
    END IF;

    v_first := COALESCE(NULLIF(trim(p_first_name), ''), v_customer.first_name);
    v_last := COALESCE(NULLIF(trim(p_last_name), ''), v_customer.last_name);

    -- SECURITY DEFINER runs as owner; name-lock trigger allows service_role only.
    -- Force update via role bypass: set local config not available; use service pattern.
    -- Trigger checks auth.role() = service_role. Admin JWT is authenticated.
    -- So we temporarily disable trigger enforcement by using a session GUC.
    PERFORM set_config('app.bypass_customer_name_lock', '1', true);

    UPDATE public.customers
    SET
      first_name = COALESCE(v_first, first_name),
      last_name = COALESCE(v_last, last_name),
      identity_verified_at = v_now,
      identity_provider = 'manual',
      name_edit_locked = true,
      updated_at = v_now
    WHERE id = v_customer.id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'verification_id', v_row.id,
    'customer_id', v_row.customer_id,
    'status', v_row.status,
    'decided_at', v_row.decided_at
  );
END;
$$;

-- Allow Admin approve to update locked names when GUC is set
CREATE OR REPLACE FUNCTION public.tg_customers_enforce_name_edit_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(current_setting('app.bypass_customer_name_lock', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(OLD.name_edit_locked, false) = true
     AND (
       NEW.first_name IS DISTINCT FROM OLD.first_name
       OR NEW.last_name IS DISTINCT FROM OLD.last_name
     )
  THEN
    RAISE EXCEPTION 'CUSTOMER_NAME_EDIT_LOCKED'
      USING ERRCODE = 'P0001',
            DETAIL = 'Name edits are locked after identity verification. Admin unlock required.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) TO service_role;
