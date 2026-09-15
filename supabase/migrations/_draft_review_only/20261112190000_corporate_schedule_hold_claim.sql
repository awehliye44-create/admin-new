-- DRAFT REVIEW ONLY — NOT APPLIED until Ahmed approves.
-- Former invalid filename 20260915120000 REJECTED (collides with accept_stacked_ride on main + live schema_migrations).
-- Assigned unused version 20261112190000 after live max 20261112170000 + A4 candidate 20261112180000.
-- DRAFT REVIEW ONLY — NOT APPLIED / NOT in schema_migrations until Ahmed approves.
-- Atomic corporate schedule hold: advisory lock per org + hold row + overlap recheck.
-- Rollback companion: rollback_20261112190000_corporate_schedule_hold_claim.sql

CREATE TABLE IF NOT EXISTS public.corporate_schedule_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL REFERENCES public.corporate_accounts(id),
  client_action_id text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'released', 'consumed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_action_id)
);

CREATE INDEX IF NOT EXISTS corporate_schedule_holds_org_window_idx
  ON public.corporate_schedule_holds (corporate_account_id, window_start, window_end)
  WHERE status = 'held';

CREATE OR REPLACE FUNCTION public.claim_corporate_schedule_hold(
  p_corporate_account_id uuid,
  p_client_action_id text,
  p_scheduled_at timestamptz,
  p_duration_minutes integer DEFAULT 30,
  p_buffer_minutes integer DEFAULT 15
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.corporate_schedule_holds%ROWTYPE;
  v_start timestamptz;
  v_end timestamptz;
  v_conflict_trip uuid;
  v_conflict_hold text;
  v_k1 int;
  v_k2 int;
BEGIN
  IF p_corporate_account_id IS NULL OR p_client_action_id IS NULL OR p_scheduled_at IS NULL THEN
    RAISE EXCEPTION 'claim_corporate_schedule_hold: missing args';
  END IF;

  -- Org-scoped advisory lock (transaction-scoped via xact when called in txn;
  -- session lock here serialises Edge concurrent callers for this org).
  v_k1 := hashtext(p_corporate_account_id::text);
  v_k2 := 12648430; -- fixed namespace for corporate schedule
  PERFORM pg_advisory_lock(v_k1, v_k2);

  BEGIN
    SELECT * INTO v_existing
    FROM public.corporate_schedule_holds
    WHERE client_action_id = p_client_action_id;

    IF FOUND AND v_existing.status = 'held' THEN
      PERFORM pg_advisory_unlock(v_k1, v_k2);
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'hold_id', v_existing.id,
        'client_action_id', p_client_action_id
      );
    END IF;

    v_start := p_scheduled_at - make_interval(mins => GREATEST(p_buffer_minutes, 0));
    v_end := p_scheduled_at
      + make_interval(mins => GREATEST(COALESCE(p_duration_minutes, 30), 1))
      + make_interval(mins => GREATEST(p_buffer_minutes, 0));

    -- Overlap vs active trips
    SELECT t.id INTO v_conflict_trip
    FROM public.trips t
    WHERE t.corporate_account_id = p_corporate_account_id
      AND t.scheduled_at IS NOT NULL
      AND lower(coalesce(t.status, '')) NOT IN (
        'cancelled', 'canceled', 'completed', 'no_show', 'failed', 'discarded'
      )
      AND tstzrange(
            t.scheduled_at - make_interval(mins => GREATEST(p_buffer_minutes, 0)),
            t.scheduled_at
              + make_interval(mins => GREATEST(COALESCE(t.estimated_duration_minutes, 30), 1))
              + make_interval(mins => GREATEST(p_buffer_minutes, 0)),
            '[)'
          )
          && tstzrange(v_start, v_end, '[)')
    LIMIT 1;

    IF v_conflict_trip IS NOT NULL THEN
      PERFORM pg_advisory_unlock(v_k1, v_k2);
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'SCHEDULE_OVERLAP',
        'conflicting_trip_id', v_conflict_trip
      );
    END IF;

    -- Overlap vs other holds
    SELECT h.client_action_id INTO v_conflict_hold
    FROM public.corporate_schedule_holds h
    WHERE h.corporate_account_id = p_corporate_account_id
      AND h.status = 'held'
      AND h.client_action_id <> p_client_action_id
      AND tstzrange(h.window_start, h.window_end, '[)') && tstzrange(v_start, v_end, '[)')
    LIMIT 1;

    IF v_conflict_hold IS NOT NULL THEN
      PERFORM pg_advisory_unlock(v_k1, v_k2);
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'SCHEDULE_OVERLAP',
        'conflicting_client_action_id', v_conflict_hold
      );
    END IF;

    INSERT INTO public.corporate_schedule_holds (
      corporate_account_id, client_action_id, window_start, window_end, status
    ) VALUES (
      p_corporate_account_id, p_client_action_id, v_start, v_end, 'held'
    )
    ON CONFLICT (client_action_id) DO UPDATE
      SET status = 'held',
          window_start = EXCLUDED.window_start,
          window_end = EXCLUDED.window_end
    RETURNING * INTO v_existing;

    PERFORM pg_advisory_unlock(v_k1, v_k2);
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', false,
      'hold_id', v_existing.id,
      'client_action_id', p_client_action_id
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(v_k1, v_k2);
    RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_corporate_schedule_hold(uuid, text, timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_corporate_schedule_hold(uuid, text, timestamptz, integer, integer) TO service_role;
