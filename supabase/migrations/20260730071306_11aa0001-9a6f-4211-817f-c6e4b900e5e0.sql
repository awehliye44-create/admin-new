
CREATE OR REPLACE FUNCTION public.admin_save_driver_special_offer(
  p_offer jsonb,
  p_service_area_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := NULLIF(p_offer->>'id','')::uuid;
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'admin')) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SET CONSTRAINTS ALL DEFERRED;

  IF v_id IS NULL THEN
    INSERT INTO public.driver_special_offers (
      category_id, title, partner_name, short_description, full_details, badge_label,
      website_url, phone_number, email_address, promo_code, internal_route,
      banner_headline, banner_button_label, status, is_active, is_featured,
      show_in_home_banner, show_in_offer_list, starts_at, ends_at,
      minimum_completed_trips, new_drivers_only, eligible_driver_tiers, display_order,
      scope_type, region_id, created_by, updated_by
    )
    SELECT
      NULLIF(p_offer->>'category_id','')::uuid,
      p_offer->>'title',
      NULLIF(p_offer->>'partner_name',''),
      p_offer->>'short_description',
      NULLIF(p_offer->>'full_details',''),
      NULLIF(p_offer->>'badge_label',''),
      NULLIF(p_offer->>'website_url',''),
      NULLIF(p_offer->>'phone_number',''),
      NULLIF(p_offer->>'email_address',''),
      NULLIF(p_offer->>'promo_code',''),
      NULLIF(p_offer->>'internal_route',''),
      NULLIF(p_offer->>'banner_headline',''),
      NULLIF(p_offer->>'banner_button_label',''),
      COALESCE(p_offer->>'status','draft'),
      COALESCE((p_offer->>'is_active')::boolean, true),
      COALESCE((p_offer->>'is_featured')::boolean, false),
      COALESCE((p_offer->>'show_in_home_banner')::boolean, false),
      COALESCE((p_offer->>'show_in_offer_list')::boolean, true),
      NULLIF(p_offer->>'starts_at','')::timestamptz,
      NULLIF(p_offer->>'ends_at','')::timestamptz,
      NULLIF(p_offer->>'minimum_completed_trips','')::integer,
      COALESCE((p_offer->>'new_drivers_only')::boolean, false),
      CASE WHEN p_offer->'eligible_driver_tiers' IS NULL
             OR jsonb_typeof(p_offer->'eligible_driver_tiers') = 'null'
        THEN NULL
        ELSE ARRAY(SELECT jsonb_array_elements_text(p_offer->'eligible_driver_tiers'))
      END,
      COALESCE((p_offer->>'display_order')::integer, 0),
      COALESCE(p_offer->>'scope_type','selected_service_areas'),
      NULLIF(p_offer->>'region_id','')::uuid,
      v_uid, v_uid
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.driver_special_offers SET
      category_id = NULLIF(p_offer->>'category_id','')::uuid,
      title = p_offer->>'title',
      partner_name = NULLIF(p_offer->>'partner_name',''),
      short_description = p_offer->>'short_description',
      full_details = NULLIF(p_offer->>'full_details',''),
      badge_label = NULLIF(p_offer->>'badge_label',''),
      website_url = NULLIF(p_offer->>'website_url',''),
      phone_number = NULLIF(p_offer->>'phone_number',''),
      email_address = NULLIF(p_offer->>'email_address',''),
      promo_code = NULLIF(p_offer->>'promo_code',''),
      internal_route = NULLIF(p_offer->>'internal_route',''),
      banner_headline = NULLIF(p_offer->>'banner_headline',''),
      banner_button_label = NULLIF(p_offer->>'banner_button_label',''),
      status = COALESCE(p_offer->>'status', status),
      is_active = COALESCE((p_offer->>'is_active')::boolean, is_active),
      is_featured = COALESCE((p_offer->>'is_featured')::boolean, is_featured),
      show_in_home_banner = COALESCE((p_offer->>'show_in_home_banner')::boolean, show_in_home_banner),
      show_in_offer_list = COALESCE((p_offer->>'show_in_offer_list')::boolean, show_in_offer_list),
      starts_at = NULLIF(p_offer->>'starts_at','')::timestamptz,
      ends_at = NULLIF(p_offer->>'ends_at','')::timestamptz,
      minimum_completed_trips = NULLIF(p_offer->>'minimum_completed_trips','')::integer,
      new_drivers_only = COALESCE((p_offer->>'new_drivers_only')::boolean, new_drivers_only),
      eligible_driver_tiers = CASE WHEN p_offer->'eligible_driver_tiers' IS NULL
             OR jsonb_typeof(p_offer->'eligible_driver_tiers') = 'null'
        THEN NULL
        ELSE ARRAY(SELECT jsonb_array_elements_text(p_offer->'eligible_driver_tiers'))
      END,
      display_order = COALESCE((p_offer->>'display_order')::integer, display_order),
      scope_type = COALESCE(p_offer->>'scope_type', scope_type),
      region_id = NULLIF(p_offer->>'region_id','')::uuid,
      updated_by = v_uid,
      updated_at = now()
    WHERE id = v_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'OFFER_NOT_FOUND';
    END IF;
  END IF;

  DELETE FROM public.driver_special_offer_service_areas WHERE offer_id = v_id;

  IF COALESCE(p_offer->>'scope_type','selected_service_areas') = 'selected_service_areas'
     AND array_length(p_service_area_ids, 1) IS NOT NULL THEN
    INSERT INTO public.driver_special_offer_service_areas (offer_id, service_area_id)
    SELECT v_id, sa FROM unnest(p_service_area_ids) AS sa
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_save_driver_special_offer(jsonb, uuid[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_driver_special_offer(jsonb, uuid[]) TO authenticated;
