-- Reject publishing an active trip-bonus campaign whose window + scope can match
-- the same driver as another published+active campaign (Home shows only one card).
-- SSOT mirrors shared/driverTripBonusCampaignSSOT.ts (campaignWindowsOverlap /
-- campaignScopesCanMatchSameDriver / findOverlappingPublishedCampaign).
-- NOT applied by this task — ship with Admin release / explicit migration apply.

BEGIN;

CREATE OR REPLACE FUNCTION public.driver_trip_bonus_campaign_windows_overlap(
  p_starts_a timestamptz,
  p_ends_a timestamptz,
  p_starts_b timestamptz,
  p_ends_b timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    COALESCE(p_starts_a, '-infinity'::timestamptz)
      < COALESCE(p_ends_b, 'infinity'::timestamptz)
    AND COALESCE(p_starts_b, '-infinity'::timestamptz)
      < COALESCE(p_ends_a, 'infinity'::timestamptz);
$$;

CREATE OR REPLACE FUNCTION public.driver_trip_bonus_campaign_scopes_overlap(
  p_scope_a text,
  p_region_a uuid,
  p_areas_a uuid[],
  p_scope_b text,
  p_region_b uuid,
  p_areas_b uuid[]
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO public
AS $$
DECLARE
  v_a text := COALESCE(p_scope_a, '');
  v_b text := COALESCE(p_scope_b, '');
BEGIN
  IF v_a = 'global' OR v_b = 'global' THEN
    RETURN true;
  END IF;

  IF v_a = 'entire_region' AND v_b = 'entire_region' THEN
    RETURN p_region_a IS NOT NULL AND p_region_a = p_region_b;
  END IF;

  IF v_a = 'selected_service_areas' AND v_b = 'selected_service_areas' THEN
    RETURN EXISTS (
      SELECT 1
      FROM unnest(COALESCE(p_areas_a, '{}'::uuid[])) AS a(id)
      JOIN unnest(COALESCE(p_areas_b, '{}'::uuid[])) AS b(id) ON a.id = b.id
    );
  END IF;

  -- Region vs selected SAs: overlap if any selected SA belongs to that region.
  IF v_a = 'entire_region' AND v_b = 'selected_service_areas' THEN
    IF p_region_a IS NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1
      FROM public.service_areas sa
      WHERE sa.id = ANY (COALESCE(p_areas_b, '{}'::uuid[]))
        AND sa.region_id = p_region_a
    );
  END IF;

  IF v_b = 'entire_region' AND v_a = 'selected_service_areas' THEN
    IF p_region_b IS NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1
      FROM public.service_areas sa
      WHERE sa.id = ANY (COALESCE(p_areas_a, '{}'::uuid[]))
        AND sa.region_id = p_region_b
    );
  END IF;

  RETURN false;
END;
$$;

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
  v_status text := COALESCE(NULLIF(p_campaign->>'status', ''), 'draft');
  v_active boolean := COALESCE((p_campaign->>'is_active')::boolean, true);
  v_starts timestamptz := NULLIF(p_campaign->>'starts_at', '')::timestamptz;
  v_ends timestamptz := NULLIF(p_campaign->>'ends_at', '')::timestamptz;
  v_overlap_title text;
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

  -- Home shows one card; block publish of overlapping earnable campaigns.
  IF v_status = 'published' AND v_active = true THEN
    SELECT c.title
      INTO v_overlap_title
    FROM public.driver_trip_bonus_campaigns c
    LEFT JOIN LATERAL (
      SELECT COALESCE(array_agg(sa.service_area_id), '{}'::uuid[]) AS areas
      FROM public.driver_trip_bonus_campaign_service_areas sa
      WHERE sa.campaign_id = c.id
    ) linked ON true
    WHERE c.status = 'published'
      AND c.is_active = true
      AND (v_id IS NULL OR c.id <> v_id)
      AND public.driver_trip_bonus_campaign_windows_overlap(
            v_starts, v_ends, c.starts_at, c.ends_at
          )
      AND public.driver_trip_bonus_campaign_scopes_overlap(
            v_scope,
            v_region,
            COALESCE(p_service_area_ids, '{}'::uuid[]),
            c.scope_type,
            c.region_id,
            linked.areas
          )
    LIMIT 1;

    IF v_overlap_title IS NOT NULL THEN
      RAISE EXCEPTION 'trip_bonus_campaign_overlap:%', v_overlap_title;
    END IF;
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
      v_status,
      v_active,
      v_starts,
      v_ends,
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
      starts_at = v_starts,
      ends_at = v_ends,
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

COMMIT;
