-- Driver trip-bonus campaigns (Admin SA-scoped progress → BONUS wallet credit).
-- Distinct from driver_special_offers content feed. Reuses existing BONUS payout path.

BEGIN;

CREATE TABLE IF NOT EXISTS public.driver_trip_bonus_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  card_headline text NOT NULL,
  card_body text NULL,
  trip_target integer NOT NULL CHECK (trip_target >= 1),
  bonus_amount_pence integer NOT NULL CHECK (bonus_amount_pence >= 1),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  is_active boolean NOT NULL DEFAULT true,
  starts_at timestamptz NULL,
  ends_at timestamptz NULL,
  scope_type text NOT NULL DEFAULT 'selected_service_areas'
    CHECK (scope_type IN ('selected_service_areas', 'entire_region', 'global')),
  region_id uuid NULL REFERENCES public.regions(id) ON DELETE SET NULL,
  display_priority integer NOT NULL DEFAULT 0,
  created_by uuid NULL,
  updated_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_trip_bonus_campaigns_region_scope_chk CHECK (
    (scope_type = 'entire_region' AND region_id IS NOT NULL)
    OR (scope_type = 'global' AND region_id IS NULL)
    OR (scope_type = 'selected_service_areas')
  )
);

CREATE INDEX IF NOT EXISTS driver_trip_bonus_campaigns_live_idx
  ON public.driver_trip_bonus_campaigns (status, is_active, display_priority DESC)
  WHERE status = 'published' AND is_active = true;

CREATE TABLE IF NOT EXISTS public.driver_trip_bonus_campaign_service_areas (
  campaign_id uuid NOT NULL REFERENCES public.driver_trip_bonus_campaigns(id) ON DELETE CASCADE,
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, service_area_id)
);

CREATE INDEX IF NOT EXISTS driver_trip_bonus_campaign_sa_area_idx
  ON public.driver_trip_bonus_campaign_service_areas (service_area_id);

CREATE TABLE IF NOT EXISTS public.driver_trip_bonus_campaign_progress (
  campaign_id uuid NOT NULL REFERENCES public.driver_trip_bonus_campaigns(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  last_trip_id uuid NULL,
  credited_at timestamptz NULL,
  ledger_entry_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, driver_id),
  CONSTRAINT driver_trip_bonus_progress_credit_pair_chk CHECK (
    (credited_at IS NULL AND ledger_entry_id IS NULL)
    OR (credited_at IS NOT NULL AND ledger_entry_id IS NOT NULL)
  )
);

-- One BONUS credit row per campaign+driver (idempotency).
CREATE UNIQUE INDEX IF NOT EXISTS driver_trip_bonus_progress_credited_uidx
  ON public.driver_trip_bonus_campaign_progress (campaign_id, driver_id)
  WHERE credited_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.driver_trip_bonus_campaign_trip_events (
  campaign_id uuid NOT NULL REFERENCES public.driver_trip_bonus_campaigns(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  counted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, trip_id)
);

CREATE INDEX IF NOT EXISTS driver_trip_bonus_trip_events_driver_idx
  ON public.driver_trip_bonus_campaign_trip_events (driver_id, campaign_id);

ALTER TABLE public.driver_trip_bonus_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_trip_bonus_campaign_service_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_trip_bonus_campaign_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_trip_bonus_campaign_trip_events ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_trip_bonus_campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_trip_bonus_campaign_service_areas TO authenticated;
GRANT SELECT ON public.driver_trip_bonus_campaign_progress TO authenticated;
GRANT SELECT ON public.driver_trip_bonus_campaign_trip_events TO authenticated;
GRANT ALL ON public.driver_trip_bonus_campaigns TO service_role;
GRANT ALL ON public.driver_trip_bonus_campaign_service_areas TO service_role;
GRANT ALL ON public.driver_trip_bonus_campaign_progress TO service_role;
GRANT ALL ON public.driver_trip_bonus_campaign_trip_events TO service_role;

DROP POLICY IF EXISTS "Staff manage trip bonus campaigns" ON public.driver_trip_bonus_campaigns;
CREATE POLICY "Staff manage trip bonus campaigns"
  ON public.driver_trip_bonus_campaigns
  FOR ALL TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR public.staff_has_page_access('driver-trip-bonuses')
  )
  WITH CHECK (
    public.is_super_admin(auth.uid())
    OR public.staff_has_page_access('driver-trip-bonuses')
  );

