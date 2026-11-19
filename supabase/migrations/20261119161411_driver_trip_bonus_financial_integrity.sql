-- Trip-bonus financial integrity:
-- 1) Snapshot participant entitlements (target + reward + window)
-- 2) Freeze destructive edits once participation exists
-- 3) Unique BONUS ledger per campaign+driver
-- 4) Idempotent credit claim + reconcile (qualified-uncredited)
-- 5) Outbox must not mark done when in-window work remains unprocessed
-- 6) Credit-notice ack for Driver heads-up after durable wallet credit
--
-- Pre-flight: no existing trip-bonus ledger rows (audit 2026-11-19).

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Participant entitlement columns + backfill (preserve MK 2/3 @ £20)
-- ---------------------------------------------------------------------------
ALTER TABLE public.driver_trip_bonus_campaign_progress
  ADD COLUMN IF NOT EXISTS entitled_trip_target integer,
  ADD COLUMN IF NOT EXISTS entitled_bonus_amount_pence integer,
  ADD COLUMN IF NOT EXISTS entitled_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS entitled_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_frozen_at timestamptz,
  ADD COLUMN IF NOT EXISTS credit_notice_delivered_at timestamptz;

-- Backfill from current campaign row (authoritative live terms after MK 10→3 edit).
UPDATE public.driver_trip_bonus_campaign_progress p
SET
  entitled_trip_target = c.trip_target,
  entitled_bonus_amount_pence = c.bonus_amount_pence,
  entitled_starts_at = c.starts_at,
  entitled_ends_at = c.ends_at,
  terms_frozen_at = COALESCE(p.terms_frozen_at, p.created_at, now())
FROM public.driver_trip_bonus_campaigns c
WHERE c.id = p.campaign_id
  AND (
    p.entitled_trip_target IS NULL
    OR p.entitled_bonus_amount_pence IS NULL
  );

ALTER TABLE public.driver_trip_bonus_campaign_progress
  DROP CONSTRAINT IF EXISTS driver_trip_bonus_progress_entitled_target_chk;
ALTER TABLE public.driver_trip_bonus_campaign_progress
  ADD CONSTRAINT driver_trip_bonus_progress_entitled_target_chk
  CHECK (entitled_trip_target IS NULL OR entitled_trip_target >= 1);

ALTER TABLE public.driver_trip_bonus_campaign_progress
  DROP CONSTRAINT IF EXISTS driver_trip_bonus_progress_entitled_bonus_chk;
ALTER TABLE public.driver_trip_bonus_campaign_progress
  ADD CONSTRAINT driver_trip_bonus_progress_entitled_bonus_chk
  CHECK (entitled_bonus_amount_pence IS NULL OR entitled_bonus_amount_pence >= 1);

-- Campaign-level freeze marker (set when first participant/event appears).
ALTER TABLE public.driver_trip_bonus_campaigns
  ADD COLUMN IF NOT EXISTS financial_terms_frozen_at timestamptz;

UPDATE public.driver_trip_bonus_campaigns c
SET financial_terms_frozen_at = COALESCE(c.financial_terms_frozen_at, sub.first_at)
FROM (
  SELECT campaign_id, MIN(created_at) AS first_at
  FROM public.driver_trip_bonus_campaign_progress
  GROUP BY campaign_id
) sub
WHERE c.id = sub.campaign_id
  AND c.financial_terms_frozen_at IS NULL;

UPDATE public.driver_trip_bonus_campaigns c
SET financial_terms_frozen_at = COALESCE(c.financial_terms_frozen_at, sub.first_at)
FROM (
  SELECT campaign_id, MIN(counted_at) AS first_at
  FROM public.driver_trip_bonus_campaign_trip_events
  GROUP BY campaign_id
) sub
WHERE c.id = sub.campaign_id
  AND c.financial_terms_frozen_at IS NULL;

