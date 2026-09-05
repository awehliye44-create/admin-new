-- Fix check_identity_exists: customers has no `email` column (email lives on auth.users).
-- The broken customers.email probe raised mid-function and aborted the whole RPC,
-- so create-onboarding-auth-user skipped identity checks and allowed signup with a
-- phone already confirmed on Driver Auth — then Android OTP could never complete.

CREATE OR REPLACE FUNCTION public.check_identity_exists(
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_phone     text := NULLIF(btrim(coalesce(p_phone, '')), '');
  v_email     text := lower(NULLIF(btrim(coalesce(p_email, '')), ''));
  v_phone_digits text;
  v_phone_hit boolean := false;
  v_email_hit boolean := false;
BEGIN
  -- ── Phone checks ───────────────────────────────────────────────────────────
  IF v_phone IS NOT NULL THEN
    v_phone_digits := public.normalize_phone_digits(v_phone);
  END IF;

  IF v_phone_digits IS NOT NULL AND length(v_phone_digits) >= 6 THEN
    -- 1. Confirmed phone in auth.users
    SELECT EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.deleted_at IS NULL
        AND u.phone_confirmed_at IS NOT NULL
        AND u.phone IS NOT NULL
        AND public.normalize_phone_digits(u.phone) = v_phone_digits
    ) INTO v_phone_hit;

    -- 2. Verified phone on a driver profile
    IF NOT v_phone_hit THEN
      SELECT EXISTS (
        SELECT 1 FROM public.drivers d
        WHERE d.deleted_at IS NULL
          AND d.phone IS NOT NULL
          AND (
            (
              d.phone_verified = true
              AND public.normalize_phone_digits(d.phone) = v_phone_digits
            )
            OR (
              d.pending_phone_change IS NOT NULL
              AND trim(d.pending_phone_change) <> ''
              AND d.pending_phone_change_verified_at IS NULL
              AND public.normalize_phone_digits(d.pending_phone_change) = v_phone_digits
              AND (
                (d.pending_phone_change_expires_at IS NOT NULL AND d.pending_phone_change_expires_at > now())
                OR (
                  d.pending_phone_change_expires_at IS NULL
                  AND d.pending_phone_change_requested_at IS NOT NULL
                  AND d.pending_phone_change_requested_at > now() - interval '30 minutes'
                )
              )
            )
          )
      ) INTO v_phone_hit;
    END IF;

    -- 3. Verified phone on a customer profile
    IF NOT v_phone_hit THEN
      SELECT EXISTS (
        SELECT 1 FROM public.customers c
        WHERE c.deleted_at IS NULL
          AND c.phone IS NOT NULL
          AND (
            (
              c.phone_verified = true
              AND public.normalize_phone_digits(c.phone) = v_phone_digits
            )
            OR (
              c.pending_phone_change IS NOT NULL
              AND trim(c.pending_phone_change) <> ''
              AND c.pending_phone_change_verified_at IS NULL
              AND public.normalize_phone_digits(c.pending_phone_change) = v_phone_digits
              AND (
                (c.pending_phone_change_expires_at IS NOT NULL AND c.pending_phone_change_expires_at > now())
                OR (
                  c.pending_phone_change_expires_at IS NULL
                  AND c.pending_phone_change_requested_at IS NOT NULL
                  AND c.pending_phone_change_requested_at > now() - interval '30 minutes'
                )
              )
            )
          )
      ) INTO v_phone_hit;
    END IF;

    -- 4. Active pending customer signup (staged onboarding)
    IF NOT v_phone_hit THEN
      SELECT EXISTS (
        SELECT 1 FROM public.pending_customer_signups pcs
        WHERE pcs.status IN ('pending', 'email_verified')
          AND pcs.expires_at > now()
          AND pcs.phone IS NOT NULL
          AND public.normalize_phone_digits(pcs.phone) = v_phone_digits
      ) INTO v_phone_hit;
    END IF;
  END IF;

  -- ── Email checks ───────────────────────────────────────────────────────────
  IF v_email IS NOT NULL AND v_email LIKE '%@%' THEN
    -- 1. Email confirmed in auth.users
    SELECT EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.deleted_at IS NULL
        AND lower(trim(coalesce(u.email, ''))) = v_email
        AND u.email_confirmed_at IS NOT NULL
    ) INTO v_email_hit;

    -- 2. Active driver profile with this email
    IF NOT v_email_hit THEN
      SELECT EXISTS (
        SELECT 1 FROM public.drivers d
        WHERE d.deleted_at IS NULL
          AND lower(trim(coalesce(d.email, ''))) = v_email
      ) INTO v_email_hit;
    END IF;

    -- 3. Active pending customer signup
    IF NOT v_email_hit THEN
      SELECT EXISTS (
        SELECT 1 FROM public.pending_customer_signups pcs
        WHERE lower(trim(coalesce(pcs.email, ''))) = v_email
          AND pcs.status IN ('pending', 'email_verified')
          AND pcs.expires_at > now()
      ) INTO v_email_hit;
    END IF;

    -- 4. Customer email is Auth-owned (no customers.email column).
    --    Treat as taken when a non-deleted customers row exists for an Auth user
    --    with this confirmed email.
    IF NOT v_email_hit THEN
      SELECT EXISTS (
        SELECT 1
        FROM auth.users u
        JOIN public.customers c ON c.user_id = u.id AND c.deleted_at IS NULL
        WHERE u.deleted_at IS NULL
          AND lower(trim(coalesce(u.email, ''))) = v_email
          AND u.email_confirmed_at IS NOT NULL
          AND (c.email_verified = true OR c.rider_status = 'active')
      ) INTO v_email_hit;
    END IF;

    -- 5. Pending email-change reservation (customer or driver)
    IF NOT v_email_hit THEN
      SELECT EXISTS (
        SELECT 1 FROM public.customers c
        WHERE c.deleted_at IS NULL
          AND public.is_email_pending_active(
            c.pending_email_change,
            c.pending_email_change_expires_at,
            c.pending_email_change_requested_at,
            c.pending_email_change_verified_at
          )
          AND lower(trim(coalesce(c.pending_email_change, ''))) = v_email
      ) OR EXISTS (
        SELECT 1 FROM public.drivers d
        WHERE d.deleted_at IS NULL
          AND public.is_email_pending_active(
            d.pending_email_change,
            d.pending_email_change_expires_at,
            d.pending_email_change_requested_at,
            d.pending_email_change_verified_at
          )
          AND lower(trim(coalesce(d.pending_email_change, ''))) = v_email
      ) INTO v_email_hit;
    END IF;

    -- 6. Unverified auth user that has an active live profile / pending signup
    IF NOT v_email_hit THEN
      SELECT EXISTS (
        SELECT 1 FROM auth.users u
        WHERE u.deleted_at IS NULL
          AND lower(trim(coalesce(u.email, ''))) = v_email
          AND u.email_confirmed_at IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM public.customers c
              WHERE c.user_id = u.id
                AND c.deleted_at IS NULL
                AND (c.email_verified = true OR c.rider_status = 'active')
            )
            OR EXISTS (
              SELECT 1 FROM public.drivers d
              WHERE d.user_id = u.id AND d.deleted_at IS NULL
            )
            OR EXISTS (
              SELECT 1 FROM public.pending_customer_signups pcs
              WHERE pcs.user_id = u.id
                AND pcs.status IN ('pending', 'email_verified')
                AND pcs.expires_at > now()
            )
          )
      ) INTO v_email_hit;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'phone_exists', v_phone_hit,
    'email_exists', v_email_hit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_identity_exists(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_identity_exists(text, text) TO service_role, authenticated, anon;
