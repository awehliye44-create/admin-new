-- Rollback of 20270222180000: put each negotiation RPC body back under its public name
-- (without the injected trip-first lock) and drop the cores + contention helper.
-- LOCAL / release-candidate only. Rolling back restores the offer->trip lock order.
BEGIN;

DO $rb$
DECLARE
  v_spec text[];
  v_def text;
  v_inject constant text :=
    E'PERFORM 1 FROM public.trips t WHERE t.id = (SELECT o.trip_id FROM public.ride_offers o WHERE o.id = p_offer_id) FOR UPDATE; -- negotiation trip-first lock\n  ';
  v_waiting_check constant text :=
    E'IF v_offer.negotiation_status IS DISTINCT FROM ''waiting_customer'' THEN';
  v_waiting_check_terminal constant text :=
    E'IF v_offer.negotiation_status IS DISTINCT FROM ''waiting_customer''\n     OR v_offer.status IN (''revoked'', ''expired'', ''declined'', ''accepted'') THEN -- terminal offer guard';
  v_trip_assigned constant text :=
    E'\n  IF v_trip.driver_id IS NOT NULL AND v_trip.status IN (\n    ''confirmed'',''accepted'',''driver_assigned'',''en_route'',''en_route_to_pickup'',\n    ''driver_en_route'',''arrived'',''arrived_pickup'',''in_progress'',''completed''\n  ) THEN -- assigned-trip guard\n    RAISE EXCEPTION ''not_waiting_customer'';\n  END IF;\n';
  v_specs constant text[][] := ARRAY[
    ARRAY['customer_counter_ride_offer', 'public.customer_counter_ride_offer_core(uuid,integer,uuid,uuid)'],
    ARRAY['driver_send_preset_offer', 'public.driver_send_preset_offer_core(uuid,integer,integer[],integer)'],
    ARRAY['driver_cancel_negotiation', 'public.driver_cancel_negotiation_core(uuid,uuid)'],
    ARRAY['expire_negotiation_offer', 'public.expire_negotiation_offer_core(uuid)'],
    ARRAY['decline_ride_offer', 'public.decline_ride_offer_core(uuid,uuid,text)'],
    ARRAY['apply_customer_decline_grace', 'public.apply_customer_decline_grace_core(uuid,text)']
  ];
  i integer;
BEGIN
  FOR i IN 1 .. array_length(v_specs, 1) LOOP
    v_spec := ARRAY[v_specs[i][1], v_specs[i][2]];
    IF to_regprocedure(v_spec[2]) IS NULL THEN CONTINUE; END IF;
    SELECT pg_get_functiondef(to_regprocedure(v_spec[2])) INTO v_def;
    v_def := replace(v_def, v_inject, '');
    v_def := replace(v_def, v_waiting_check_terminal, v_waiting_check);
    v_def := replace(v_def, v_trip_assigned, '');
    v_def := replace(v_def, 'FUNCTION public.' || v_spec[1] || '_core(', 'FUNCTION public.' || v_spec[1] || '(');
    EXECUTE v_def;
  END LOOP;
END
$rb$;

DROP FUNCTION IF EXISTS public.customer_counter_ride_offer_core(uuid, integer, uuid, uuid);
DROP FUNCTION IF EXISTS public.driver_send_preset_offer_core(uuid, integer, integer[], integer);
DROP FUNCTION IF EXISTS public.driver_cancel_negotiation_core(uuid, uuid);
DROP FUNCTION IF EXISTS public.expire_negotiation_offer_core(uuid);
DROP FUNCTION IF EXISTS public.decline_ride_offer_core(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.apply_customer_decline_grace_core(uuid, text);
DROP FUNCTION IF EXISTS public.negotiation_contention_outcome(uuid, text);

COMMIT;