DROP POLICY IF EXISTS "Staff manage trip bonus campaign areas" ON public.driver_trip_bonus_campaign_service_areas;
CREATE POLICY "Staff manage trip bonus campaign areas"
  ON public.driver_trip_bonus_campaign_service_areas
  FOR ALL TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR public.staff_has_page_access('driver-trip-bonuses')
  )
  WITH CHECK (
    public.is_super_admin(auth.uid())
    OR public.staff_has_page_access('driver-trip-bonuses')
  );

DROP POLICY IF EXISTS "Staff read trip bonus progress" ON public.driver_trip_bonus_campaign_progress;
CREATE POLICY "Staff read trip bonus progress"
  ON public.driver_trip_bonus_campaign_progress
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR public.staff_has_page_access('driver-trip-bonuses')
  );

DROP POLICY IF EXISTS "Drivers read own trip bonus progress" ON public.driver_trip_bonus_campaign_progress;
CREATE POLICY "Drivers read own trip bonus progress"
  ON public.driver_trip_bonus_campaign_progress
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.id = driver_id AND d.user_id = auth.uid()
    )
  );

-- Seed page access from roles that already have driver-special-offers (role_id matrix).
INSERT INTO public.role_page_permissions (role_id, page_slug, can_access)
SELECT rpp.role_id, 'driver-trip-bonuses', true
FROM public.role_page_permissions rpp
WHERE rpp.page_slug = 'driver-special-offers'
  AND rpp.can_access = true
  AND rpp.role_id IS NOT NULL
ON CONFLICT (role_id, page_slug) DO NOTHING;

-- Also seed legacy role column if still present and used.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'role_page_permissions'
      AND column_name = 'role'
  ) THEN
    INSERT INTO public.role_page_permissions (role, page_slug, can_access)
    SELECT rpp.role, 'driver-trip-bonuses', true
    FROM public.role_page_permissions rpp
    WHERE rpp.page_slug = 'driver-special-offers'
      AND rpp.can_access = true
      AND rpp.role IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'legacy role_page_permissions seed skipped: %', SQLERRM;