-- ---------------------------------------------------------------------------
-- B. Ledger uniqueness (trip-bonus BONUS only; Welcome/other BONUS untouched)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dup integer;
BEGIN
  SELECT COUNT(*) INTO v_dup
  FROM (
    SELECT driver_id, metadata->>'campaign_id' AS campaign_id
    FROM public.driver_wallet_ledger
    WHERE type = 'BONUS'
      AND metadata->>'source' = 'driver_trip_bonus_campaign'
      AND NULLIF(metadata->>'campaign_id', '') IS NOT NULL
    GROUP BY driver_id, metadata->>'campaign_id'
    HAVING COUNT(*) > 1
  ) d;
  IF v_dup > 0 THEN
    RAISE EXCEPTION 'trip_bonus_ledger_duplicates_exist:%', v_dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_trip_bonus_campaign_uidx
  ON public.driver_wallet_ledger (
    driver_id,
    ((metadata->>'campaign_id')::uuid)
  )
  WHERE type = 'BONUS'
    AND metadata->>'source' = 'driver_trip_bonus_campaign'
    AND NULLIF(metadata->>'campaign_id', '') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Helpers: entitlement snapshot + idempotent credit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.snapshot_driver_trip_bonus_entitlement(
  p_campaign_id uuid,
  p_driver_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  c public.driver_trip_bonus_campaigns%ROWTYPE;
BEGIN
  SELECT * INTO c
  FROM public.driver_trip_bonus_campaigns
  WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.driver_trip_bonus_campaign_progress
  SET
    entitled_trip_target = COALESCE(entitled_trip_target, c.trip_target),
    entitled_bonus_amount_pence = COALESCE(entitled_bonus_amount_pence, c.bonus_amount_pence),
    entitled_starts_at = COALESCE(entitled_starts_at, c.starts_at),
    entitled_ends_at = COALESCE(entitled_ends_at, c.ends_at),
    terms_frozen_at = COALESCE(terms_frozen_at, now()),
    updated_at = now()
  WHERE campaign_id = p_campaign_id
    AND driver_id = p_driver_id
    AND (
      entitled_trip_target IS NULL
      OR entitled_bonus_amount_pence IS NULL
      OR terms_frozen_at IS NULL
    );

  UPDATE public.driver_trip_bonus_campaigns
  SET financial_terms_frozen_at = COALESCE(financial_terms_frozen_at, now()),
      updated_at = now()
  WHERE id = p_campaign_id
    AND financial_terms_frozen_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.snapshot_driver_trip_bonus_entitlement(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_driver_trip_bonus_entitlement(uuid, uuid)
  TO service_role;

/**
 * Reconcile or insert exactly one BONUS credit for a qualified participant.
 * Never blindly inserts when a ledger row already exists for campaign+driver.
 */
CREATE OR REPLACE FUNCTION public.claim_or_reconcile_driver_trip_bonus_credit(
  p_campaign_id uuid,
  p_driver_id uuid,
  p_related_trip_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  p public.driver_trip_bonus_campaign_progress%ROWTYPE;
  c public.driver_trip_bonus_campaigns%ROWTYPE;
  v_target integer;
  v_amount integer;
  v_ledger_id uuid;
  v_existing_amount integer;
  v_desc text;
  v_title text;
BEGIN
  IF p_campaign_id IS NULL OR p_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ids');
  END IF;

  SELECT * INTO p
  FROM public.driver_trip_bonus_campaign_progress
  WHERE campaign_id = p_campaign_id
    AND driver_id = p_driver_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'progress_missing');
  END IF;

  IF p.credited_at IS NOT NULL AND p.ledger_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'credited', true,
      'already_credited', true,
      'ledger_entry_id', p.ledger_entry_id
    );
  END IF;

  SELECT * INTO c
  FROM public.driver_trip_bonus_campaigns
  WHERE id = p_campaign_id;

  v_target := COALESCE(p.entitled_trip_target, c.trip_target);
  v_amount := COALESCE(p.entitled_bonus_amount_pence, c.bonus_amount_pence);
  v_title := COALESCE(nullif(btrim(c.title), ''), 'Trip bonus');

  IF COALESCE(v_target, 0) < 1 OR COALESCE(v_amount, 0) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_entitlement');
  END IF;

  IF COALESCE(p.completed_count, 0) < v_target THEN
    RETURN jsonb_build_object(
      'ok', true,
      'credited', false,
      'qualified', false,
      'completed_count', p.completed_count,
      'trip_target', v_target
    );
  END IF;

  -- Authoritative ledger reconcile first (never second insert).
  SELECT id, amount_pence
    INTO v_ledger_id, v_existing_amount
  FROM public.driver_wallet_ledger
  WHERE driver_id = p_driver_id
    AND type = 'BONUS'
    AND metadata->>'source' = 'driver_trip_bonus_campaign'
    AND metadata->>'campaign_id' = p_campaign_id::text
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_ledger_id IS NOT NULL THEN
    UPDATE public.driver_trip_bonus_campaign_progress
    SET credited_at = COALESCE(credited_at, now()),
        ledger_entry_id = v_ledger_id,
        entitled_trip_target = COALESCE(entitled_trip_target, v_target),
        entitled_bonus_amount_pence = COALESCE(entitled_bonus_amount_pence, v_existing_amount, v_amount),
        updated_at = now()
    WHERE campaign_id = p_campaign_id
      AND driver_id = p_driver_id
      AND credited_at IS NULL;

    RETURN jsonb_build_object(
      'ok', true,
      'credited', true,
      'reconciled_existing_ledger', true,
      'ledger_entry_id', v_ledger_id,
      'amount_pence', v_existing_amount
    );
  END IF;

  v_desc := left('Trip bonus: ' || v_title, 240);

  BEGIN
    INSERT INTO public.driver_wallet_ledger (
      driver_id, type, amount_pence, currency, description, related_trip_id, metadata
    )
    VALUES (
      p_driver_id,
      'BONUS',
      v_amount,
      'GBP',
      v_desc,
      COALESCE(p_related_trip_id, p.last_trip_id),
      jsonb_build_object(
        'campaign_id', p_campaign_id,
        'description', v_desc,
        'source', 'driver_trip_bonus_campaign',
        'entitled_trip_target', v_target,
        'entitled_bonus_amount_pence', v_amount
      )
    )
    RETURNING id INTO v_ledger_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT id, amount_pence
        INTO v_ledger_id, v_existing_amount
      FROM public.driver_wallet_ledger
      WHERE driver_id = p_driver_id
        AND type = 'BONUS'
        AND metadata->>'source' = 'driver_trip_bonus_campaign'
        AND metadata->>'campaign_id' = p_campaign_id::text
      ORDER BY created_at ASC
      LIMIT 1;

      IF v_ledger_id IS NULL THEN
        RAISE;
      END IF;

      UPDATE public.driver_trip_bonus_campaign_progress
      SET credited_at = COALESCE(credited_at, now()),
          ledger_entry_id = v_ledger_id,
          updated_at = now()
      WHERE campaign_id = p_campaign_id
        AND driver_id = p_driver_id
        AND credited_at IS NULL;

      RETURN jsonb_build_object(
        'ok', true,
        'credited', true,
        'reconciled_unique_violation', true,
        'ledger_entry_id', v_ledger_id,
        'amount_pence', v_existing_amount
      );
  END;

  UPDATE public.driver_trip_bonus_campaign_progress
  SET credited_at = now(),
      ledger_entry_id = v_ledger_id,
      entitled_trip_target = COALESCE(entitled_trip_target, v_target),
      entitled_bonus_amount_pence = COALESCE(entitled_bonus_amount_pence, v_amount),
      terms_frozen_at = COALESCE(terms_frozen_at, now()),
      updated_at = now()
  WHERE campaign_id = p_campaign_id
    AND driver_id = p_driver_id
    AND credited_at IS NULL;

  IF NOT FOUND THEN
    -- Lost claim race after insert — roll back orphan ledger.
    RAISE EXCEPTION 'trip_bonus_credit_claim_failed';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'credited', true,
    'ledger_entry_id', v_ledger_id,
    'amount_pence', v_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_or_reconcile_driver_trip_bonus_credit(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_or_reconcile_driver_trip_bonus_credit(uuid, uuid, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Record progress: count in-window published campaigns; credit via claim helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_driver_trip_bonus_progress(
  p_driver_id uuid,
  p_trip_id uuid,
  p_service_area_id uuid DEFAULT NULL,
  p_region_id uuid DEFAULT NULL,
  p_completed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  r record;
  v_count integer;
  v_credited boolean;
  v_ledger_id uuid;
  v_results jsonb := '[]'::jsonb;
  v_now timestamptz := COALESCE(p_completed_at, now());
  v_credit jsonb;
  v_target integer;
  v_matched integer := 0;
  v_in_window_candidates integer := 0;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ids');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.trips t
    WHERE t.id = p_trip_id
      AND lower(t.status::text) = 'completed'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'trip_not_completed');
  END IF;

  -- Candidates: published + completed_at inside campaign window + scope.
  -- is_active is NOT required so deactivation after completion cannot drop
  -- in-window outbox processing. New Home enrollment still requires is_active.
  SELECT COUNT(*) INTO v_in_window_candidates
  FROM public.driver_trip_bonus_campaigns c
  WHERE c.status = 'published'
    AND (c.starts_at IS NULL OR c.starts_at <= v_now)
    AND (c.ends_at IS NULL OR c.ends_at > v_now)
    AND (
      c.scope_type = 'global'
      OR (c.scope_type = 'entire_region' AND c.region_id IS NOT NULL AND c.region_id = p_region_id)
      OR (
        c.scope_type = 'selected_service_areas'
        AND p_service_area_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.driver_trip_bonus_campaign_service_areas sa
          WHERE sa.campaign_id = c.id AND sa.service_area_id = p_service_area_id
        )
      )
    );

  FOR r IN
    SELECT c.*
    FROM public.driver_trip_bonus_campaigns c
    WHERE c.status = 'published'
      AND (c.starts_at IS NULL OR c.starts_at <= v_now)
      AND (c.ends_at IS NULL OR c.ends_at > v_now)
      AND (
        c.scope_type = 'global'
        OR (c.scope_type = 'entire_region' AND c.region_id IS NOT NULL AND c.region_id = p_region_id)
        OR (
          c.scope_type = 'selected_service_areas'
          AND p_service_area_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.driver_trip_bonus_campaign_service_areas sa
            WHERE sa.campaign_id = c.id AND sa.service_area_id = p_service_area_id
          )
        )
      )
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.driver_trip_bonus_campaign_progress p
      WHERE p.campaign_id = r.id
        AND p.driver_id = p_driver_id
        AND p.credited_at IS NOT NULL
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.driver_trip_bonus_campaign_trip_events (campaign_id, driver_id, trip_id)
    VALUES (r.id, p_driver_id, p_trip_id)
    ON CONFLICT DO NOTHING;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    v_matched := v_matched + 1;

    INSERT INTO public.driver_trip_bonus_campaign_progress (
      campaign_id, driver_id, completed_count, last_trip_id,
      entitled_trip_target, entitled_bonus_amount_pence,
      entitled_starts_at, entitled_ends_at, terms_frozen_at, updated_at
    )
    VALUES (
      r.id, p_driver_id, 1, p_trip_id,
      r.trip_target, r.bonus_amount_pence,
      r.starts_at, r.ends_at, now(), now()
    )
    ON CONFLICT (campaign_id, driver_id) DO UPDATE
      SET completed_count = public.driver_trip_bonus_campaign_progress.completed_count + 1,
          last_trip_id = EXCLUDED.last_trip_id,
          updated_at = now()
      WHERE public.driver_trip_bonus_campaign_progress.credited_at IS NULL
    RETURNING completed_count, (credited_at IS NOT NULL) INTO v_count, v_credited;

    PERFORM public.snapshot_driver_trip_bonus_entitlement(r.id, p_driver_id);

    IF v_count IS NULL THEN
      SELECT completed_count, credited_at IS NOT NULL
        INTO v_count, v_credited
      FROM public.driver_trip_bonus_campaign_progress
      WHERE campaign_id = r.id AND driver_id = p_driver_id;
    END IF;

    SELECT COALESCE(entitled_trip_target, r.trip_target)
      INTO v_target
    FROM public.driver_trip_bonus_campaign_progress
    WHERE campaign_id = r.id AND driver_id = p_driver_id;

    v_ledger_id := NULL;
    IF COALESCE(v_credited, false) = false
       AND COALESCE(v_count, 0) >= COALESCE(v_target, r.trip_target)
    THEN
      v_credit := public.claim_or_reconcile_driver_trip_bonus_credit(
        r.id, p_driver_id, p_trip_id
      );
      v_credited := COALESCE((v_credit->>'credited')::boolean, false);
      v_ledger_id := NULLIF(v_credit->>'ledger_entry_id', '')::uuid;
      IF COALESCE((v_credit->>'ok')::boolean, false) = false THEN
        RAISE EXCEPTION '%', COALESCE(v_credit->>'error', 'trip_bonus_credit_failed');
      END IF;
    END IF;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'campaign_id', r.id,
      'completed_count', v_count,
      'trip_target', COALESCE(v_target, r.trip_target),
      'credited', COALESCE(v_credited, false),
      'ledger_entry_id', v_ledger_id
    ));
  END LOOP;

  -- If an in-window published campaign existed but nothing was newly applied,
  -- only retry when outstanding uncredited work remains for this trip.
  IF v_matched = 0 AND v_in_window_candidates > 0 THEN
    IF EXISTS (
      SELECT 1
      FROM public.driver_trip_bonus_campaign_trip_events e
      WHERE e.trip_id = p_trip_id
        AND e.driver_id = p_driver_id
    ) THEN
      RETURN jsonb_build_object(
        'ok', true,
        'campaigns', v_results,
        'already_counted', true,
        'in_window_candidates', v_in_window_candidates
      );
    END IF;

    -- All in-window candidates already credited for this driver → durable no-op.
    IF NOT EXISTS (
      SELECT 1
      FROM public.driver_trip_bonus_campaigns c
      WHERE c.status = 'published'
        AND (c.starts_at IS NULL OR c.starts_at <= v_now)
        AND (c.ends_at IS NULL OR c.ends_at > v_now)
        AND (
          c.scope_type = 'global'
          OR (c.scope_type = 'entire_region' AND c.region_id IS NOT NULL AND c.region_id = p_region_id)
          OR (
            c.scope_type = 'selected_service_areas'
            AND p_service_area_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.driver_trip_bonus_campaign_service_areas sa
              WHERE sa.campaign_id = c.id AND sa.service_area_id = p_service_area_id
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.driver_trip_bonus_campaign_progress p
          WHERE p.campaign_id = c.id
            AND p.driver_id = p_driver_id
            AND p.credited_at IS NOT NULL
        )
    ) THEN
      RETURN jsonb_build_object(
        'ok', true,
        'campaigns', v_results,
        'already_credited_all', true,
        'in_window_candidates', v_in_window_candidates
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'error', 'in_window_not_applied',
      'campaigns', v_results,
      'in_window_candidates', v_in_window_candidates
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'campaigns', v_results,
    'in_window_candidates', v_in_window_candidates
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_driver_trip_bonus_progress(uuid, uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_driver_trip_bonus_progress(uuid, uuid, uuid, uuid, timestamptz)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Outbox drain: retry in_window_not_applied; never done on that error
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drain_driver_trip_bonus_progress_outbox(
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  r record;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 25), 100));
  v_processed integer := 0;
  v_succeeded integer := 0;
  v_failed integer := 0;
  v_result jsonb;
  v_backoff interval;
  v_attempts integer;
  v_err text;
BEGIN
  FOR r IN
    SELECT o.*
    FROM public.driver_trip_bonus_progress_outbox o
    WHERE o.status IN ('pending', 'processing')
      AND o.next_attempt_at <= now()
    ORDER BY o.next_attempt_at ASC, o.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  LOOP
    v_processed := v_processed + 1;
    v_attempts := r.attempt_count + 1;

    UPDATE public.driver_trip_bonus_progress_outbox
    SET status = 'processing',
        attempt_count = v_attempts,
        updated_at = now()
    WHERE id = r.id;

    BEGIN
      v_result := public.record_driver_trip_bonus_progress(
        r.driver_id,
        r.trip_id,
        r.service_area_id,
        r.region_id,
        r.completed_at
      );

      v_err := COALESCE(v_result->>'error', '');

      IF COALESCE((v_result->>'ok')::boolean, false) = false
         AND v_err IN ('trip_not_completed', 'in_window_not_applied')
      THEN
        v_backoff := make_interval(secs => LEAST(300, 5 * v_attempts));
        UPDATE public.driver_trip_bonus_progress_outbox
        SET status = CASE WHEN v_attempts >= 12 THEN 'dead' ELSE 'pending' END,
            next_attempt_at = now() + v_backoff,
            last_error = left(v_err, 500),
            result = v_result,
            updated_at = now()
        WHERE id = r.id;
        v_failed := v_failed + 1;
      ELSIF COALESCE((v_result->>'ok')::boolean, false) = false THEN
        v_backoff := make_interval(secs => LEAST(900, 10 * (2 ^ LEAST(v_attempts, 6))));
        UPDATE public.driver_trip_bonus_progress_outbox
        SET status = CASE WHEN v_attempts >= 12 THEN 'dead' ELSE 'pending' END,
            next_attempt_at = now() + v_backoff,
            last_error = left(v_err, 500),
            result = v_result,
            updated_at = now()
        WHERE id = r.id;
        v_failed := v_failed + 1;
      ELSE
        UPDATE public.driver_trip_bonus_progress_outbox
        SET status = 'done',
            processed_at = now(),
            last_error = NULL,
            result = v_result,
            updated_at = now()
        WHERE id = r.id;
        v_succeeded := v_succeeded + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_backoff := make_interval(secs => LEAST(900, 10 * (2 ^ LEAST(v_attempts, 6))));
      UPDATE public.driver_trip_bonus_progress_outbox
      SET status = CASE WHEN v_attempts >= 12 THEN 'dead' ELSE 'pending' END,
          next_attempt_at = now() + v_backoff,
          last_error = left(SQLERRM, 500),
          updated_at = now()
      WHERE id = r.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'processed', v_processed,
    'succeeded', v_succeeded,
    'failed', v_failed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.drain_driver_trip_bonus_progress_outbox(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drain_driver_trip_bonus_progress_outbox(integer)
  TO service_role;

-- Keep single-trip processor aligned with drain semantics.
CREATE OR REPLACE FUNCTION public.process_driver_trip_bonus_progress_outbox_trip(
  p_trip_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  r public.driver_trip_bonus_progress_outbox%ROWTYPE;
  v_result jsonb;
  v_attempts integer;
  v_backoff interval;
  v_err text;
BEGIN
  IF p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_trip_id');
  END IF;

  SELECT * INTO r
  FROM public.driver_trip_bonus_progress_outbox
  WHERE trip_id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'outbox_missing');
  END IF;

  IF r.status = 'done' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'done', 'result', r.result);
  END IF;

  v_attempts := r.attempt_count + 1;
  UPDATE public.driver_trip_bonus_progress_outbox
  SET status = 'processing',
      attempt_count = v_attempts,
      updated_at = now()
  WHERE id = r.id;

  BEGIN
    v_result := public.record_driver_trip_bonus_progress(
      r.driver_id,
      r.trip_id,
      r.service_area_id,
      r.region_id,
      r.completed_at
    );

    v_err := COALESCE(v_result->>'error', '');

    IF COALESCE((v_result->>'ok')::boolean, false) = false
       AND v_err IN ('trip_not_completed', 'in_window_not_applied')
    THEN
      v_backoff := make_interval(secs => LEAST(300, 5 * v_attempts));
      UPDATE public.driver_trip_bonus_progress_outbox
      SET status = CASE WHEN v_attempts >= 12 THEN 'dead' ELSE 'pending' END,
          next_attempt_at = now() + v_backoff,
          last_error = left(v_err, 500),
          result = v_result,
          updated_at = now()
      WHERE id = r.id;
      RETURN jsonb_build_object('ok', false, 'status', 'pending', 'error', v_err, 'result', v_result);
    END IF;

    IF COALESCE((v_result->>'ok')::boolean, false) = false THEN
      v_backoff := make_interval(secs => LEAST(900, 10 * (2 ^ LEAST(v_attempts, 6))));
      UPDATE public.driver_trip_bonus_progress_outbox
      SET status = CASE WHEN v_attempts >= 12 THEN 'dead' ELSE 'pending' END,
          next_attempt_at = now() + v_backoff,
          last_error = left(v_err, 500),
          result = v_result,
          updated_at = now()
      WHERE id = r.id;
      RETURN jsonb_build_object('ok', false, 'status', 'pending', 'error', v_err, 'result', v_result);
    END IF;

    UPDATE public.driver_trip_bonus_progress_outbox
    SET status = 'done',
        processed_at = now(),
        last_error = NULL,
        result = v_result,
        updated_at = now()
    WHERE id = r.id;

    RETURN jsonb_build_object('ok', true, 'status', 'done', 'result', v_result);
  EXCEPTION WHEN OTHERS THEN
    v_backoff := make_interval(secs => LEAST(900, 10 * (2 ^ LEAST(v_attempts, 6))));
    UPDATE public.driver_trip_bonus_progress_outbox
    SET status = CASE WHEN v_attempts >= 12 THEN 'dead' ELSE 'pending' END,
        next_attempt_at = now() + v_backoff,
        last_error = left(SQLERRM, 500),
        updated_at = now()
    WHERE id = r.id;
    RETURN jsonb_build_object(
      'ok', false,
      'status', CASE WHEN v_attempts >= 12 THEN 'dead' ELSE 'pending' END,
      'error', SQLERRM
    );
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.process_driver_trip_bonus_progress_outbox_trip(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_driver_trip_bonus_progress_outbox_trip(uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- C. Permanent reconcile for qualified-uncredited + bounded dead requeue
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_driver_trip_bonus_qualified_credits(
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  r record;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
  v_scanned integer := 0;
  v_credited integer := 0;
  v_failed integer := 0;
  v_result jsonb;
  v_target integer;
BEGIN
  FOR r IN
    SELECT p.campaign_id, p.driver_id, p.completed_count, p.last_trip_id,
           p.entitled_trip_target, c.trip_target AS campaign_trip_target
    FROM public.driver_trip_bonus_campaign_progress p
    JOIN public.driver_trip_bonus_campaigns c ON c.id = p.campaign_id
    WHERE p.credited_at IS NULL
      AND p.completed_count >= COALESCE(p.entitled_trip_target, c.trip_target)
    ORDER BY p.updated_at ASC
    FOR UPDATE OF p SKIP LOCKED
    LIMIT v_limit
  LOOP
    v_scanned := v_scanned + 1;
    v_target := COALESCE(r.entitled_trip_target, r.campaign_trip_target);
    IF r.completed_count < v_target THEN
      CONTINUE;
    END IF;
    BEGIN
      v_result := public.claim_or_reconcile_driver_trip_bonus_credit(
        r.campaign_id, r.driver_id, r.last_trip_id
      );
      IF COALESCE((v_result->>'credited')::boolean, false) THEN
        v_credited := v_credited + 1;
      ELSIF COALESCE((v_result->>'ok')::boolean, false) = false THEN
        v_failed := v_failed + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'scanned', v_scanned,
    'credited', v_credited,
    'failed', v_failed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_driver_trip_bonus_qualified_credits(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_driver_trip_bonus_qualified_credits(integer)
  TO service_role;

-- Auto-reenqueue dead outbox (bounded): reset rows idle > 15m, max 3 auto cycles
-- via attempt_count reset only when last_error is recoverable.
CREATE OR REPLACE FUNCTION public.auto_reenqueue_dead_driver_trip_bonus_progress_outbox(
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  UPDATE public.driver_trip_bonus_progress_outbox o
  SET status = 'pending',
      attempt_count = 0,
      next_attempt_at = now(),
      last_error = left('auto_reenqueue:' || COALESCE(o.last_error, ''), 500),
      updated_at = now()
  WHERE o.id IN (
    SELECT id
    FROM public.driver_trip_bonus_progress_outbox
    WHERE status = 'dead'
      AND updated_at <= now() - interval '15 minutes'
      AND COALESCE(last_error, '') NOT ILIKE '%unrecoverable%'
    ORDER BY updated_at ASC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100))
  );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'requeued', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.auto_reenqueue_dead_driver_trip_bonus_progress_outbox(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_reenqueue_dead_driver_trip_bonus_progress_outbox(integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.sweep_driver_trip_bonus_progress_outbox()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.auto_reenqueue_dead_driver_trip_bonus_progress_outbox(25);
  PERFORM public.drain_driver_trip_bonus_progress_outbox(50);
  PERFORM public.reconcile_driver_trip_bonus_qualified_credits(50);
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_driver_trip_bonus_progress_outbox()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_driver_trip_bonus_progress_outbox()
  TO service_role;

-- ---------------------------------------------------------------------------
-- Admin save: freeze financial / scope / window once participation exists
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_save_driver_trip_bonus_campaign(
  p_campaign jsonb,
  p_service_area_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_id uuid := NULLIF(p_campaign->>'id', '')::uuid;
  v_uid uuid := auth.uid();
  v_scope text := COALESCE(NULLIF(p_campaign->>'scope_type', ''), 'selected_service_areas');
  v_region uuid := NULLIF(p_campaign->>'region_id', '')::uuid;
  v_target integer := COALESCE((p_campaign->>'trip_target')::integer, 0);
  v_bonus integer := COALESCE((p_campaign->>'bonus_amount_pence')::integer, 0);
  v_existing public.driver_trip_bonus_campaigns%ROWTYPE;
  v_frozen boolean := false;
  v_new_starts timestamptz := NULLIF(p_campaign->>'starts_at', '')::timestamptz;
  v_new_ends timestamptz := NULLIF(p_campaign->>'ends_at', '')::timestamptz;
  v_sa_changed boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.is_super_admin(v_uid)
       OR public.staff_has_page_access('driver-trip-bonuses')
     )
  THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_target < 1 THEN
    RAISE EXCEPTION 'trip_target_min_1';
  END IF;
  IF v_bonus < 1 THEN
    RAISE EXCEPTION 'bonus_amount_min_1';
  END IF;
  IF v_scope = 'entire_region' AND v_region IS NULL THEN
    RAISE EXCEPTION 'region_required';
  END IF;
  IF v_scope = 'global' THEN
    v_region := NULL;
  END IF;
  IF v_scope = 'selected_service_areas'
     AND (p_service_area_ids IS NULL OR coalesce(array_length(p_service_area_ids, 1), 0) = 0)
  THEN
    RAISE EXCEPTION 'service_areas_required';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.driver_trip_bonus_campaigns (
      title, card_headline, card_body, trip_target, bonus_amount_pence,
      status, is_active, starts_at, ends_at, scope_type, region_id,
      display_priority, created_by, updated_by
    )
    VALUES (
      NULLIF(btrim(p_campaign->>'title'), ''),
      NULLIF(btrim(p_campaign->>'card_headline'), ''),
      NULLIF(btrim(p_campaign->>'card_body'), ''),
      v_target,
      v_bonus,
      COALESCE(NULLIF(p_campaign->>'status', ''), 'draft'),
      COALESCE((p_campaign->>'is_active')::boolean, true),
      v_new_starts,
      v_new_ends,
      v_scope,
      v_region,
      COALESCE((p_campaign->>'display_priority')::integer, 0),
      v_uid,
      v_uid
    )
    RETURNING id INTO v_id;
  ELSE
    SELECT * INTO v_existing
    FROM public.driver_trip_bonus_campaigns
    WHERE id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND';
    END IF;

    v_frozen := v_existing.financial_terms_frozen_at IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM public.driver_trip_bonus_campaign_progress p
        WHERE p.campaign_id = v_id
      )
      OR EXISTS (
        SELECT 1 FROM public.driver_trip_bonus_campaign_trip_events e
        WHERE e.campaign_id = v_id
      );

    IF v_frozen THEN
      IF v_target IS DISTINCT FROM v_existing.trip_target THEN
        RAISE EXCEPTION 'trip_bonus_terms_frozen:trip_target';
      END IF;
      IF v_bonus IS DISTINCT FROM v_existing.bonus_amount_pence THEN
        RAISE EXCEPTION 'trip_bonus_terms_frozen:bonus_amount';
      END IF;
      IF v_scope IS DISTINCT FROM v_existing.scope_type THEN
        RAISE EXCEPTION 'trip_bonus_terms_frozen:scope_type';
      END IF;
      IF v_region IS DISTINCT FROM v_existing.region_id THEN
        RAISE EXCEPTION 'trip_bonus_terms_frozen:region_id';
      END IF;
      -- Destructive window edits: cannot start later or end earlier.
      IF v_existing.starts_at IS NOT NULL
         AND (v_new_starts IS NULL OR v_new_starts > v_existing.starts_at)
      THEN
        RAISE EXCEPTION 'trip_bonus_terms_frozen:starts_at';
      END IF;
      IF v_existing.ends_at IS NOT NULL
         AND (v_new_ends IS NULL OR v_new_ends < v_existing.ends_at)
      THEN
        RAISE EXCEPTION 'trip_bonus_terms_frozen:ends_at';
      END IF;

      IF v_scope = 'selected_service_areas' THEN
        SELECT EXISTS (
          SELECT 1
          FROM (
            SELECT service_area_id FROM public.driver_trip_bonus_campaign_service_areas
            WHERE campaign_id = v_id
            EXCEPT
            SELECT UNNEST(p_service_area_ids)
          ) removed
        ) OR EXISTS (
          SELECT 1
          FROM (
            SELECT UNNEST(p_service_area_ids)
            EXCEPT
            SELECT service_area_id FROM public.driver_trip_bonus_campaign_service_areas
            WHERE campaign_id = v_id
          ) added
        ) INTO v_sa_changed;
        IF v_sa_changed THEN
          RAISE EXCEPTION 'trip_bonus_terms_frozen:service_areas';
        END IF;
      END IF;
    END IF;

    UPDATE public.driver_trip_bonus_campaigns SET
      title = NULLIF(btrim(p_campaign->>'title'), ''),
      card_headline = NULLIF(btrim(p_campaign->>'card_headline'), ''),
      card_body = NULLIF(btrim(p_campaign->>'card_body'), ''),
      trip_target = CASE WHEN v_frozen THEN trip_target ELSE v_target END,
      bonus_amount_pence = CASE WHEN v_frozen THEN bonus_amount_pence ELSE v_bonus END,
      status = COALESCE(NULLIF(p_campaign->>'status', ''), status),
      is_active = COALESCE((p_campaign->>'is_active')::boolean, is_active),
      starts_at = CASE WHEN v_frozen THEN starts_at ELSE v_new_starts END,
      ends_at = CASE
        WHEN v_frozen AND v_existing.ends_at IS NOT NULL AND v_new_ends IS NOT NULL
             AND v_new_ends >= v_existing.ends_at
          THEN v_new_ends
        WHEN v_frozen THEN ends_at
        ELSE v_new_ends
      END,
      scope_type = CASE WHEN v_frozen THEN scope_type ELSE v_scope END,
      region_id = CASE WHEN v_frozen THEN region_id ELSE v_region END,
      display_priority = COALESCE((p_campaign->>'display_priority')::integer, display_priority),
      updated_by = v_uid,
      updated_at = now()
    WHERE id = v_id;
  END IF;

  IF NOT COALESCE(v_frozen, false) THEN
    DELETE FROM public.driver_trip_bonus_campaign_service_areas WHERE campaign_id = v_id;

    IF v_scope = 'selected_service_areas' THEN
      INSERT INTO public.driver_trip_bonus_campaign_service_areas (campaign_id, service_area_id)
      SELECT v_id, sa FROM unnest(p_service_area_ids) AS sa
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_save_driver_trip_bonus_campaign(jsonb, uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_driver_trip_bonus_campaign(jsonb, uuid[])
  TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin finance summary (liability + statuses)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_driver_trip_bonus_campaign_finance_summary(
  p_campaign_id uuid DEFAULT NULL
)
RETURNS TABLE (
  campaign_id uuid,
  title text,
  trip_target integer,
  bonus_amount_pence integer,
  participants integer,
  in_progress integer,
  qualified_credit_pending integer,
  credited integer,
  recovery_required integer,
  expected_liability_pence bigint,
  credited_total_pence bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
       public.is_super_admin(v_uid)
       OR public.staff_has_page_access('driver-trip-bonuses')
     )
  THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.title,
    c.trip_target,
    c.bonus_amount_pence,
    COUNT(p.driver_id)::integer AS participants,
    COUNT(*) FILTER (
      WHERE p.credited_at IS NULL
        AND p.completed_count < COALESCE(p.entitled_trip_target, c.trip_target)
    )::integer AS in_progress,
    COUNT(*) FILTER (
      WHERE p.credited_at IS NULL
        AND p.completed_count >= COALESCE(p.entitled_trip_target, c.trip_target)
    )::integer AS qualified_credit_pending,
    COUNT(*) FILTER (WHERE p.credited_at IS NOT NULL)::integer AS credited,
    (
      SELECT COUNT(*)::integer
      FROM public.driver_trip_bonus_progress_outbox o
      WHERE o.status = 'dead'
        AND (
          p_campaign_id IS NULL
          OR EXISTS (
            SELECT 1 FROM public.driver_trip_bonus_campaign_trip_events e
            WHERE e.trip_id = o.trip_id AND e.campaign_id = c.id
          )
          OR EXISTS (
            SELECT 1 FROM public.driver_trip_bonus_campaign_progress px
            WHERE px.campaign_id = c.id AND px.driver_id = o.driver_id
          )
        )
    ) AS recovery_required,
    COALESCE(SUM(
      CASE
        WHEN p.credited_at IS NULL
             AND p.completed_count >= COALESCE(p.entitled_trip_target, c.trip_target)
          THEN COALESCE(p.entitled_bonus_amount_pence, c.bonus_amount_pence)
        ELSE 0
      END
    ), 0)::bigint AS expected_liability_pence,
    COALESCE((
      SELECT SUM(l.amount_pence)::bigint
      FROM public.driver_wallet_ledger l
      WHERE l.type = 'BONUS'
        AND l.metadata->>'source' = 'driver_trip_bonus_campaign'
        AND l.metadata->>'campaign_id' = c.id::text
    ), 0)::bigint AS credited_total_pence
  FROM public.driver_trip_bonus_campaigns c
  LEFT JOIN public.driver_trip_bonus_campaign_progress p ON p.campaign_id = c.id
  WHERE p_campaign_id IS NULL OR c.id = p_campaign_id
  GROUP BY c.id, c.title, c.trip_target, c.bonus_amount_pence
  ORDER BY c.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_driver_trip_bonus_campaign_finance_summary(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_driver_trip_bonus_campaign_finance_summary(uuid)
  TO authenticated;

-- Participant rows for Admin status column
CREATE OR REPLACE FUNCTION public.admin_list_driver_trip_bonus_progress(
  p_campaign_id uuid
)
RETURNS TABLE (
  campaign_id uuid,
  driver_id uuid,
  completed_count integer,
  entitled_trip_target integer,
  entitled_bonus_amount_pence integer,
  credited_at timestamptz,
  ledger_entry_id uuid,
  participant_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
       public.is_super_admin(v_uid)
       OR public.staff_has_page_access('driver-trip-bonuses')
     )
  THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    p.campaign_id,
    p.driver_id,
    p.completed_count,
    COALESCE(p.entitled_trip_target, c.trip_target),
    COALESCE(p.entitled_bonus_amount_pence, c.bonus_amount_pence),
    p.credited_at,
    p.ledger_entry_id,
    CASE
      WHEN p.credited_at IS NOT NULL THEN 'credited'
      WHEN p.completed_count >= COALESCE(p.entitled_trip_target, c.trip_target)
        THEN 'qualified_credit_pending'
      WHEN p.completed_count > 0 THEN 'in_progress'
      ELSE 'participating'
    END AS participant_status
  FROM public.driver_trip_bonus_campaign_progress p
  JOIN public.driver_trip_bonus_campaigns c ON c.id = p.campaign_id
  WHERE p.campaign_id = p_campaign_id
  ORDER BY p.updated_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_driver_trip_bonus_progress(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_driver_trip_bonus_progress(uuid)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- Driver credit-notice ack (heads-up after durable credit)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ack_driver_trip_bonus_credit_notice(
  p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
  END IF;
  IF p_campaign_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_campaign_id');
  END IF;

  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = v_uid
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DRIVER_PROFILE_REQUIRED');
  END IF;

  UPDATE public.driver_trip_bonus_campaign_progress
  SET credit_notice_delivered_at = COALESCE(credit_notice_delivered_at, now()),
      updated_at = now()
  WHERE campaign_id = p_campaign_id
    AND driver_id = v_driver_id
    AND credited_at IS NOT NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'notice_unavailable');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.ack_driver_trip_bonus_credit_notice(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ack_driver_trip_bonus_credit_notice(uuid)
  TO authenticated;

COMMIT;