END $$;

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
      NULLIF(p_campaign->>'starts_at', '')::timestamptz,
      NULLIF(p_campaign->>'ends_at', '')::timestamptz,
      v_scope,
      v_region,
      COALESCE((p_campaign->>'display_priority')::integer, 0),
      v_uid,
      v_uid
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.driver_trip_bonus_campaigns SET
      title = NULLIF(btrim(p_campaign->>'title'), ''),
      card_headline = NULLIF(btrim(p_campaign->>'card_headline'), ''),
      card_body = NULLIF(btrim(p_campaign->>'card_body'), ''),
      trip_target = v_target,
      bonus_amount_pence = v_bonus,
      status = COALESCE(NULLIF(p_campaign->>'status', ''), status),
      is_active = COALESCE((p_campaign->>'is_active')::boolean, is_active),
      starts_at = NULLIF(p_campaign->>'starts_at', '')::timestamptz,
      ends_at = NULLIF(p_campaign->>'ends_at', '')::timestamptz,
      scope_type = v_scope,
      region_id = v_region,
      display_priority = COALESCE((p_campaign->>'display_priority')::integer, display_priority),
      updated_by = v_uid,
      updated_at = now()
    WHERE id = v_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND';
    END IF;
  END IF;

  DELETE FROM public.driver_trip_bonus_campaign_service_areas WHERE campaign_id = v_id;

  IF v_scope = 'selected_service_areas' THEN
    INSERT INTO public.driver_trip_bonus_campaign_service_areas (campaign_id, service_area_id)
    SELECT v_id, sa FROM unnest(p_service_area_ids) AS sa
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_save_driver_trip_bonus_campaign(jsonb, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_driver_trip_bonus_campaign(jsonb, uuid[]) TO authenticated;

-- Atomic progress + optional BONUS credit for one completed trip.
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
  v_desc text;
  v_results jsonb := '[]'::jsonb;
  v_now timestamptz := COALESCE(p_completed_at, now());
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_ids');
  END IF;

  -- Only count completed trips.
  IF NOT EXISTS (
    SELECT 1 FROM public.trips t
    WHERE t.id = p_trip_id
      AND lower(t.status::text) = 'completed'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'trip_not_completed');
  END IF;

  FOR r IN
    SELECT c.*
    FROM public.driver_trip_bonus_campaigns c
    WHERE c.status = 'published'
      AND c.is_active = true
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
    -- Already credited: do not count further trips.
    IF EXISTS (
      SELECT 1 FROM public.driver_trip_bonus_campaign_progress p
      WHERE p.campaign_id = r.id
        AND p.driver_id = p_driver_id
        AND p.credited_at IS NOT NULL
    ) THEN
      CONTINUE;
    END IF;

    -- Idempotent per campaign+trip.
    INSERT INTO public.driver_trip_bonus_campaign_trip_events (campaign_id, driver_id, trip_id)
    VALUES (r.id, p_driver_id, p_trip_id)
    ON CONFLICT DO NOTHING;

    IF NOT FOUND THEN
      -- Already counted this trip for this campaign.
      CONTINUE;
    END IF;

    INSERT INTO public.driver_trip_bonus_campaign_progress (
      campaign_id, driver_id, completed_count, last_trip_id, updated_at
    )
    VALUES (r.id, p_driver_id, 1, p_trip_id, now())
    ON CONFLICT (campaign_id, driver_id) DO UPDATE
      SET completed_count = public.driver_trip_bonus_campaign_progress.completed_count + 1,
          last_trip_id = EXCLUDED.last_trip_id,
          updated_at = now()
      WHERE public.driver_trip_bonus_campaign_progress.credited_at IS NULL
    RETURNING completed_count, (credited_at IS NOT NULL) INTO v_count, v_credited;

    IF v_count IS NULL THEN
      -- Already credited; progress frozen.
      SELECT completed_count, credited_at IS NOT NULL
        INTO v_count, v_credited
      FROM public.driver_trip_bonus_campaign_progress
      WHERE campaign_id = r.id AND driver_id = p_driver_id;
    END IF;

    IF COALESCE(v_credited, false) = false
       AND COALESCE(v_count, 0) >= r.trip_target
       AND r.bonus_amount_pence > 0
    THEN
      -- Serialize credit claim for this campaign+driver (no double BONUS).
      PERFORM 1
      FROM public.driver_trip_bonus_campaign_progress
      WHERE campaign_id = r.id
        AND driver_id = p_driver_id
      FOR UPDATE;

      SELECT credited_at IS NOT NULL
        INTO v_credited
      FROM public.driver_trip_bonus_campaign_progress
      WHERE campaign_id = r.id AND driver_id = p_driver_id;

      IF COALESCE(v_credited, false) = false THEN
        v_desc := left('Trip bonus: ' || coalesce(nullif(btrim(r.title), ''), 'Trip bonus'), 240);

        INSERT INTO public.driver_wallet_ledger (
          driver_id, type, amount_pence, currency, description, related_trip_id, metadata
        )
        VALUES (
          p_driver_id,
          'BONUS',
          r.bonus_amount_pence,
          'GBP',
          v_desc,
          p_trip_id,
          jsonb_build_object(
            'campaign_id', r.id,
            'description', v_desc,
            'source', 'driver_trip_bonus_campaign'
          )
        )
        RETURNING id INTO v_ledger_id;

        UPDATE public.driver_trip_bonus_campaign_progress
        SET credited_at = now(),
            ledger_entry_id = v_ledger_id,
            updated_at = now()
        WHERE campaign_id = r.id
          AND driver_id = p_driver_id
          AND credited_at IS NULL;

        IF FOUND THEN
          v_credited := true;
        ELSE
          -- Lost race after lock edge-case; do not leave unclaimed ledger.
          RAISE EXCEPTION 'trip_bonus_credit_claim_failed';
        END IF;
      END IF;
    END IF;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'campaign_id', r.id,
      'completed_count', v_count,
      'trip_target', r.trip_target,
      'credited', COALESCE(v_credited, false),
      'ledger_entry_id', v_ledger_id
    ));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'campaigns', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.record_driver_trip_bonus_progress(uuid, uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_driver_trip_bonus_progress(uuid, uuid, uuid, uuid, timestamptz)
  TO service_role;

COMMIT;
