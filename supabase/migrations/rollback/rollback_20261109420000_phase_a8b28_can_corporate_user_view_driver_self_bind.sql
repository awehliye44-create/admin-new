commit 57bbab2bd5f7c6b3460af8f87e83c320bfeb4d28
Author: awehliye44-create <awehliye44@gmail.com>
Date:   Mon Sep 14 22:06:04 2026 +0100

    WIP rescue: admin migrations and rollbacks

diff --git a/supabase/migrations/20261108180000_driver_snapshot_financial_model_passthrough.sql b/supabase/migrations/20261108180000_driver_snapshot_financial_model_passthrough.sql
new file mode 100644
index 00000000..5b0e2594
--- /dev/null
+++ b/supabase/migrations/20261108180000_driver_snapshot_financial_model_passthrough.sql
@@ -0,0 +1,331 @@
+-- Passthrough only: expose stamped trips.financial_model on driver snapshots.
+-- Does not derive, rewrite, or fall back the financial model.
+-- Driver active-trip fare indicator uses this stamp as SSOT.
+
+CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot()
+ RETURNS jsonb
+ LANGUAGE plpgsql
+ SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+DECLARE
+  v_driver_id uuid;
+  v_trip record;
+  v_queued jsonb;
+  v_server_now timestamptz := now();
+  v_no_show_wait_min numeric := 4;
+  v_no_show_apply_after_arrival boolean := true;
+  v_arrived_at timestamptz;
+  v_status text;
+  v_eligible_at timestamptz;
+  v_remaining_seconds integer := 0;
+  v_can_mark boolean := false;
+  v_actions jsonb := '[]'::jsonb;
+  v_active jsonb;
+  v_passenger_id uuid;
+  v_passenger_first_name text;
+  v_passenger_last_name text;
+  v_passenger_rating numeric;
+  v_passenger_trip_count integer;
+  v_stops jsonb := '[]'::jsonb;
+BEGIN
+  SELECT d.id INTO v_driver_id
+  FROM public.drivers d
+  WHERE d.user_id = auth.uid()
+  LIMIT 1;
+
+  IF v_driver_id IS NULL THEN
+    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0001';
+  END IF;
+
+  SELECT t.*
+  INTO v_trip
+  FROM public.trips t
+  WHERE (t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)
+    AND t.status IS DISTINCT FROM 'queued'
+    AND t.status NOT IN (
+      'completed', 'cancelled', 'canceled', 'customer_cancelled',
+      'driver_cancelled', 'no_show', 'expired', 'declined', 'failed'
+    )
+  ORDER BY t.updated_at DESC NULLS LAST
+  LIMIT 1;
+
+  IF FOUND THEN
+    v_status := lower(coalesce(v_trip.status, ''));
+    v_arrived_at := coalesce(v_trip.pickup_arrived_at, v_trip.arrived_at);
+
+    SELECT
+      COALESCE(fps.no_show_wait_time_minutes, 4),
+      COALESCE(fps.no_show_apply_after_arrival_only, true)
+    INTO v_no_show_wait_min, v_no_show_apply_after_arrival
+    FROM public.fare_pricing_settings fps
+    WHERE fps.service_area_id = v_trip.service_area_id
+      AND (v_trip.vehicle_type_id IS NULL OR fps.vehicle_type_id = v_trip.vehicle_type_id)
+    ORDER BY fps.vehicle_type_id NULLS LAST
+    LIMIT 1;
+
+    IF v_arrived_at IS NOT NULL
+       AND v_trip.started_at IS NULL
+       AND v_status IN (
+         'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup',
+         'pickup_waiting', 'waiting', 'driver_arrived', 'waiting_at_pickup'
+       )
+    THEN
+      v_eligible_at := v_arrived_at
+        + make_interval(mins => GREATEST(0, ceil(v_no_show_wait_min)::int));
+      v_remaining_seconds := GREATEST(
+        0,
+        floor(extract(epoch from (v_eligible_at - v_server_now)))::int
+      );
+      v_can_mark := (v_server_now >= v_eligible_at)
+        AND (NOT v_no_show_apply_after_arrival OR v_arrived_at IS NOT NULL);
+    END IF;
+
+    IF v_status IN (
+      'accepted', 'confirmed', 'driver_assigned', 'en_route', 'en_route_to_pickup',
+      'driver_en_route', 'enroute_to_pickup', 'driver_arriving'
+    ) THEN
+      v_actions := '["arrive_pickup","driver_cancel"]'::jsonb;
+    ELSIF v_status IN (
+      'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup',
+      'pickup_waiting', 'waiting', 'driver_arrived', 'waiting_at_pickup'
+    ) THEN
+      v_actions := jsonb_strip_nulls(jsonb_build_array(
+        'start_trip',
+        'driver_cancel',
+        CASE WHEN v_can_mark THEN 'passenger_no_show' ELSE NULL END
+      ));
+    ELSIF v_status IN ('in_progress', 'started', 'on_trip', 'ongoing') THEN
+      v_actions := '["arrive_stop","next_stop","complete_trip","driver_cancel"]'::jsonb;
+    ELSE
+      v_actions := '[]'::jsonb;
+    END IF;
+
+    v_passenger_id := v_trip.passenger_id;
+    v_passenger_first_name := NULL;
+    v_passenger_last_name := NULL;
+    v_passenger_rating := NULL;
+    v_passenger_trip_count := NULL;
+
+    IF v_passenger_id IS NOT NULL THEN
+      SELECT
+        NULLIF(btrim(c.first_name), ''),
+        NULLIF(btrim(c.last_name), '')
+      INTO v_passenger_first_name, v_passenger_last_name
+      FROM public.customers c
+      WHERE c.id = v_passenger_id;
+
+      SELECT s.avg_rating, s.total_trips
+      INTO v_passenger_rating, v_passenger_trip_count
+      FROM public.get_customer_trip_stats(v_passenger_id) s;
+    END IF;
+
+    SELECT COALESCE(
+      jsonb_agg(
+        jsonb_build_object(
+          'id', ts.id,
+          'trip_id', ts.trip_id,
+          'stop_index', ts.stop_index,
+          'type', ts.type,
+          'address', ts.address,
+          'lat', ts.lat,
+          'lng', ts.lng,
+          'latitude', ts.lat,
+          'longitude', ts.lng,
+          'status', ts.status,
+          'arrived_at', ts.arrived_at,
+          'completed_at', ts.completed_at,
+          'waiting_charge_active', ts.waiting_charge_active,
+          'waiting_started_at', ts.waiting_started_at,
+          'waiting_stopped_at', ts.waiting_stopped_at
+        )
+        ORDER BY ts.stop_index
+      ),
+      '[]'::jsonb
+    )
+    INTO v_stops
+    FROM public.trip_stops ts
+    WHERE ts.trip_id = v_trip.id;
+
+    v_active := jsonb_build_object(
+      'id', v_trip.id,
+      'trip_id', v_trip.id,
+      'public_trip_id', COALESCE(NULLIF(trim(v_trip.trip_number::text), ''), substring(v_trip.id::text, 1, 8)),
+      'status', v_trip.status,
+      'dispatch_status', v_trip.dispatch_status,
+      'trip_version', v_trip.trip_version,
+      'pricing_version', v_trip.pricing_version,
+      'fare_revision_number', v_trip.fare_revision_number,
+      'driver_id', v_trip.driver_id,
+      'confirmed_driver_id', v_trip.confirmed_driver_id,
+      'passenger_id', v_passenger_id,
+      'passenger_first_name', v_passenger_first_name,
+      'passenger_last_name', v_passenger_last_name,
+      'passenger_name', NULLIF(btrim(COALESCE(v_trip.passenger_name, '')), ''),
+      'passenger_rating', v_passenger_rating,
+      'passenger_trip_count', v_passenger_trip_count,
+      'arrived_at', v_trip.arrived_at,
+      'pickup_arrived_at', v_trip.pickup_arrived_at,
+      'started_at', v_trip.started_at,
+      'completed_at', v_trip.completed_at,
+      'current_stop_index', v_trip.current_stop_index,
+      'pickup_waiting_started_at', v_trip.pickup_waiting_started_at,
+      'pickup_paid_waiting_started_at', v_trip.pickup_paid_waiting_started_at,
+      'free_wait_expires_at', v_trip.free_wait_expires_at,
+      'pickup_waiting_admin_config', v_trip.pickup_waiting_admin_config,
+      'admin_waiting_config_snapshot', v_trip.pickup_waiting_admin_config,
+      'pickup_waiting_charge_pence', v_trip.pickup_waiting_charge_pence,
+      'pickup_waiting_finalized_at', v_trip.pickup_waiting_finalized_at,
+      'pickup_waiting_intervals_charged', v_trip.pickup_waiting_intervals_charged,
+      'pickup_waiting_chargeable_seconds', v_trip.pickup_waiting_chargeable_seconds,
+      'pickup_waiting_last_tick_at', v_trip.pickup_waiting_last_tick_at,
+      'waiting_charge_pence', v_trip.waiting_charge_pence,
+      'total_waiting_charge_pence', v_trip.total_waiting_charge_pence,
+      'stop_waiting_charge_pence', v_trip.stop_waiting_charge_pence,
+      'stop_charge_total_pence', v_trip.stop_charge_total_pence,
+      'locked_base_fare_pence', v_trip.locked_base_fare_pence,
+      'final_fare_pence', v_trip.final_fare_pence,
+      'final_customer_fare_pence', v_trip.final_customer_fare_pence,
+      'grace_period_expired_at', v_trip.grace_period_expired_at,
+      'service_area_id', v_trip.service_area_id,
+      'vehicle_type_id', v_trip.vehicle_type_id,
+      'pickup_address', left(COALESCE(v_trip.pickup_address::text, ''), 160),
+      'dropoff_address', left(COALESCE(v_trip.dropoff_address::text, ''), 160),
+      'pickup_latitude', v_trip.pickup_latitude
+    ) || jsonb_build_object(
+      'pickup_longitude', v_trip.pickup_longitude,
+      'dropoff_latitude', v_trip.dropoff_latitude,
+      'dropoff_longitude', v_trip.dropoff_longitude,
+      'payment_method', v_trip.payment_method,
+      'financial_model', v_trip.financial_model,
+      'payment_status', v_trip.payment_status,
+      'driver_net_pence', COALESCE(
+        NULLIF(v_trip.driver_net_pence, 0),
+        NULLIF(v_trip.driver_net_before_tip_pence, 0),
+        NULLIF(v_trip.accepted_driver_offer_fare_pence, 0)
+      ),
+      'currency_code', COALESCE(v_trip.currency_code, v_trip.offer_currency, 'GBP'),
+      'stack_position', v_trip.stack_position,
+      'is_queued', (v_trip.status = 'queued'),
+      'customer_live_location_allowed', (
+        v_status IN (
+          'accepted', 'confirmed', 'en_route', 'en_route_to_pickup',
+          'driver_en_route', 'driver_arriving', 'arrived', 'arrived_at_pickup',
+          'at_pickup', 'pickup_waiting', 'waiting', 'driver_arrived'
+        )
+      ),
+      'can_mark_no_show', v_can_mark,
+      'no_show_eligible', v_can_mark,
+      'no_show_eligible_at', v_eligible_at,
+      'no_show_remaining_seconds', v_remaining_seconds,
+      'permitted_actions', v_actions,
+      'trip_stops', v_stops,
+      'stops', v_stops
+    ) || jsonb_build_object(
+      -- Accepted-offer financial SSOT (MK-260817-008). Passthrough only.
+      -- Never substitute final_fare_pence / customer fare.
+      'accepted_ride_offer_id', v_trip.accepted_ride_offer_id,
+      'accepted_commission_percent', v_trip.accepted_commission_percent,
+      'accepted_dispatch_wave', v_trip.accepted_dispatch_wave,
+      'accepted_dispatch_round', v_trip.accepted_dispatch_round
+    );
+  ELSE
+    v_active := NULL;
+  END IF;
+
+  SELECT COALESCE(public.get_driver_queued_trips(), '[]'::jsonb)
+  INTO v_queued;
+
+  RETURN jsonb_build_object(
+    'server_now', v_server_now,
+    'driver_id', v_driver_id,
+    'active_trip', v_active,
+    'queued_trips', v_queued
+  );
+END;
+$function$;
+
+CREATE OR REPLACE FUNCTION public.get_driver_queued_trips()
+ RETURNS jsonb
+ LANGUAGE plpgsql
+ SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+DECLARE
+  v_driver_id uuid;
+  v_can_cancel boolean := true;
+BEGIN
+  SELECT d.id INTO v_driver_id
+  FROM public.drivers d
+  WHERE d.user_id = auth.uid()
+  LIMIT 1;
+
+  IF v_driver_id IS NULL THEN
+    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0001';
+  END IF;
+
+  -- Driver cancellation of queued stacked trips is allowed via stop-workflow
+  -- cancel_queued_stacked (existing). Expose can_cancel for UI gating.
+  v_can_cancel := true;
+
+  RETURN COALESCE(
+    (
+      SELECT jsonb_agg(row_to_json(q)::jsonb ORDER BY q.queue_position, q.sort_at)
+      FROM (
+        SELECT
+          t.id AS trip_id,
+          t.id AS queue_entry_id,
+          COALESCE(NULLIF(trim(t.trip_number::text), ''), substring(t.id::text, 1, 8)) AS public_trip_id,
+          COALESCE(t.stack_position, 1) AS queue_position,
+          t.status AS status,
+          COALESCE(
+            NULLIF(t.driver_net_pence, 0),
+            NULLIF(t.driver_net_before_tip_pence, 0),
+            NULLIF(t.accepted_driver_offer_fare_pence, 0)
+          ) AS driver_net_pence,
+          t.accepted_ride_offer_id AS accepted_ride_offer_id,
+          t.accepted_commission_percent AS accepted_commission_percent,
+          t.accepted_dispatch_wave AS accepted_dispatch_wave,
+          t.accepted_dispatch_round AS accepted_dispatch_round,
+          COALESCE(t.currency_code, t.offer_currency, 'GBP') AS currency_code,
+          t.vehicle_type AS service_type,
+          t.scheduled_at AS scheduled_pickup_at,
+          left(COALESCE(NULLIF(btrim(t.pickup_address::text), ''), 'Pickup'), 160) AS pickup_summary,
+          left(COALESCE(NULLIF(btrim(t.dropoff_address::text), ''), 'Drop-off'), 160) AS dropoff_summary,
+          (COALESCE(t.total_stops, 0) > 2) AS has_multiple_stops,
+          CASE
+            WHEN lower(coalesce(t.payment_method, t.payment_type, '')) LIKE '%card%'
+              OR lower(coalesce(t.payment_method, '')) IN ('card','revolut','apple_pay','google_pay','saved_card')
+              THEN 'card'
+            WHEN lower(coalesce(t.payment_method, t.payment_type, '')) LIKE '%cash%'
+              THEN 'cash'
+            ELSE 'unknown'
+          END AS payment_method,
+          t.financial_model AS financial_model,
+          t.created_at AS assigned_at,
+          t.created_at AS sort_at,
+          v_can_cancel AS can_cancel,
+          CASE
+            WHEN v_can_cancel THEN 'Queued trip will be released for rematch. Your active trip is unchanged.'
+            ELSE NULL
+          END AS cancellation_consequence,
+          t.pickup_latitude AS pickup_lat,
+          t.pickup_longitude AS pickup_lng,
+          t.dropoff_latitude AS dropoff_lat,
+          t.dropoff_longitude AS dropoff_lng
+        FROM public.trips t
+        WHERE t.status = 'queued'
+          AND (t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)
+        ORDER BY t.stack_position ASC NULLS LAST,
+                 t.created_at ASC
+      ) q
+    ),
+    '[]'::jsonb
+  );
+END;
+$function$;
+
+REVOKE EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot() FROM PUBLIC, anon;
+GRANT EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot() TO authenticated, service_role;
+REVOKE EXECUTE ON FUNCTION public.get_driver_queued_trips() FROM PUBLIC, anon;
+GRANT EXECUTE ON FUNCTION public.get_driver_queued_trips() TO authenticated, service_role;
diff --git a/supabase/migrations/20261108190000_scheduled_jobs_financial_model_passthrough.sql b/supabase/migrations/20261108190000_scheduled_jobs_financial_model_passthrough.sql
new file mode 100644
index 00000000..4a0ad637
--- /dev/null
+++ b/supabase/migrations/20261108190000_scheduled_jobs_financial_model_passthrough.sql
@@ -0,0 +1,203 @@
+-- Passthrough only: expose stamped trips.financial_model on the driver scheduled-jobs list.
+-- Does not derive the model from payment_method.
+
+CREATE OR REPLACE FUNCTION public.list_driver_own_scheduled_jobs(p_tab text DEFAULT 'requested'::text)
+ RETURNS jsonb
+ LANGUAGE plpgsql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+DECLARE
+  v_driver_id uuid := public.current_driver_id();
+  v_tab text := lower(COALESCE(p_tab, 'requested'));
+  v_check_in_lead integer := 90;
+  v_check_in_grace integer := 15;
+  v_early_arrival integer := 10;
+  v_safety integer := 5;
+  v_access integer := 0;
+  v_start_grace integer := 5;
+BEGIN
+  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
+    RETURN '[]'::jsonb;
+  END IF;
+
+  SELECT
+    COALESCE(g.check_in_min_lead_minutes, 90),
+    COALESCE(g.check_in_grace_minutes, 15),
+    COALESCE(g.early_arrival_buffer_minutes, 10),
+    COALESCE(g.safety_buffer_minutes, 5),
+    COALESCE(g.pickup_access_allowance_minutes, 0),
+    COALESCE(g.start_journey_grace_minutes, 5)
+  INTO
+    v_check_in_lead,
+    v_check_in_grace,
+    v_early_arrival,
+    v_safety,
+    v_access,
+    v_start_grace
+  FROM public.global_dispatch_settings g
+  WHERE g.singleton = true
+  LIMIT 1;
+
+  IF v_tab = 'confirmed' THEN
+    RETURN COALESCE(
+      (
+        SELECT jsonb_agg(to_jsonb(row) ORDER BY row.scheduled_at ASC)
+        FROM (
+          SELECT
+            t.id,
+            t.scheduled_at,
+            t.vehicle_type,
+            t.trip_type,
+            t.job_type,
+            t.payment_method,
+            t.financial_model AS financial_model,
+            t.estimated_duration_minutes,
+            COALESCE(t.driver_net_pence, round(COALESCE(t.estimated_fare, t.fare, 0) * 100)::bigint) AS estimated_fare_pence,
+            COALESCE(t.currency_code, t.currency, 'GBP') AS currency_code,
+            t.pickup_address,
+            t.pickup_latitude,
+            t.pickup_longitude,
+            t.dropoff_address,
+            t.dropoff_latitude,
+            t.dropoff_longitude,
+            t.stops,
+            COALESCE(t.total_stops, 1) AS total_stops,
+            t.special_instructions,
+            t.scheduled_status,
+            t.status,
+            sa.name AS service_area_label,
+            t.driver_checked_in_at,
+            (
+              t.scheduled_at
+              - make_interval(mins => GREATEST(v_early_arrival + v_safety + v_access, 1))
+            ) AS leave_by_at,
+            CASE
+              WHEN t.driver_checked_in_at IS NULL
+                AND now() < (t.scheduled_at - make_interval(mins => v_check_in_lead))
+                THEN 'confirmed'
+              WHEN t.driver_checked_in_at IS NULL
+                THEN 'check_in_required'
+              WHEN now() < (
+                t.scheduled_at
+                - make_interval(mins => GREATEST(v_early_arrival + v_safety + v_access, 1))
+              )
+                THEN 'checked_in'
+              WHEN now() < (
+                t.scheduled_at
+                - make_interval(mins => GREATEST(v_early_arrival + v_safety + v_access, 1))
+                + make_interval(mins => v_start_grace)
+              )
+                THEN 'start_journey'
+              ELSE 'urgent_start_journey'
+            END AS banner_phase,
+            CASE
+              WHEN t.driver_checked_in_at IS NULL
+                AND now() < (t.scheduled_at - make_interval(mins => v_check_in_lead))
+                THEN false
+              ELSE true
+            END AS is_banner_candidate,
+            CASE
+              WHEN t.driver_checked_in_at IS NULL
+                AND now() >= (t.scheduled_at - make_interval(mins => v_check_in_lead))
+                THEN 'check_in'
+              WHEN t.driver_checked_in_at IS NOT NULL
+                AND now() >= (
+                  t.scheduled_at
+                  - make_interval(mins => GREATEST(v_early_arrival + v_safety + v_access, 1))
+                )
+                THEN 'start_journey'
+              ELSE NULL
+            END AS primary_action,
+            CASE
+              WHEN t.driver_checked_in_at IS NULL
+                AND now() >= (t.scheduled_at - make_interval(mins => v_check_in_lead))
+                THEN 'Check in'
+              WHEN t.driver_checked_in_at IS NOT NULL
+                AND now() >= (
+                  t.scheduled_at
+                  - make_interval(mins => GREATEST(v_early_arrival + v_safety + v_access, 1))
+                )
+                THEN 'Start journey'
+              ELSE NULL
+            END AS cta_label
+          FROM public.trips t
+          LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
+          WHERE t.dispatch_mode = 'scheduled'
+            AND t.confirmed_driver_id = v_driver_id
+            AND t.driver_id IS NULL
+            AND t.scheduled_status = 'driver_assigned'
+            AND t.scheduled_at > (now() - make_interval(mins => GREATEST(v_check_in_grace, 15)))
+            AND lower(COALESCE(t.status, '')) NOT IN (
+              'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
+              'no_show', 'expired', 'expired_no_driver', 'en_route_to_pickup', 'in_progress'
+            )
+          ORDER BY t.scheduled_at ASC
+          LIMIT 100
+        ) row
+      ),
+      '[]'::jsonb
+    );
+  END IF;
+
+  -- Requested: available marketplace offers (Accept only on Driver UI).
+  RETURN COALESCE(
+    (
+      SELECT jsonb_agg(to_jsonb(row) ORDER BY row.scheduled_at ASC)
+      FROM (
+        SELECT
+          t.id,
+          t.scheduled_at,
+          t.vehicle_type,
+          t.trip_type,
+          t.job_type,
+          t.payment_method,
+          t.financial_model AS financial_model,
+          t.estimated_duration_minutes,
+          COALESCE(t.driver_net_pence, round(COALESCE(t.estimated_fare, t.fare, 0) * 100)::bigint) AS estimated_fare_pence,
+          COALESCE(t.currency_code, t.currency, 'GBP') AS currency_code,
+          t.pickup_address,
+          t.pickup_latitude,
+          t.pickup_longitude,
+          t.dropoff_address,
+          t.dropoff_latitude,
+          t.dropoff_longitude,
+          t.stops,
+          COALESCE(t.total_stops, 1) AS total_stops,
+          t.special_instructions,
+          t.scheduled_status,
+          t.status,
+          sa.name AS service_area_label
+        FROM public.trips t
+        LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
+        WHERE t.dispatch_mode = 'scheduled'
+          AND t.scheduled_status = ANY (ARRAY['broadcasting', 'scheduled', 'awaiting_confirmation'])
+          AND t.driver_id IS NULL
+          AND t.confirmed_driver_id IS NULL
+          AND t.scheduled_at > now()
+          AND (t.status IS NULL OR t.status <> ALL (ARRAY[
+            'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
+            'no_show', 'expired', 'expired_no_driver'
+          ]))
+          AND (
+            t.service_area_id IS NULL
+            OR t.service_area_id IN (
+              SELECT d.service_area_id FROM public.drivers d WHERE d.id = v_driver_id AND d.service_area_id IS NOT NULL
+              UNION
+              SELECT dsa.service_area_id FROM public.driver_service_areas dsa WHERE dsa.driver_id = v_driver_id
+            )
+          )
+          AND NOT EXISTS (
+            SELECT 1 FROM public.scheduled_offer_attempts soa
+            WHERE soa.trip_id = t.id
+              AND soa.driver_id = v_driver_id
+              AND soa.status IN ('declined', 'timeout', 'cancelled')
+          )
+        ORDER BY t.scheduled_at ASC
+        LIMIT 100
+      ) row
+    ),
+    '[]'::jsonb
+  );
+END;
+$function$;
diff --git a/supabase/migrations/20261108200000_trip_history_financial_model_passthrough.sql b/supabase/migrations/20261108200000_trip_history_financial_model_passthrough.sql
new file mode 100644
index 00000000..06212f4c
--- /dev/null
+++ b/supabase/migrations/20261108200000_trip_history_financial_model_passthrough.sql
@@ -0,0 +1,286 @@
+-- Passthrough only: expose stamped trips.financial_model on driver trip history.
+-- Does not derive the model from payment_method or a card payment record.
+
+CREATE OR REPLACE FUNCTION public.list_driver_own_trip_history(p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_tab text DEFAULT NULL::text, p_trip_id uuid DEFAULT NULL::uuid)
+ RETURNS jsonb
+ LANGUAGE plpgsql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+DECLARE
+  v_driver_id uuid := public.current_driver_id();
+  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
+  v_tab text := lower(nullif(trim(COALESCE(p_tab, '')), ''));
+BEGIN
+  IF auth.uid() IS NULL THEN
+    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
+  END IF;
+
+  IF v_driver_id IS NULL THEN
+    RETURN '[]'::jsonb;
+  END IF;
+
+  IF v_tab IS NOT NULL AND v_tab NOT IN ('completed', 'cancelled') THEN
+    RAISE EXCEPTION 'invalid_tab' USING ERRCODE = '22023';
+  END IF;
+
+  RETURN COALESCE(
+    (
+      SELECT jsonb_agg(to_jsonb(row) ORDER BY row.sort_at DESC)
+      FROM (
+        SELECT
+          deduped.id,
+          deduped.public_trip_ref,
+          deduped.backend_status,
+          deduped.cancellation_reason_code,
+          deduped.cancelled_by,
+          deduped.cancelled_by_role,
+          deduped.financial_outcome,
+          deduped.service_area_label,
+          deduped.pickup_area_label,
+          deduped.dropoff_area_label,
+          deduped.total_stops,
+          deduped.requested_at,
+          deduped.pickup_at,
+          deduped.dropoff_at,
+          deduped.cancelled_at,
+          deduped.closed_at,
+          deduped.payable_amount_pence,
+          deduped.has_card_payment_record,
+          deduped.payment_method,
+          deduped.financial_model,
+          deduped.booking_type,
+          deduped.vehicle_type,
+          deduped.sort_at,
+          deduped.is_active
+        FROM (
+          SELECT DISTINCT ON (combined.id)
+            combined.id,
+            combined.public_trip_ref,
+            combined.backend_status,
+            combined.cancellation_reason_code,
+            combined.cancelled_by,
+            combined.cancelled_by_role,
+            combined.financial_outcome,
+            combined.service_area_label,
+            combined.pickup_area_label,
+            combined.dropoff_area_label,
+            combined.total_stops,
+            combined.requested_at,
+            combined.pickup_at,
+            combined.dropoff_at,
+            combined.cancelled_at,
+            combined.closed_at,
+            combined.payable_amount_pence,
+            combined.has_card_payment_record,
+            combined.payment_method,
+            combined.financial_model,
+            combined.booking_type,
+            combined.vehicle_type,
+            combined.sort_at,
+            combined.is_active
+          FROM (
+            -- A) Terminal trips this driver owned / was cancelled from
+            SELECT
+              t.id,
+              COALESCE(t.trip_number, t.trip_code, left(t.id::text, 8)) AS public_trip_ref,
+              t.status AS backend_status,
+              COALESCE(t.cancellation_reason, t.cancel_reason, t.cancelled_by_role) AS cancellation_reason_code,
+              t.cancelled_by,
+              t.cancelled_by_role,
+              t.financial_outcome,
+              sa.name AS service_area_label,
+              sa.name AS pickup_area_label,
+              sa.name AS dropoff_area_label,
+              COALESCE(t.total_stops, 1) AS total_stops,
+              t.created_at AS requested_at,
+              t.started_at AS pickup_at,
+              t.completed_at AS dropoff_at,
+              t.cancelled_at,
+              CASE
+                WHEN lower(COALESCE(t.status, '')) = 'no_show'
+                  THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at)
+                ELSE t.completed_at
+              END AS closed_at,
+              COALESCE(
+                t.driver_total_earnings_pence,
+                t.driver_net_pence,
+                t.no_show_charge_pence,
+                t.cancellation_fee_pence,
+                t.late_cancel_fee_pence
+              ) AS payable_amount_pence,
+              (t.payment_method IS NOT NULL AND lower(t.payment_method) IN ('card', 'apple_pay', 'google_pay', 'saved_card', 'revolut'))
+                OR (t.provider_order_id IS NOT NULL)
+                OR (t.payment_session_id IS NOT NULL) AS has_card_payment_record,
+              t.payment_method,
+              t.financial_model,
+              t.booking_type,
+              t.vehicle_type,
+              COALESCE(
+                CASE
+                  WHEN lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
+                    THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at, t.created_at)
+                  ELSE COALESCE(t.cancelled_at, t.updated_at, t.created_at)
+                END,
+                t.created_at
+              ) AS sort_at,
+              false AS is_active,
+              1 AS source_pri
+            FROM public.trips t
+            LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
+            WHERE (
+                t.driver_id = v_driver_id
+                OR t.confirmed_driver_id = v_driver_id
+                OR t.previous_driver_id = v_driver_id
+                OR (t.cancelled_driver_ids IS NOT NULL AND t.cancelled_driver_ids @> ARRAY[v_driver_id])
+              )
+              AND (
+                p_trip_id IS NULL
+                OR t.id = p_trip_id
+              )
+              AND lower(COALESCE(t.status, '')) IN (
+                'completed',
+                'no_show',
+                'cancelled',
+                'customer_cancelled',
+                'driver_cancelled',
+                'expired',
+                'expired_no_driver',
+                'missed'
+              )
+              AND (
+                v_tab IS NULL
+                OR (
+                  v_tab = 'completed'
+                  AND lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
+                )
+                OR (
+                  v_tab = 'cancelled'
+                  AND lower(COALESCE(t.status, '')) IN (
+                    'cancelled',
+                    'customer_cancelled',
+                    'driver_cancelled',
+                    'expired',
+                    'expired_no_driver',
+                    'missed'
+                  )
+                )
+              )
+              AND (p_before IS NULL OR COALESCE(
+                CASE
+                  WHEN lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
+                    THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at, t.created_at)
+                  ELSE COALESCE(t.cancelled_at, t.updated_at, t.created_at)
+                END,
+                t.created_at
+              ) < p_before)
+
+            UNION ALL
+
+            -- B) Missed / lost offers (never assigned to this driver on trips)
+            SELECT
+              ro.trip_id AS id,
+              COALESCE(t.trip_number, t.trip_code, left(ro.trip_id::text, 8)) AS public_trip_ref,
+              CASE
+                WHEN lower(ro.status) = 'declined' THEN 'driver_declined'
+                WHEN lower(ro.status) = 'expired' THEN 'offer_expired'
+                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'another_offer_accepted'
+                  THEN 'cancelled'
+                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
+                  'passenger_cancelled', 'trip_cancelled', 'trip_terminal_cancel'
+                ) THEN 'cancelled'
+                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
+                  'cancelled_by_admin', 'admin_cancelled'
+                ) THEN 'cancelled'
+                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'trip_expired_no_driver'
+                  THEN 'offer_expired'
+                ELSE 'cancelled'
+              END AS backend_status,
+              CASE
+                WHEN lower(ro.status) = 'declined' THEN 'driver_declined'
+                WHEN lower(ro.status) = 'expired' THEN 'offer_expired'
+                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'another_offer_accepted'
+                  THEN 'accepted_by_another_driver'
+                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'passenger_cancelled'
+                  THEN 'passenger_cancelled'
+                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
+                  'trip_cancelled', 'trip_terminal_cancel'
+                ) THEN 'passenger_cancelled'
+                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
+                  'cancelled_by_admin', 'admin_cancelled'
+                ) THEN 'admin_cancelled'
+                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'trip_expired_no_driver'
+                  THEN 'offer_expired'
+                ELSE COALESCE(nullif(lower(ro.revoked_reason), ''), 'cancelled')
+              END AS cancellation_reason_code,
+              NULL::text AS cancelled_by,
+              NULL::text AS cancelled_by_role,
+              NULL::text AS financial_outcome,
+              sa.name AS service_area_label,
+              sa.name AS pickup_area_label,
+              sa.name AS dropoff_area_label,
+              COALESCE(t.total_stops, 1) AS total_stops,
+              COALESCE(ro.offered_at, ro.created_at) AS requested_at,
+              NULL::timestamptz AS pickup_at,
+              NULL::timestamptz AS dropoff_at,
+              COALESCE(ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at) AS cancelled_at,
+              NULL::timestamptz AS closed_at,
+              COALESCE(
+                ro.driver_offer_fare,
+                NULLIF(ro.offer_snapshot->>'driver_net_fare_pence', '')::int,
+                NULLIF(ro.offer_snapshot->>'driver_earnings_pence', '')::int,
+                NULLIF(ro.offer_snapshot->>'driver_net_preview_pence', '')::int
+              ) AS payable_amount_pence,
+              false AS has_card_payment_record,
+              t.payment_method,
+              t.financial_model,
+              t.booking_type,
+              t.vehicle_type,
+              COALESCE(ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at) AS sort_at,
+              false AS is_active,
+              2 AS source_pri
+            FROM public.ride_offers ro
+            INNER JOIN public.trips t ON t.id = ro.trip_id
+            LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
+            WHERE ro.driver_id = v_driver_id
+              AND (
+                p_trip_id IS NULL
+                OR ro.trip_id = p_trip_id
+              )
+              AND (
+                v_tab IS NULL
+                OR v_tab = 'cancelled'
+              )
+              AND lower(COALESCE(ro.status, '')) IN ('declined', 'expired', 'revoked')
+              AND (
+                lower(ro.status) IN ('declined', 'expired')
+                OR lower(COALESCE(ro.revoked_reason, '')) IN (
+                  'another_offer_accepted',
+                  'passenger_cancelled',
+                  'trip_cancelled',
+                  'trip_terminal_cancel',
+                  'cancelled_by_admin',
+                  'admin_cancelled',
+                  'trip_expired_no_driver'
+                )
+              )
+              AND NOT (
+                t.driver_id = v_driver_id
+                OR t.confirmed_driver_id = v_driver_id
+                OR t.previous_driver_id = v_driver_id
+                OR (t.cancelled_driver_ids IS NOT NULL AND t.cancelled_driver_ids @> ARRAY[v_driver_id])
+              )
+              AND (p_before IS NULL OR COALESCE(
+                ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at
+              ) < p_before)
+          ) combined
+          ORDER BY combined.id, combined.source_pri ASC, combined.sort_at DESC
+        ) deduped
+        ORDER BY deduped.sort_at DESC
+        LIMIT CASE WHEN p_trip_id IS NOT NULL THEN 1 ELSE v_limit END
+      ) row
+    ),
+    '[]'::jsonb
+  );
+END;
+$function$;
diff --git a/supabase/migrations/20261109420000_phase_a8b28_can_corporate_user_view_driver_self_bind.sql b/supabase/migrations/20261109420000_phase_a8b28_can_corporate_user_view_driver_self_bind.sql
new file mode 100644
index 00000000..2dc3eedf
--- /dev/null
+++ b/supabase/migrations/20261109420000_phase_a8b28_can_corporate_user_view_driver_self_bind.sql
@@ -0,0 +1,127 @@
+-- ============================================================
+-- Phase A8B28: can_corporate_user_view_driver self-bind lock
+-- NOT APPLIED until explicitly approved.
+--
+-- Target: public.can_corporate_user_view_driver(p_driver_id uuid, p_user_id uuid)
+--   RETURNS boolean
+--   LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
+--   owner postgres; overload_count = 1
+--
+-- Hash convention (do not confuse these):
+--   body_md5 / proposed = md5(pg_proc.prosrc)
+--     baseline:  b000bb084232102300009c2a03d9bcb0
+--     proposed:  80c738f1ab36c17174bcc98a8416855c
+--   md5(pg_get_functiondef(...)) for the same live proposed body:
+--     8e44e4fb68513a01b747882b3acce69e
+--
+-- Vulnerability: SECURITY DEFINER boolean probe accepts arbitrary
+--   p_user_id with no auth.uid() bind. Any authenticated client can
+--   test whether a foreign corporate user currently shares an active
+--   (non-cancelled/non-completed) trip with a given driver.
+--
+-- Proven dependency (live):
+--   View public.drivers_public_safe (security_invoker) filters with
+--     can_corporate_user_view_driver(id, auth.uid())
+--   OR can_passenger_view_driver(id)
+--   No live table RLS policies reference this function.
+--   No SQL function parents, triggers, or cron jobs call it.
+--   No Admin / Driver / Customer / Corporate / Guest / Edge .rpc callers
+--     (generated types only). Runtime consumers use the view path with
+--     auth.uid(), which remains compatible after self-bind.
+--
+-- Remediation (NEEDS_SELF_BIND) — same contract family as has_role (A7C2C):
+--   Require auth.uid() IS NOT NULL
+--     AND p_user_id IS NOT DISTINCT FROM auth.uid()
+--     AND the existing corporate active-trip EXISTS predicate
+--   Foreign p_user_id / null JWT → false (boolean contract; not 42501),
+--     so drivers_public_safe OR-filter never errors on bind failure.
+--   Preserve signature, STABLE, SECURITY DEFINER, search_path=public,
+--     owner postgres, LANGUAGE sql, and baseline ACL
+--     {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}.
+--   No current_user, profiles.role, metadata, or service_role bypass.
+--   Do not modify drivers_public_safe or can_passenger_view_driver.
+--
+-- Expected Advisor change:
+--   authenticated_security_definer_function_executable: unchanged 111
+--   (body-only fix; EXECUTE retained)
+--   Live baseline after A8B28F pause RPC: auth SECDEF EXECUTE count = 111
+--   (was 110 when A8B28 was drafted; +1 = admin_set_driver_payout_operational_pause)
+-- ============================================================
+
+BEGIN;
+
+DO $$
+DECLARE
+  v_md5 text;
+  v_args text;
+  v_overloads int;
+BEGIN
+  SELECT pg_get_function_identity_arguments(p.oid), md5(p.prosrc)
+  INTO v_args, v_md5
+  FROM pg_proc p
+  JOIN pg_namespace n ON n.oid = p.pronamespace
+  WHERE n.nspname = 'public'
+    AND p.proname = 'can_corporate_user_view_driver';
+
+  IF v_args IS DISTINCT FROM 'p_driver_id uuid, p_user_id uuid' THEN
+    RAISE EXCEPTION 'A8B28 HARD STOP: unexpected identity args=%', v_args;
+  END IF;
+
+  IF v_md5 IS DISTINCT FROM 'b000bb084232102300009c2a03d9bcb0' THEN
+    RAISE EXCEPTION 'A8B28 HARD STOP: unexpected baseline md5(prosrc)=%', v_md5;
+  END IF;
+
+  SELECT count(*)::int INTO v_overloads
+  FROM pg_proc p
+  JOIN pg_namespace n ON n.oid = p.pronamespace
+  WHERE n.nspname = 'public'
+    AND p.proname = 'can_corporate_user_view_driver';
+
+  IF v_overloads IS DISTINCT FROM 1 THEN
+    RAISE EXCEPTION 'A8B28 HARD STOP: unexpected overload_count=%', v_overloads;
+  END IF;
+END $$;
+
+CREATE OR REPLACE FUNCTION public.can_corporate_user_view_driver(p_driver_id uuid, p_user_id uuid)
+RETURNS boolean
+LANGUAGE sql
+STABLE
+SECURITY DEFINER
+SET search_path TO 'public'
+AS $function$
+  SELECT
+    auth.uid() IS NOT NULL
+    AND p_user_id IS NOT DISTINCT FROM auth.uid()
+    AND EXISTS (
+      SELECT 1
+      FROM trips t
+      JOIN corporate_user_accounts cua ON cua.corporate_account_id = t.corporate_account_id
+      WHERE t.driver_id = p_driver_id
+        AND cua.user_id = p_user_id
+        AND COALESCE(t.status, '') NOT IN ('cancelled', 'completed')
+    )
+$function$;
+
+DO $$
+DECLARE
+  v_md5 text;
+BEGIN
+  SELECT md5(p.prosrc) INTO v_md5
+  FROM pg_proc p
+  JOIN pg_namespace n ON n.oid = p.pronamespace
+  WHERE n.nspname = 'public'
+    AND p.proname = 'can_corporate_user_view_driver'
+    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid, p_user_id uuid';
+
+  IF v_md5 IS DISTINCT FROM '80c738f1ab36c17174bcc98a8416855c' THEN
+    RAISE EXCEPTION 'A8B28 HARD STOP: unexpected proposed md5(prosrc)=%', v_md5;
+  END IF;
+
+  IF has_function_privilege('anon', 'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure, 'EXECUTE')
+     OR has_function_privilege('public', 'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure, 'EXECUTE')
+  THEN
+    RAISE EXCEPTION 'A8B28 HARD STOP: PUBLIC/anon EXECUTE present';
+  END IF;
+END $$;
+
+COMMIT;
diff --git a/supabase/migrations/20261109510000_phase_tip_window_deferral_columns.sql b/supabase/migrations/20261109510000_phase_tip_window_deferral_columns.sql
new file mode 100644
index 00000000..c103eccc
--- /dev/null
+++ b/supabase/migrations/20261109510000_phase_tip_window_deferral_columns.sql
@@ -0,0 +1,17 @@
+-- A8B28F tip window deferral columns (additive).
+-- tip_window_status: open | closed | null (never opened)
+
+ALTER TABLE public.trips
+  ADD COLUMN IF NOT EXISTS tip_window_opened_at timestamptz,
+  ADD COLUMN IF NOT EXISTS tip_window_status text;
+
+COMMENT ON COLUMN public.trips.tip_window_opened_at IS
+  'When the post-completion tip window opened (Customer App card + tips_enabled).';
+COMMENT ON COLUMN public.trips.tip_window_status IS
+  'Tip window lifecycle: open | closed. Null when no tip window was opened.';
+
+CREATE INDEX IF NOT EXISTS idx_trips_tip_window_expiry_open
+  ON public.trips (tip_window_expires_at)
+  WHERE tip_window_status = 'open'
+    AND tip_window_closed_at IS NULL
+    AND status = 'completed';
diff --git a/supabase/migrations/20261109520000_phase_tip_window_expiry_has_work_closed_gate.sql b/supabase/migrations/20261109520000_phase_tip_window_expiry_has_work_closed_gate.sql
new file mode 100644
index 00000000..4f563352
--- /dev/null
+++ b/supabase/migrations/20261109520000_phase_tip_window_expiry_has_work_closed_gate.sql
@@ -0,0 +1,27 @@
+-- Tip-expiry has_work: only uncapped open windows past expires_at.
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.provider_order_id IS NOT NULL
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND t.payment_status IN (
+        'preauth_created',
+        'preauth_authorized',
+        'authorized',
+        'preauth_updated',
+        'capture_requested',
+        'capture_failed'
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/20261109530000_phase_tip_window_expiry_authorised_spelling.sql b/supabase/migrations/20261109530000_phase_tip_window_expiry_authorised_spelling.sql
new file mode 100644
index 00000000..dbd7a806
--- /dev/null
+++ b/supabase/migrations/20261109530000_phase_tip_window_expiry_authorised_spelling.sql
@@ -0,0 +1,29 @@
+-- Tip-expiry has_work: include British + American authorised spellings.
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.provider_order_id IS NOT NULL
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND t.payment_status IN (
+        'preauth_created',
+        'preauth_authorized',
+        'preauth_authorised',
+        'authorized',
+        'authorised',
+        'preauth_updated',
+        'capture_requested',
+        'capture_failed'
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/20261109540000_phase_tip_window_expiry_has_work_finalised_close.sql b/supabase/migrations/20261109540000_phase_tip_window_expiry_has_work_finalised_close.sql
new file mode 100644
index 00000000..f3a8da44
--- /dev/null
+++ b/supabase/migrations/20261109540000_phase_tip_window_expiry_has_work_finalised_close.sql
@@ -0,0 +1,36 @@
+-- Tip-expiry has_work: also wake when payment already finalised but tip window
+-- never closed (close-after-capture failure / race). Edge closes these without
+-- re-capturing.
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND (
+        (
+          t.provider_order_id IS NOT NULL
+          AND t.payment_status IN (
+            'preauth_created',
+            'preauth_authorized',
+            'preauth_authorised',
+            'authorized',
+            'authorised',
+            'preauth_updated',
+            'capture_requested',
+            'capture_failed'
+          )
+        )
+        OR t.payment_status IN ('captured', 'paid', 'collected_cash')
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/20261109550000_phase_tip_window_expiry_has_work_payment_intent.sql b/supabase/migrations/20261109550000_phase_tip_window_expiry_has_work_payment_intent.sql
new file mode 100644
index 00000000..5c4e0449
--- /dev/null
+++ b/supabase/migrations/20261109550000_phase_tip_window_expiry_has_work_payment_intent.sql
@@ -0,0 +1,35 @@
+-- Tip-expiry has_work: also wake on payment_intent_id-only Revolut rows
+-- (edge query already ORs provider_order_id / payment_intent_id).
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND (
+        (
+          (t.provider_order_id IS NOT NULL OR t.payment_intent_id IS NOT NULL)
+          AND t.payment_status IN (
+            'preauth_created',
+            'preauth_authorized',
+            'preauth_authorised',
+            'authorized',
+            'authorised',
+            'preauth_updated',
+            'capture_requested',
+            'capture_failed'
+          )
+        )
+        OR t.payment_status IN ('captured', 'paid', 'collected_cash')
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/20261109560000_phase_tip_window_column_write_lock.sql b/supabase/migrations/20261109560000_phase_tip_window_column_write_lock.sql
new file mode 100644
index 00000000..ae5acbdb
--- /dev/null
+++ b/supabase/migrations/20261109560000_phase_tip_window_column_write_lock.sql
@@ -0,0 +1,58 @@
+-- Tip amount and tip-window stamps are service-role only.
+-- Driver RLS allows UPDATE on assigned trips (any column). Without this guard a
+-- driver JWT can raise tip_amount_pence (expiry then captures it) or push
+-- tip_window_expires_at out so fare capture never runs.
+-- auth.uid() IS NULL covers edge service_role and cron (no user JWT).
+
+CREATE OR REPLACE FUNCTION public.guard_trip_tip_window_columns()
+RETURNS trigger
+LANGUAGE plpgsql
+SET search_path TO 'public'
+AS $fn$
+BEGIN
+  IF auth.uid() IS NULL THEN
+    RETURN NEW;
+  END IF;
+
+  IF TG_OP = 'INSERT' THEN
+    IF coalesce(NEW.tip_amount_pence, 0) <> 0
+       OR coalesce(NEW.tip_pence, 0) <> 0
+       OR NEW.tip_window_expires_at IS NOT NULL
+       OR NEW.tip_window_closed_at IS NOT NULL
+       OR NEW.tip_window_opened_at IS NOT NULL
+       OR NEW.tip_window_status IS NOT NULL
+    THEN
+      RAISE EXCEPTION 'TIP_WINDOW_COLUMNS_LOCKED'
+        USING ERRCODE = '42501';
+    END IF;
+    RETURN NEW;
+  END IF;
+
+  IF NEW.tip_amount_pence IS DISTINCT FROM OLD.tip_amount_pence
+     OR NEW.tip_pence IS DISTINCT FROM OLD.tip_pence
+     OR NEW.tip_window_expires_at IS DISTINCT FROM OLD.tip_window_expires_at
+     OR NEW.tip_window_closed_at IS DISTINCT FROM OLD.tip_window_closed_at
+     OR NEW.tip_window_opened_at IS DISTINCT FROM OLD.tip_window_opened_at
+     OR NEW.tip_window_status IS DISTINCT FROM OLD.tip_window_status
+  THEN
+    RAISE EXCEPTION 'TIP_WINDOW_COLUMNS_LOCKED'
+      USING ERRCODE = '42501';
+  END IF;
+
+  RETURN NEW;
+END;
+$fn$;
+
+COMMENT ON FUNCTION public.guard_trip_tip_window_columns() IS
+  'Rejects authenticated writes to tip amount and tip-window stamps. Service role (auth.uid() null) retains ownership.';
+
+REVOKE ALL ON FUNCTION public.guard_trip_tip_window_columns() FROM PUBLIC;
+REVOKE ALL ON FUNCTION public.guard_trip_tip_window_columns() FROM anon;
+REVOKE ALL ON FUNCTION public.guard_trip_tip_window_columns() FROM authenticated;
+REVOKE ALL ON FUNCTION public.guard_trip_tip_window_columns() FROM service_role;
+
+DROP TRIGGER IF EXISTS trg_guard_trip_tip_window_columns ON public.trips;
+CREATE TRIGGER trg_guard_trip_tip_window_columns
+  BEFORE INSERT OR UPDATE ON public.trips
+  FOR EACH ROW
+  EXECUTE FUNCTION public.guard_trip_tip_window_columns();
diff --git a/supabase/migrations/20261109570000_phase_tip_window_expiry_has_work_shortfall_retry.sql b/supabase/migrations/20261109570000_phase_tip_window_expiry_has_work_shortfall_retry.sql
new file mode 100644
index 00000000..42ed8245
--- /dev/null
+++ b/supabase/migrations/20261109570000_phase_tip_window_expiry_has_work_shortfall_retry.sql
@@ -0,0 +1,39 @@
+-- Tip-expiry has_work: retry expired windows left on payment_shortfall /
+-- recovery_required. Those stamps are durable settlement outcomes, not a
+-- captured fare. Closing the window without a positive capture strands the
+-- hold; the sweep must keep waking until capture lands.
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND (
+        (
+          (t.provider_order_id IS NOT NULL OR t.payment_intent_id IS NOT NULL)
+          AND t.payment_status IN (
+            'preauth_created',
+            'preauth_authorized',
+            'preauth_authorised',
+            'authorized',
+            'authorised',
+            'preauth_updated',
+            'capture_requested',
+            'capture_failed',
+            'payment_shortfall',
+            'recovery_required'
+          )
+        )
+        OR t.payment_status IN ('captured', 'paid', 'collected_cash')
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/20261109580000_phase_tip_refund_reverses_captured_tip.sql b/supabase/migrations/20261109580000_phase_tip_refund_reverses_captured_tip.sql
new file mode 100644
index 00000000..04c6fd75
--- /dev/null
+++ b/supabase/migrations/20261109580000_phase_tip_refund_reverses_captured_tip.sql
@@ -0,0 +1,368 @@
+-- A captured passenger tip is DRIVER_TIP_CREDIT, separate from TRIP_EARNING_NET.
+-- apply_confirmed_provider_refund_atomic reversed only driver_net, so a refund
+-- that returned the tip left the credit with the driver. Claw the tip only when
+-- the cumulative refund exceeds the fare. A fare-only refund is unchanged.
+
+CREATE OR REPLACE FUNCTION public.apply_confirmed_provider_refund_atomic(
+  p_trip_id uuid,
+  p_payment_provider text,
+  p_provider_refund_id text,
+  p_event_refund_amount_pence integer,
+  p_cumulative_refunded_pence integer,
+  p_provider_order_id text DEFAULT NULL,
+  p_provider_payment_id text DEFAULT NULL,
+  p_refund_reason text DEFAULT NULL,
+  p_source text DEFAULT 'admin_refund',
+  p_skip_driver_wallet_reversal boolean DEFAULT false
+)
+RETURNS jsonb
+LANGUAGE plpgsql
+SECURITY DEFINER
+SET search_path TO 'pg_catalog'
+AS $function$
+DECLARE
+  v_trip public.trips%ROWTYPE;
+  v_ps public.payment_sessions%ROWTYPE;
+  v_rb_count integer;
+  v_captured_pence integer;
+  v_commission_pence integer;
+  v_driver_net_pence integer;
+  v_now timestamptz := now();
+  v_child_id uuid;
+  v_existing_child_id uuid;
+  v_existing_debit_id uuid;
+  v_existing_debit_pence integer;
+  v_ps_refunded_sum integer;
+  v_refund_status text;
+  v_payment_status text;
+  v_ratio numeric;
+  v_target_reversal integer;
+  v_authoritative_debit_sum integer;
+  v_missing_reversal integer;
+  v_credited_pence integer;
+  v_insert_debit_pence integer;
+  v_ledger_id uuid;
+  v_net_captured integer;
+  v_adjusted_commission integer;
+  v_adjusted_driver_net integer;
+  v_tip_credit_pence integer;
+  v_fare_basis_pence integer;
+  v_target_tip_reversal integer;
+BEGIN
+  IF p_trip_id IS NULL THEN
+    RAISE EXCEPTION 'trip_id_required' USING ERRCODE = 'invalid_parameter_value';
+  END IF;
+
+  IF p_provider_refund_id IS NULL OR btrim(p_provider_refund_id) = '' THEN
+    RAISE EXCEPTION 'provider_refund_id_required' USING ERRCODE = 'invalid_parameter_value';
+  END IF;
+
+  IF p_payment_provider IS NULL OR btrim(p_payment_provider) = '' THEN
+    RAISE EXCEPTION 'payment_provider_required' USING ERRCODE = 'invalid_parameter_value';
+  END IF;
+
+  IF p_event_refund_amount_pence IS NULL OR p_event_refund_amount_pence <= 0 THEN
+    RAISE EXCEPTION 'event_refund_amount_invalid' USING ERRCODE = 'invalid_parameter_value';
+  END IF;
+
+  IF p_cumulative_refunded_pence IS NULL OR p_cumulative_refunded_pence <= 0 THEN
+    RAISE EXCEPTION 'cumulative_refund_amount_invalid' USING ERRCODE = 'invalid_parameter_value';
+  END IF;
+
+  SELECT * INTO v_trip
+  FROM public.trips
+  WHERE id = p_trip_id
+  FOR UPDATE;
+
+  IF NOT FOUND THEN
+    RAISE EXCEPTION 'trip_not_found' USING ERRCODE = 'no_data_found';
+  END IF;
+
+  IF upper(coalesce(v_trip.financial_model::text, '')) = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
+    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION' USING ERRCODE = 'check_violation';
+  END IF;
+
+  IF EXISTS (
+    SELECT 1
+    FROM public.driver_wallet_ledger dwl
+    WHERE dwl.related_trip_id = p_trip_id
+      AND dwl.type = 'REFUND_DEBIT'
+      AND dwl.provider_refund_id IS NULL
+  ) THEN
+    RAISE EXCEPTION 'HISTORICAL_REFUND_DEBIT_REQUIRES_MANUAL_RECONCILIATION'
+      USING ERRCODE = 'check_violation';
+  END IF;
+
+  SELECT count(*)::integer INTO v_rb_count
+  FROM public.payment_sessions ps
+  WHERE ps.trip_id = p_trip_id
+    AND ps.purpose = 'RIDE_BOOKING';
+
+  IF v_rb_count = 0 THEN
+    RAISE EXCEPTION 'PAYMENT_SESSION_MISSING' USING ERRCODE = 'check_violation';
+  END IF;
+
+  IF v_rb_count > 1 THEN
+    RAISE EXCEPTION 'CAPTURE_AMBIGUOUS' USING ERRCODE = 'check_violation';
+  END IF;
+
+  SELECT * INTO v_ps
+  FROM public.payment_sessions ps
+  WHERE ps.trip_id = p_trip_id
+    AND ps.purpose = 'RIDE_BOOKING'
+  FOR UPDATE;
+
+  SELECT id INTO v_existing_child_id
+  FROM public.payment_session_refunds psr
+  WHERE psr.payment_provider = p_payment_provider
+    AND psr.provider_refund_id = p_provider_refund_id;
+
+  SELECT id, abs(dwl.amount_pence)::integer
+    INTO v_existing_debit_id, v_existing_debit_pence
+  FROM public.driver_wallet_ledger dwl
+  WHERE dwl.payment_provider = p_payment_provider
+    AND dwl.provider_refund_id = p_provider_refund_id
+    AND dwl.driver_id = v_trip.driver_id
+    AND dwl.type = 'REFUND_DEBIT';
+
+  IF v_existing_child_id IS NOT NULL AND v_existing_debit_id IS NOT NULL THEN
+    RETURN jsonb_build_object(
+      'status', 'already_applied',
+      'trip_id', p_trip_id,
+      'payment_session_id', v_ps.id,
+      'provider_refund_id', p_provider_refund_id,
+      'refund_child_id', v_existing_child_id,
+      'ledger_debit_id', v_existing_debit_id,
+      'cumulative_refunded_pence', p_cumulative_refunded_pence
+    );
+  END IF;
+
+  v_captured_pence := greatest(
+    0,
+    coalesce(v_trip.capture_amount_pence, v_ps.captured_amount_pence, v_ps.authorised_amount_pence, 0)
+  );
+  v_commission_pence := greatest(0, coalesce(v_trip.commission_pence, 0));
+  v_driver_net_pence := greatest(0, coalesce(v_trip.driver_net_pence, 0));
+
+  IF v_captured_pence <= 0 THEN
+    RAISE EXCEPTION 'captured_amount_missing' USING ERRCODE = 'check_violation';
+  END IF;
+
+  INSERT INTO public.payment_session_refunds (
+    payment_session_id,
+    payment_provider,
+    provider_refund_id,
+    provider_payment_id,
+    amount_pence,
+    currency,
+    status,
+    confirmed_at,
+    metadata
+  ) VALUES (
+    v_ps.id,
+    p_payment_provider,
+    p_provider_refund_id,
+    coalesce(p_provider_payment_id, p_provider_order_id, v_ps.provider_order_id),
+    p_event_refund_amount_pence,
+    lower(coalesce(v_ps.currency, 'gbp')),
+    'confirmed',
+    v_now,
+    jsonb_build_object('source', coalesce(p_source, 'admin_refund'))
+  )
+  ON CONFLICT (payment_provider, provider_refund_id) DO NOTHING
+  RETURNING id INTO v_child_id;
+
+  IF v_child_id IS NULL THEN
+    SELECT id INTO v_child_id
+    FROM public.payment_session_refunds psr
+    WHERE psr.payment_provider = p_payment_provider
+      AND psr.provider_refund_id = p_provider_refund_id;
+  END IF;
+
+  SELECT coalesce(sum(psr.amount_pence), 0)::integer INTO v_ps_refunded_sum
+  FROM public.payment_session_refunds psr
+  WHERE psr.payment_session_id = v_ps.id
+    AND psr.amount_pence > 0;
+
+  IF v_ps_refunded_sum <> p_cumulative_refunded_pence THEN
+    RAISE EXCEPTION 'cumulative_refund_mismatch: expected % got %',
+      p_cumulative_refunded_pence, v_ps_refunded_sum
+      USING ERRCODE = 'check_violation';
+  END IF;
+
+  IF p_cumulative_refunded_pence >= v_captured_pence THEN
+    v_refund_status := 'refunded';
+    v_payment_status := 'refunded';
+  ELSE
+    v_refund_status := 'partially_refunded';
+    v_payment_status := 'partially_refunded';
+  END IF;
+
+  v_net_captured := greatest(0, v_captured_pence - p_cumulative_refunded_pence);
+  v_ratio := v_net_captured::numeric / v_captured_pence::numeric;
+  v_adjusted_commission := greatest(0, round(v_commission_pence * v_ratio)::integer);
+  v_adjusted_driver_net := greatest(0, round(v_driver_net_pence * v_ratio)::integer);
+  v_target_reversal := greatest(0, v_driver_net_pence - v_adjusted_driver_net);
+
+  -- Reverse DRIVER_TIP_CREDIT only when the refund exceeds the fare.
+  SELECT coalesce(sum(greatest(0, dwl.amount_pence)), 0)::integer
+    INTO v_tip_credit_pence
+  FROM public.driver_wallet_ledger dwl
+  WHERE dwl.related_trip_id = p_trip_id
+    AND dwl.type = 'DRIVER_TIP_CREDIT'
+    AND (v_trip.driver_id IS NULL OR dwl.driver_id = v_trip.driver_id);
+
+  v_fare_basis_pence := greatest(0, coalesce(v_trip.final_fare_pence, 0));
+  IF v_fare_basis_pence <= 0 THEN
+    v_fare_basis_pence := greatest(0, v_captured_pence - least(v_tip_credit_pence, v_captured_pence));
+  END IF;
+  v_target_tip_reversal := least(
+    v_tip_credit_pence,
+    greatest(0, p_cumulative_refunded_pence - v_fare_basis_pence)
+  );
+  v_target_reversal := v_target_reversal + v_target_tip_reversal;
+
+  SELECT coalesce(sum(abs(dwl.amount_pence)), 0)::integer INTO v_authoritative_debit_sum
+  FROM public.driver_wallet_ledger dwl
+  WHERE dwl.related_trip_id = p_trip_id
+    AND dwl.type = 'REFUND_DEBIT'
+    AND dwl.provider_refund_id IS NOT NULL;
+
+  v_missing_reversal := greatest(0, v_target_reversal - v_authoritative_debit_sum);
+  v_insert_debit_pence := 0;
+
+  IF v_missing_reversal > 0
+     AND NOT coalesce(p_skip_driver_wallet_reversal, false)
+     AND v_trip.driver_id IS NOT NULL
+     AND v_existing_debit_id IS NULL THEN
+    SELECT coalesce(sum(greatest(0, dwl.amount_pence)), 0)::integer INTO v_credited_pence
+    FROM public.driver_wallet_ledger dwl
+    WHERE dwl.driver_id = v_trip.driver_id
+      AND dwl.related_trip_id = p_trip_id
+      AND dwl.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT');
+
+    IF v_credited_pence > 0 THEN
+      v_insert_debit_pence := least(v_credited_pence - v_authoritative_debit_sum, v_missing_reversal);
+      v_insert_debit_pence := greatest(0, v_insert_debit_pence);
+    ELSE
+      v_insert_debit_pence := v_missing_reversal;
+    END IF;
+
+    IF v_insert_debit_pence > 0 THEN
+      INSERT INTO public.driver_wallet_ledger (
+        driver_id,
+        related_trip_id,
+        type,
+        amount_pence,
+        currency,
+        description,
+        payment_provider,
+        provider_refund_id
+      ) VALUES (
+        v_trip.driver_id,
+        p_trip_id,
+        'REFUND_DEBIT',
+        -v_insert_debit_pence,
+        coalesce(v_trip.currency, 'GBP'),
+        format('provider refund reversal (%s) — %s', p_provider_refund_id, coalesce(p_source, 'admin_refund')),
+        p_payment_provider,
+        p_provider_refund_id
+      )
+      RETURNING id INTO v_ledger_id;
+    END IF;
+  ELSIF v_existing_debit_id IS NOT NULL THEN
+    v_ledger_id := v_existing_debit_id;
+  END IF;
+
+  UPDATE public.payment_sessions
+  SET
+    refunded_amount_pence = v_ps_refunded_sum,
+    refunded_at = v_now,
+    provider_refund_id = p_provider_refund_id,
+    updated_at = v_now
+  WHERE id = v_ps.id;
+
+  UPDATE public.trips
+  SET
+    payment_status = v_payment_status,
+    refund_amount_pence = p_cumulative_refunded_pence,
+    refunded_at = v_now,
+    updated_at = v_now,
+    refund_reason = coalesce(p_refund_reason, refund_reason)
+  WHERE id = p_trip_id;
+
+  UPDATE public.payments pay
+  SET
+    status = v_payment_status,
+    refunded_amount_pence = p_cumulative_refunded_pence,
+    refund_status = v_refund_status,
+    refunded_at = v_now,
+    updated_at = v_now,
+    provider_refund_id = p_provider_refund_id,
+    last_error = format('provider_refund:%s:%s', p_provider_refund_id, p_cumulative_refunded_pence)
+  WHERE pay.trip_id = p_trip_id;
+
+  UPDATE public.trip_finance tf
+  SET
+    refund_amount_pence = p_cumulative_refunded_pence,
+    refund_status = v_refund_status,
+    net_card_revenue_after_refund_pence = v_net_captured,
+    driver_wallet_reversal_pence = v_target_reversal,
+    commission_reversal_pence = greatest(0, v_commission_pence - v_adjusted_commission),
+    financial_status = CASE WHEN v_refund_status = 'refunded' THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
+    updated_at = v_now
+  WHERE tf.trip_id = p_trip_id;
+
+  RETURN jsonb_build_object(
+    'status', 'applied',
+    'trip_id', p_trip_id,
+    'payment_session_id', v_ps.id,
+    'provider_refund_id', p_provider_refund_id,
+    'refund_child_id', v_child_id,
+    'ledger_debit_id', v_ledger_id,
+    'cumulative_refunded_pence', p_cumulative_refunded_pence,
+    'target_driver_reversal_pence', v_target_reversal,
+    'authoritative_debit_sum_pence', v_authoritative_debit_sum + coalesce(v_insert_debit_pence, 0),
+    'inserted_debit_pence', coalesce(v_insert_debit_pence, 0),
+    'payment_status', v_payment_status,
+    'refund_status', v_refund_status
+  );
+
+EXCEPTION
+  WHEN unique_violation THEN
+    SELECT id INTO v_existing_child_id
+    FROM public.payment_session_refunds psr
+    WHERE psr.payment_provider = p_payment_provider
+      AND psr.provider_refund_id = p_provider_refund_id;
+
+    SELECT id, abs(dwl.amount_pence)::integer
+      INTO v_existing_debit_id, v_existing_debit_pence
+    FROM public.driver_wallet_ledger dwl
+    WHERE dwl.payment_provider = p_payment_provider
+      AND dwl.provider_refund_id = p_provider_refund_id
+      AND dwl.driver_id = v_trip.driver_id
+      AND dwl.type = 'REFUND_DEBIT';
+
+    SELECT coalesce(sum(psr.amount_pence), 0)::integer INTO v_ps_refunded_sum
+    FROM public.payment_session_refunds psr
+    WHERE psr.payment_session_id = v_ps.id
+      AND psr.amount_pence > 0;
+
+    IF v_existing_child_id IS NOT NULL
+       AND v_existing_debit_id IS NOT NULL
+       AND v_ps_refunded_sum = p_cumulative_refunded_pence THEN
+      RETURN jsonb_build_object(
+        'status', 'already_applied',
+        'trip_id', p_trip_id,
+        'payment_session_id', v_ps.id,
+        'provider_refund_id', p_provider_refund_id,
+        'refund_child_id', v_existing_child_id,
+        'ledger_debit_id', v_existing_debit_id,
+        'cumulative_refunded_pence', p_cumulative_refunded_pence,
+        'recovered_from', 'unique_violation'
+      );
+    END IF;
+
+    RAISE;
+END;
+$function$;
diff --git a/supabase/migrations/20261109590000_phase_tip_retire_legacy_completion_triggers.sql b/supabase/migrations/20261109590000_phase_tip_retire_legacy_completion_triggers.sql
new file mode 100644
index 00000000..101f235f
--- /dev/null
+++ b/supabase/migrations/20261109590000_phase_tip_retire_legacy_completion_triggers.sql
@@ -0,0 +1,39 @@
+-- Legacy completion triggers still owned tip money and the window stamp.
+-- handle_tip_added inserted DRIVER_TIP_CREDIT on the claim, before capture,
+-- and did not reverse it when the claim was reverted.
+-- set_tip_window_on_completion opened a 2-minute window on every tips-enabled
+-- completion, including channels that must capture immediately. That window
+-- made finalize refuse the fare capture until expiry.
+-- The edge stamp and the confirmed-capture ledger post own both.
+
+CREATE OR REPLACE FUNCTION public.set_tip_window_on_completion()
+RETURNS trigger
+LANGUAGE plpgsql
+SECURITY DEFINER
+SET search_path TO 'public'
+AS $function$
+BEGIN
+  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
+    NEW.completed_at := COALESCE(NEW.completed_at, now());
+  END IF;
+  RETURN NEW;
+END;
+$function$;
+
+COMMENT ON FUNCTION public.set_tip_window_on_completion() IS
+  'Completion timestamp only. Tip window is stamped by the edge path for Customer App card trips.';
+
+CREATE OR REPLACE FUNCTION public.handle_tip_added()
+RETURNS trigger
+LANGUAGE plpgsql
+SECURITY DEFINER
+SET search_path TO 'public'
+AS $function$
+BEGIN
+  -- Tip wallet credit is posted only after a confirmed capture covers fare+tip.
+  RETURN NEW;
+END;
+$function$;
+
+COMMENT ON FUNCTION public.handle_tip_added() IS
+  'No-op. DRIVER_TIP_CREDIT is posted by the confirmed-capture ledger path, never on the tip claim.';
diff --git a/supabase/migrations/20261109600000_phase_tip_window_expiry_has_work_session_order.sql b/supabase/migrations/20261109600000_phase_tip_window_expiry_has_work_session_order.sql
new file mode 100644
index 00000000..62fea0d7
--- /dev/null
+++ b/supabase/migrations/20261109600000_phase_tip_window_expiry_has_work_session_order.sql
@@ -0,0 +1,44 @@
+-- Expired tip windows whose only payment identity is payment_session_id
+-- never woke the sweep. Capture needs the session's provider_order_id, and
+-- the invoice stays blocked until the window closes.
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND (
+        (
+          (
+            t.provider_order_id IS NOT NULL
+            OR t.payment_intent_id IS NOT NULL
+            OR t.payment_session_id IS NOT NULL
+          )
+          AND t.payment_status IN (
+            'preauth_created',
+            'preauth_authorized',
+            'preauth_authorised',
+            'authorized',
+            'authorised',
+            'preauth_updated',
+            'capture_requested',
+            'capture_failed',
+            'pending',
+            'payment_shortfall',
+            'recovery_required'
+          )
+        )
+        OR t.payment_status IN ('captured', 'paid', 'collected_cash')
+        OR t.payment_status IN ('canceled', 'cancelled', 'released')
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/20261109610000_whatsapp_guest_auth_user_id_by_exact_phone.sql b/supabase/migrations/20261109610000_whatsapp_guest_auth_user_id_by_exact_phone.sql
new file mode 100644
index 00000000..45e8cb5f
--- /dev/null
+++ b/supabase/migrations/20261109610000_whatsapp_guest_auth_user_id_by_exact_phone.sql
@@ -0,0 +1,27 @@
+-- WhatsApp guest reuse must find the auth user who already owns the exact
+-- phone. GoTrue GET /admin/users?filter= is an email/name search, not phone.eq.
+-- Exact digits only: no last-10, no leading-00 strip.
+
+CREATE OR REPLACE FUNCTION public.auth_user_id_by_exact_phone(p_phone text)
+RETURNS uuid
+LANGUAGE sql
+STABLE
+SECURITY DEFINER
+SET search_path TO 'auth', 'public', 'pg_temp'
+AS $function$
+  SELECT u.id
+  FROM auth.users u
+  WHERE length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) BETWEEN 10 AND 15
+    AND u.phone IN (
+      p_phone,
+      regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'),
+      '+' || regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
+    )
+  ORDER BY u.created_at ASC
+  LIMIT 1;
+$function$;
+
+REVOKE ALL ON FUNCTION public.auth_user_id_by_exact_phone(text) FROM PUBLIC;
+REVOKE ALL ON FUNCTION public.auth_user_id_by_exact_phone(text) FROM anon;
+REVOKE ALL ON FUNCTION public.auth_user_id_by_exact_phone(text) FROM authenticated;
+GRANT EXECUTE ON FUNCTION public.auth_user_id_by_exact_phone(text) TO service_role;
diff --git a/supabase/migrations/20261109620000_customer_phone_allows_same_user_driver.sql b/supabase/migrations/20261109620000_customer_phone_allows_same_user_driver.sql
new file mode 100644
index 00000000..3db4ed54
--- /dev/null
+++ b/supabase/migrations/20261109620000_customer_phone_allows_same_user_driver.sql
@@ -0,0 +1,33 @@
+-- A driver booking as a passenger needs a customers row on their own auth user.
+-- The insert trigger treated every driver phone as foreign, including that
+-- same user. A different user still cannot take the phone.
+
+CREATE OR REPLACE FUNCTION public.enforce_customer_identity_uniqueness()
+RETURNS trigger
+LANGUAGE plpgsql
+SECURITY DEFINER
+SET search_path TO 'public'
+AS $function$
+DECLARE
+  v_phone text := nullif(trim(new.phone), '');
+BEGIN
+  IF new.deleted_at IS NOT NULL THEN
+    RETURN new;
+  END IF;
+
+  IF v_phone IS NOT NULL THEN
+    IF EXISTS (
+      SELECT 1 FROM public.drivers d
+      WHERE d.phone = v_phone
+        AND d.deleted_at IS NULL
+        AND d.user_id IS DISTINCT FROM new.user_id
+    ) THEN
+      RAISE EXCEPTION 'phone_already_in_use'
+        USING errcode = '23505',
+              hint = 'This phone number is already linked to a driver account.';
+    END IF;
+  END IF;
+
+  RETURN new;
+END;
+$function$;
diff --git a/supabase/migrations/rollback/rollback_20261109420000_phase_a8b28_can_corporate_user_view_driver_self_bind.sql b/supabase/migrations/rollback/rollback_20261109420000_phase_a8b28_can_corporate_user_view_driver_self_bind.sql
new file mode 100644
index 00000000..11f1a9aa
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109420000_phase_a8b28_can_corporate_user_view_driver_self_bind.sql
@@ -0,0 +1,43 @@
+-- Rollback Phase A8B28. Restores the captured production body for
+-- public.can_corporate_user_view_driver(p_driver_id uuid, p_user_id uuid).
+-- ACL is not changed.
+--
+-- Restored md5(prosrc) must equal baseline:
+--   b000bb084232102300009c2a03d9bcb0
+
+BEGIN;
+
+CREATE OR REPLACE FUNCTION public.can_corporate_user_view_driver(p_driver_id uuid, p_user_id uuid)
+RETURNS boolean
+LANGUAGE sql
+STABLE
+SECURITY DEFINER
+SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM trips t
+    JOIN corporate_user_accounts cua ON cua.corporate_account_id = t.corporate_account_id
+    WHERE t.driver_id = p_driver_id
+      AND cua.user_id = p_user_id
+      AND COALESCE(t.status, '') NOT IN ('cancelled', 'completed')
+  )
+$function$;
+
+DO $$
+DECLARE
+  v_md5 text;
+BEGIN
+  SELECT md5(p.prosrc) INTO v_md5
+  FROM pg_proc p
+  JOIN pg_namespace n ON n.oid = p.pronamespace
+  WHERE n.nspname = 'public'
+    AND p.proname = 'can_corporate_user_view_driver'
+    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid, p_user_id uuid';
+
+  IF v_md5 IS DISTINCT FROM 'b000bb084232102300009c2a03d9bcb0' THEN
+    RAISE EXCEPTION 'A8B28 ROLLBACK HARD STOP: unexpected restored md5(prosrc)=%', v_md5;
+  END IF;
+END $$;
+
+COMMIT;
diff --git a/supabase/migrations/rollback/rollback_20261109510000_phase_tip_window_deferral_columns.sql b/supabase/migrations/rollback/rollback_20261109510000_phase_tip_window_deferral_columns.sql
new file mode 100644
index 00000000..0292be50
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109510000_phase_tip_window_deferral_columns.sql
@@ -0,0 +1,7 @@
+-- Rollback tip window deferral columns (additive reverse).
+
+DROP INDEX IF EXISTS public.idx_trips_tip_window_expiry_open;
+
+ALTER TABLE public.trips
+  DROP COLUMN IF EXISTS tip_window_opened_at,
+  DROP COLUMN IF EXISTS tip_window_status;
diff --git a/supabase/migrations/rollback/rollback_20261109530000_phase_tip_window_expiry_authorised_spelling.sql b/supabase/migrations/rollback/rollback_20261109530000_phase_tip_window_expiry_authorised_spelling.sql
new file mode 100644
index 00000000..7dbe32c4
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109530000_phase_tip_window_expiry_authorised_spelling.sql
@@ -0,0 +1,27 @@
+-- Rollback tip-expiry authorised spelling expansion (restoreores prior has_work body).
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.provider_order_id IS NOT NULL
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND t.payment_status IN (
+        'preauth_created',
+        'preauth_authorized',
+        'authorized',
+        'preauth_updated',
+        'capture_requested',
+        'capture_failed'
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/rollback/rollback_20261109540000_phase_tip_window_expiry_has_work_finalised_close.sql b/supabase/migrations/rollback/rollback_20261109540000_phase_tip_window_expiry_has_work_finalised_close.sql
new file mode 100644
index 00000000..23857495
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109540000_phase_tip_window_expiry_has_work_finalised_close.sql
@@ -0,0 +1,29 @@
+-- Restore has_work to uncapped-only (20261109530000).
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.provider_order_id IS NOT NULL
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND t.payment_status IN (
+        'preauth_created',
+        'preauth_authorized',
+        'preauth_authorised',
+        'authorized',
+        'authorised',
+        'preauth_updated',
+        'capture_requested',
+        'capture_failed'
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/rollback/rollback_20261109550000_phase_tip_window_expiry_has_work_payment_intent.sql b/supabase/migrations/rollback/rollback_20261109550000_phase_tip_window_expiry_has_work_payment_intent.sql
new file mode 100644
index 00000000..71e1c78c
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109550000_phase_tip_window_expiry_has_work_payment_intent.sql
@@ -0,0 +1,34 @@
+-- Restore has_work to provider_order_id-only uncapped gate (20261109540000).
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND (
+        (
+          t.provider_order_id IS NOT NULL
+          AND t.payment_status IN (
+            'preauth_created',
+            'preauth_authorized',
+            'preauth_authorised',
+            'authorized',
+            'authorised',
+            'preauth_updated',
+            'capture_requested',
+            'capture_failed'
+          )
+        )
+        OR t.payment_status IN ('captured', 'paid', 'collected_cash')
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/rollback/rollback_20261109560000_phase_tip_window_column_write_lock.sql b/supabase/migrations/rollback/rollback_20261109560000_phase_tip_window_column_write_lock.sql
new file mode 100644
index 00000000..c0dcb918
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109560000_phase_tip_window_column_write_lock.sql
@@ -0,0 +1,2 @@
+DROP TRIGGER IF EXISTS trg_guard_trip_tip_window_columns ON public.trips;
+DROP FUNCTION IF EXISTS public.guard_trip_tip_window_columns();
diff --git a/supabase/migrations/rollback/rollback_20261109570000_phase_tip_window_expiry_has_work_shortfall_retry.sql b/supabase/migrations/rollback/rollback_20261109570000_phase_tip_window_expiry_has_work_shortfall_retry.sql
new file mode 100644
index 00000000..c521b3dc
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109570000_phase_tip_window_expiry_has_work_shortfall_retry.sql
@@ -0,0 +1,34 @@
+-- Restore has_work without payment_shortfall / recovery_required (20261109550000).
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND (
+        (
+          (t.provider_order_id IS NOT NULL OR t.payment_intent_id IS NOT NULL)
+          AND t.payment_status IN (
+            'preauth_created',
+            'preauth_authorized',
+            'preauth_authorised',
+            'authorized',
+            'authorised',
+            'preauth_updated',
+            'capture_requested',
+            'capture_failed'
+          )
+        )
+        OR t.payment_status IN ('captured', 'paid', 'collected_cash')
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/rollback/rollback_20261109580000_phase_tip_refund_reverses_captured_tip.sql b/supabase/migrations/rollback/rollback_20261109580000_phase_tip_refund_reverses_captured_tip.sql
new file mode 100644
index 00000000..e6ea1030
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109580000_phase_tip_refund_reverses_captured_tip.sql
@@ -0,0 +1,344 @@
+-- Restore net-only refund reversal (no DRIVER_TIP_CREDIT clawback).
+
+CREATE OR REPLACE FUNCTION public.apply_confirmed_provider_refund_atomic(
+  p_trip_id uuid,
+  p_payment_provider text,
+  p_provider_refund_id text,
+  p_event_refund_amount_pence integer,
+  p_cumulative_refunded_pence integer,
+  p_provider_order_id text DEFAULT NULL,
+  p_provider_payment_id text DEFAULT NULL,
+  p_refund_reason text DEFAULT NULL,
+  p_source text DEFAULT 'admin_refund',
+  p_skip_driver_wallet_reversal boolean DEFAULT false
+)
+RETURNS jsonb
+LANGUAGE plpgsql
+SECURITY DEFINER
+SET search_path TO 'pg_catalog'
+AS $function$
+DECLARE
+  v_trip public.trips%ROWTYPE;
+  v_ps public.payment_sessions%ROWTYPE;
+  v_rb_count integer;
+  v_captured_pence integer;
+  v_commission_pence integer;
+  v_driver_net_pence integer;
+  v_now timestamptz := now();
+  v_child_id uuid;
+  v_existing_child_id uuid;
+  v_existing_debit_id uuid;
+  v_existing_debit_pence integer;
+  v_ps_refunded_sum integer;
+  v_refund_status text;
+  v_payment_status text;
+  v_ratio numeric;
+  v_target_reversal integer;
+  v_authoritative_debit_sum integer;
+  v_missing_reversal integer;
+  v_credited_pence integer;
+  v_insert_debit_pence integer;
+  v_ledger_id uuid;
+  v_net_captured integer;
+  v_adjusted_commission integer;
+  v_adjusted_driver_net integer;
+BEGIN
+  IF p_trip_id IS NULL THEN
+    RAISE EXCEPTION 'trip_id_required' USING ERRCODE = 'invalid_parameter_value';
+  END IF;
+
+  IF p_provider_refund_id IS NULL OR btrim(p_provider_refund_id) = '' THEN
+    RAISE EXCEPTION 'provider_refund_id_required' USING ERRCODE = 'invalid_parameter_value';
+  END IF;
+
+  IF p_payment_provider IS NULL OR btrim(p_payment_provider) = '' THEN
+    RAISE EXCEPTION 'payment_provider_required' USING ERRCODE = 'invalid_parameter_value';
+  END IF;
+
+  IF p_event_refund_amount_pence IS NULL OR p_event_refund_amount_pence <= 0 THEN
+    RAISE EXCEPTION 'event_refund_amount_invalid' USING ERRCODE = 'invalid_parameter_value';
+  END IF;
+
+  IF p_cumulative_refunded_pence IS NULL OR p_cumulative_refunded_pence <= 0 THEN
+    RAISE EXCEPTION 'cumulative_refund_amount_invalid' USING ERRCODE = 'invalid_parameter_value';
+  END IF;
+
+  SELECT * INTO v_trip
+  FROM public.trips
+  WHERE id = p_trip_id
+  FOR UPDATE;
+
+  IF NOT FOUND THEN
+    RAISE EXCEPTION 'trip_not_found' USING ERRCODE = 'no_data_found';
+  END IF;
+
+  IF upper(coalesce(v_trip.financial_model::text, '')) = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
+    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION' USING ERRCODE = 'check_violation';
+  END IF;
+
+  IF EXISTS (
+    SELECT 1
+    FROM public.driver_wallet_ledger dwl
+    WHERE dwl.related_trip_id = p_trip_id
+      AND dwl.type = 'REFUND_DEBIT'
+      AND dwl.provider_refund_id IS NULL
+  ) THEN
+    RAISE EXCEPTION 'HISTORICAL_REFUND_DEBIT_REQUIRES_MANUAL_RECONCILIATION'
+      USING ERRCODE = 'check_violation';
+  END IF;
+
+  SELECT count(*)::integer INTO v_rb_count
+  FROM public.payment_sessions ps
+  WHERE ps.trip_id = p_trip_id
+    AND ps.purpose = 'RIDE_BOOKING';
+
+  IF v_rb_count = 0 THEN
+    RAISE EXCEPTION 'PAYMENT_SESSION_MISSING' USING ERRCODE = 'check_violation';
+  END IF;
+
+  IF v_rb_count > 1 THEN
+    RAISE EXCEPTION 'CAPTURE_AMBIGUOUS' USING ERRCODE = 'check_violation';
+  END IF;
+
+  SELECT * INTO v_ps
+  FROM public.payment_sessions ps
+  WHERE ps.trip_id = p_trip_id
+    AND ps.purpose = 'RIDE_BOOKING'
+  FOR UPDATE;
+
+  SELECT id INTO v_existing_child_id
+  FROM public.payment_session_refunds psr
+  WHERE psr.payment_provider = p_payment_provider
+    AND psr.provider_refund_id = p_provider_refund_id;
+
+  SELECT id, abs(dwl.amount_pence)::integer
+    INTO v_existing_debit_id, v_existing_debit_pence
+  FROM public.driver_wallet_ledger dwl
+  WHERE dwl.payment_provider = p_payment_provider
+    AND dwl.provider_refund_id = p_provider_refund_id
+    AND dwl.driver_id = v_trip.driver_id
+    AND dwl.type = 'REFUND_DEBIT';
+
+  IF v_existing_child_id IS NOT NULL AND v_existing_debit_id IS NOT NULL THEN
+    RETURN jsonb_build_object(
+      'status', 'already_applied',
+      'trip_id', p_trip_id,
+      'payment_session_id', v_ps.id,
+      'provider_refund_id', p_provider_refund_id,
+      'refund_child_id', v_existing_child_id,
+      'ledger_debit_id', v_existing_debit_id,
+      'cumulative_refunded_pence', p_cumulative_refunded_pence
+    );
+  END IF;
+
+  v_captured_pence := greatest(
+    0,
+    coalesce(v_trip.capture_amount_pence, v_ps.captured_amount_pence, v_ps.authorised_amount_pence, 0)
+  );
+  v_commission_pence := greatest(0, coalesce(v_trip.commission_pence, 0));
+  v_driver_net_pence := greatest(0, coalesce(v_trip.driver_net_pence, 0));
+
+  IF v_captured_pence <= 0 THEN
+    RAISE EXCEPTION 'captured_amount_missing' USING ERRCODE = 'check_violation';
+  END IF;
+
+  INSERT INTO public.payment_session_refunds (
+    payment_session_id,
+    payment_provider,
+    provider_refund_id,
+    provider_payment_id,
+    amount_pence,
+    currency,
+    status,
+    confirmed_at,
+    metadata
+  ) VALUES (
+    v_ps.id,
+    p_payment_provider,
+    p_provider_refund_id,
+    coalesce(p_provider_payment_id, p_provider_order_id, v_ps.provider_order_id),
+    p_event_refund_amount_pence,
+    lower(coalesce(v_ps.currency, 'gbp')),
+    'confirmed',
+    v_now,
+    jsonb_build_object('source', coalesce(p_source, 'admin_refund'))
+  )
+  ON CONFLICT (payment_provider, provider_refund_id) DO NOTHING
+  RETURNING id INTO v_child_id;
+
+  IF v_child_id IS NULL THEN
+    SELECT id INTO v_child_id
+    FROM public.payment_session_refunds psr
+    WHERE psr.payment_provider = p_payment_provider
+      AND psr.provider_refund_id = p_provider_refund_id;
+  END IF;
+
+  SELECT coalesce(sum(psr.amount_pence), 0)::integer INTO v_ps_refunded_sum
+  FROM public.payment_session_refunds psr
+  WHERE psr.payment_session_id = v_ps.id
+    AND psr.amount_pence > 0;
+
+  IF v_ps_refunded_sum <> p_cumulative_refunded_pence THEN
+    RAISE EXCEPTION 'cumulative_refund_mismatch: expected % got %',
+      p_cumulative_refunded_pence, v_ps_refunded_sum
+      USING ERRCODE = 'check_violation';
+  END IF;
+
+  IF p_cumulative_refunded_pence >= v_captured_pence THEN
+    v_refund_status := 'refunded';
+    v_payment_status := 'refunded';
+  ELSE
+    v_refund_status := 'partially_refunded';
+    v_payment_status := 'partially_refunded';
+  END IF;
+
+  v_net_captured := greatest(0, v_captured_pence - p_cumulative_refunded_pence);
+  v_ratio := v_net_captured::numeric / v_captured_pence::numeric;
+  v_adjusted_commission := greatest(0, round(v_commission_pence * v_ratio)::integer);
+  v_adjusted_driver_net := greatest(0, round(v_driver_net_pence * v_ratio)::integer);
+  v_target_reversal := greatest(0, v_driver_net_pence - v_adjusted_driver_net);
+
+  SELECT coalesce(sum(abs(dwl.amount_pence)), 0)::integer INTO v_authoritative_debit_sum
+  FROM public.driver_wallet_ledger dwl
+  WHERE dwl.related_trip_id = p_trip_id
+    AND dwl.type = 'REFUND_DEBIT'
+    AND dwl.provider_refund_id IS NOT NULL;
+
+  v_missing_reversal := greatest(0, v_target_reversal - v_authoritative_debit_sum);
+  v_insert_debit_pence := 0;
+
+  IF v_missing_reversal > 0
+     AND NOT coalesce(p_skip_driver_wallet_reversal, false)
+     AND v_trip.driver_id IS NOT NULL
+     AND v_existing_debit_id IS NULL THEN
+    SELECT coalesce(sum(greatest(0, dwl.amount_pence)), 0)::integer INTO v_credited_pence
+    FROM public.driver_wallet_ledger dwl
+    WHERE dwl.driver_id = v_trip.driver_id
+      AND dwl.related_trip_id = p_trip_id
+      AND dwl.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT');
+
+    IF v_credited_pence > 0 THEN
+      v_insert_debit_pence := least(v_credited_pence - v_authoritative_debit_sum, v_missing_reversal);
+      v_insert_debit_pence := greatest(0, v_insert_debit_pence);
+    ELSE
+      v_insert_debit_pence := v_missing_reversal;
+    END IF;
+
+    IF v_insert_debit_pence > 0 THEN
+      INSERT INTO public.driver_wallet_ledger (
+        driver_id,
+        related_trip_id,
+        type,
+        amount_pence,
+        currency,
+        description,
+        payment_provider,
+        provider_refund_id
+      ) VALUES (
+        v_trip.driver_id,
+        p_trip_id,
+        'REFUND_DEBIT',
+        -v_insert_debit_pence,
+        coalesce(v_trip.currency, 'GBP'),
+        format('provider refund reversal (%s) — %s', p_provider_refund_id, coalesce(p_source, 'admin_refund')),
+        p_payment_provider,
+        p_provider_refund_id
+      )
+      RETURNING id INTO v_ledger_id;
+    END IF;
+  ELSIF v_existing_debit_id IS NOT NULL THEN
+    v_ledger_id := v_existing_debit_id;
+  END IF;
+
+  UPDATE public.payment_sessions
+  SET
+    refunded_amount_pence = v_ps_refunded_sum,
+    refunded_at = v_now,
+    provider_refund_id = p_provider_refund_id,
+    updated_at = v_now
+  WHERE id = v_ps.id;
+
+  UPDATE public.trips
+  SET
+    payment_status = v_payment_status,
+    refund_amount_pence = p_cumulative_refunded_pence,
+    refunded_at = v_now,
+    updated_at = v_now,
+    refund_reason = coalesce(p_refund_reason, refund_reason)
+  WHERE id = p_trip_id;
+
+  UPDATE public.payments pay
+  SET
+    status = v_payment_status,
+    refunded_amount_pence = p_cumulative_refunded_pence,
+    refund_status = v_refund_status,
+    refunded_at = v_now,
+    updated_at = v_now,
+    provider_refund_id = p_provider_refund_id,
+    last_error = format('provider_refund:%s:%s', p_provider_refund_id, p_cumulative_refunded_pence)
+  WHERE pay.trip_id = p_trip_id;
+
+  UPDATE public.trip_finance tf
+  SET
+    refund_amount_pence = p_cumulative_refunded_pence,
+    refund_status = v_refund_status,
+    net_card_revenue_after_refund_pence = v_net_captured,
+    driver_wallet_reversal_pence = v_target_reversal,
+    commission_reversal_pence = greatest(0, v_commission_pence - v_adjusted_commission),
+    financial_status = CASE WHEN v_refund_status = 'refunded' THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
+    updated_at = v_now
+  WHERE tf.trip_id = p_trip_id;
+
+  RETURN jsonb_build_object(
+    'status', 'applied',
+    'trip_id', p_trip_id,
+    'payment_session_id', v_ps.id,
+    'provider_refund_id', p_provider_refund_id,
+    'refund_child_id', v_child_id,
+    'ledger_debit_id', v_ledger_id,
+    'cumulative_refunded_pence', p_cumulative_refunded_pence,
+    'target_driver_reversal_pence', v_target_reversal,
+    'authoritative_debit_sum_pence', v_authoritative_debit_sum + coalesce(v_insert_debit_pence, 0),
+    'inserted_debit_pence', coalesce(v_insert_debit_pence, 0),
+    'payment_status', v_payment_status,
+    'refund_status', v_refund_status
+  );
+
+EXCEPTION
+  WHEN unique_violation THEN
+    SELECT id INTO v_existing_child_id
+    FROM public.payment_session_refunds psr
+    WHERE psr.payment_provider = p_payment_provider
+      AND psr.provider_refund_id = p_provider_refund_id;
+
+    SELECT id, abs(dwl.amount_pence)::integer
+      INTO v_existing_debit_id, v_existing_debit_pence
+    FROM public.driver_wallet_ledger dwl
+    WHERE dwl.payment_provider = p_payment_provider
+      AND dwl.provider_refund_id = p_provider_refund_id
+      AND dwl.driver_id = v_trip.driver_id
+      AND dwl.type = 'REFUND_DEBIT';
+
+    SELECT coalesce(sum(psr.amount_pence), 0)::integer INTO v_ps_refunded_sum
+    FROM public.payment_session_refunds psr
+    WHERE psr.payment_session_id = v_ps.id
+      AND psr.amount_pence > 0;
+
+    IF v_existing_child_id IS NOT NULL
+       AND v_existing_debit_id IS NOT NULL
+       AND v_ps_refunded_sum = p_cumulative_refunded_pence THEN
+      RETURN jsonb_build_object(
+        'status', 'already_applied',
+        'trip_id', p_trip_id,
+        'payment_session_id', v_ps.id,
+        'provider_refund_id', p_provider_refund_id,
+        'refund_child_id', v_existing_child_id,
+        'ledger_debit_id', v_existing_debit_id,
+        'cumulative_refunded_pence', p_cumulative_refunded_pence,
+        'recovered_from', 'unique_violation'
+      );
+    END IF;
+
+    RAISE;
+END;
+$function$;
diff --git a/supabase/migrations/rollback/rollback_20261109590000_phase_tip_retire_legacy_completion_triggers.sql b/supabase/migrations/rollback/rollback_20261109590000_phase_tip_retire_legacy_completion_triggers.sql
new file mode 100644
index 00000000..a9053c64
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109590000_phase_tip_retire_legacy_completion_triggers.sql
@@ -0,0 +1,77 @@
+-- Restore the pre-20261109590000 completion triggers.
+-- These reopen the unpaid tip credit and the 2-minute window. Do not apply unless rolling back.
+
+CREATE OR REPLACE FUNCTION public.set_tip_window_on_completion()
+RETURNS trigger
+LANGUAGE plpgsql
+SECURITY DEFINER
+SET search_path TO 'public'
+AS $function$
+DECLARE
+  v_tips_enabled boolean := false;
+BEGIN
+  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
+    NEW.completed_at := COALESCE(NEW.completed_at, now());
+
+    IF NEW.service_area_id IS NOT NULL THEN
+      SELECT COALESCE(sa.tips_enabled, false)
+      INTO v_tips_enabled
+      FROM public.service_areas sa
+      WHERE sa.id = NEW.service_area_id;
+    END IF;
+
+    IF v_tips_enabled THEN
+      NEW.tip_window_expires_at := NEW.completed_at + interval '2 minutes';
+    ELSE
+      NEW.tip_window_expires_at := NEW.completed_at;
+      NEW.tip_window_closed_at := COALESCE(NEW.tip_window_closed_at, NEW.completed_at);
+    END IF;
+  END IF;
+
+  RETURN NEW;
+END;
+$function$;
+
+CREATE OR REPLACE FUNCTION public.handle_tip_added()
+RETURNS trigger
+LANGUAGE plpgsql
+SECURITY DEFINER
+SET search_path TO 'public'
+AS $function$
+DECLARE
+  v_tip_diff integer;
+BEGIN
+  IF NEW.status != 'completed' THEN
+    RETURN NEW;
+  END IF;
+
+  v_tip_diff := COALESCE(NEW.tip_amount_pence, 0) - COALESCE(OLD.tip_amount_pence, 0);
+
+  IF v_tip_diff = 0 THEN
+    RETURN NEW;
+  END IF;
+
+  NEW.driver_net_before_tip_pence := COALESCE(NEW.driver_net_pence, 0);
+  NEW.driver_total_earnings_pence := COALESCE(NEW.driver_net_pence, 0) + COALESCE(NEW.tip_amount_pence, 0);
+
+  IF v_tip_diff > 0 AND NEW.driver_id IS NOT NULL THEN
+    INSERT INTO public.driver_wallet_ledger (
+      driver_id,
+      related_trip_id,
+      type,
+      amount_pence,
+      currency,
+      description
+    ) VALUES (
+      NEW.driver_id,
+      NEW.id,
+      'DRIVER_TIP_CREDIT',
+      v_tip_diff,
+      'GBP',
+      'Tip from passenger (£' || (v_tip_diff / 100.0)::text || ')'
+    );
+  END IF;
+
+  RETURN NEW;
+END;
+$function$;
diff --git a/supabase/migrations/rollback/rollback_20261109600000_phase_tip_window_expiry_has_work_session_order.sql b/supabase/migrations/rollback/rollback_20261109600000_phase_tip_window_expiry_has_work_session_order.sql
new file mode 100644
index 00000000..b8c8ec57
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109600000_phase_tip_window_expiry_has_work_session_order.sql
@@ -0,0 +1,36 @@
+-- Restore has_work without payment_session_id (20261109570000).
+
+CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
+ RETURNS boolean
+ LANGUAGE sql
+ STABLE SECURITY DEFINER
+ SET search_path TO 'public'
+AS $function$
+  SELECT EXISTS (
+    SELECT 1
+    FROM public.trips t
+    WHERE t.status = 'completed'
+      AND t.tip_window_expires_at IS NOT NULL
+      AND t.tip_window_expires_at < now()
+      AND t.tip_window_closed_at IS NULL
+      AND (
+        (
+          (t.provider_order_id IS NOT NULL OR t.payment_intent_id IS NOT NULL)
+          AND t.payment_status IN (
+            'preauth_created',
+            'preauth_authorized',
+            'preauth_authorised',
+            'authorized',
+            'authorised',
+            'preauth_updated',
+            'capture_requested',
+            'capture_failed',
+            'payment_shortfall',
+            'recovery_required'
+          )
+        )
+        OR t.payment_status IN ('captured', 'paid', 'collected_cash')
+      )
+    LIMIT 1
+  );
+$function$;
diff --git a/supabase/migrations/rollback/rollback_20261109610000_whatsapp_guest_auth_user_id_by_exact_phone.sql b/supabase/migrations/rollback/rollback_20261109610000_whatsapp_guest_auth_user_id_by_exact_phone.sql
new file mode 100644
index 00000000..cf5b74fe
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109610000_whatsapp_guest_auth_user_id_by_exact_phone.sql
@@ -0,0 +1 @@
+DROP FUNCTION IF EXISTS public.auth_user_id_by_exact_phone(text);
diff --git a/supabase/migrations/rollback/rollback_20261109620000_customer_phone_allows_same_user_driver.sql b/supabase/migrations/rollback/rollback_20261109620000_customer_phone_allows_same_user_driver.sql
new file mode 100644
index 00000000..a0987e21
--- /dev/null
+++ b/supabase/migrations/rollback/rollback_20261109620000_customer_phone_allows_same_user_driver.sql
@@ -0,0 +1,29 @@
+CREATE OR REPLACE FUNCTION public.enforce_customer_identity_uniqueness()
+RETURNS trigger
+LANGUAGE plpgsql
+SECURITY DEFINER
+SET search_path TO 'public'
+AS $function$
+DECLARE
+  v_phone text := nullif(trim(new.phone), '');
+BEGIN
+  IF new.deleted_at IS NOT NULL THEN
+    RETURN new;
+  END IF;
+
+  IF v_phone IS NOT NULL THEN
+    IF EXISTS (
+      SELECT 1 FROM public.drivers d
+      WHERE d.phone = v_phone
+        AND d.deleted_at IS NULL
+        AND (tg_op = 'INSERT' OR d.user_id IS DISTINCT FROM new.user_id)
+    ) THEN
+      RAISE EXCEPTION 'phone_already_in_use'
+        USING errcode = '23505',
+              hint = 'This phone number is already linked to a driver account.';
+    END IF;
+  END IF;
+
+  RETURN new;
+END;
+$function$;
diff --git a/supabase/tests/phase_a8b28_can_corporate_user_view_driver_self_bind_verify.sql b/supabase/tests/phase_a8b28_can_corporate_user_view_driver_self_bind_verify.sql
new file mode 100644
index 00000000..5f478e7e
--- /dev/null
+++ b/supabase/tests/phase_a8b28_can_corporate_user_view_driver_self_bind_verify.sql
@@ -0,0 +1,168 @@
+-- Phase A8B28 body simulation. Applies the draft body, probes, then ROLLBACK.
+-- Disposable JWT claim config and synthetic UUIDs only. Does not print real identities.
+-- Does not invoke cleanup_photos / expire_chats / notifications / finance.
+
+BEGIN;
+RESET ROLE;
+
+CREATE TEMP TABLE a8b28_before AS
+SELECT
+  p.proname,
+  pg_get_function_identity_arguments(p.oid) AS args,
+  md5(p.prosrc) AS body_md5,
+  p.proacl::text AS acl,
+  pg_get_viewdef('public.drivers_public_safe'::regclass, true) AS viewdef
+FROM pg_proc p
+JOIN pg_namespace n ON n.oid = p.pronamespace
+WHERE n.nspname = 'public'
+  AND p.proname = 'can_corporate_user_view_driver';
+
+CREATE TEMP TABLE a8b28_counts AS
+SELECT
+  (SELECT count(*)::int FROM public.trips) AS trips,
+  (SELECT count(*)::int FROM public.corporate_user_accounts) AS cua,
+  (SELECT count(*)::int FROM public.drivers) AS drivers,
+  (SELECT count(*)::int FROM public.notifications) AS notifications,
+  (SELECT count(*)::int FROM public.payment_sessions) AS payment_sessions,
+  (SELECT count(*)::int FROM pg_proc x JOIN pg_namespace n ON n.oid = x.pronamespace
+    WHERE n.nspname = 'public' AND x.prosecdef
+      AND has_function_privilege('authenticated', x.oid, 'EXECUTE')) AS auth_secdef,
+  (SELECT count(*)::int FROM pg_proc x JOIN pg_namespace n ON n.oid = x.pronamespace
+    WHERE n.nspname = 'public' AND x.prosecdef
+      AND has_function_privilege('anon', x.oid, 'EXECUTE')) AS anon_secdef;
+
+DO $pre$
+DECLARE
+  v_baseline text;
+BEGIN
+  SELECT body_md5 INTO v_baseline FROM a8b28_before;
+  IF v_baseline IS DISTINCT FROM 'b000bb084232102300009c2a03d9bcb0' THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: baseline md5=%', v_baseline;
+  END IF;
+END $pre$;
+
+CREATE OR REPLACE FUNCTION public.can_corporate_user_view_driver(p_driver_id uuid, p_user_id uuid)
+RETURNS boolean
+LANGUAGE sql
+STABLE
+SECURITY DEFINER
+SET search_path TO 'public'
+AS $function$
+  SELECT
+    auth.uid() IS NOT NULL
+    AND p_user_id IS NOT DISTINCT FROM auth.uid()
+    AND EXISTS (
+      SELECT 1
+      FROM trips t
+      JOIN corporate_user_accounts cua ON cua.corporate_account_id = t.corporate_account_id
+      WHERE t.driver_id = p_driver_id
+        AND cua.user_id = p_user_id
+        AND COALESCE(t.status, '') NOT IN ('cancelled', 'completed')
+    )
+$function$;
+
+DO $simulate$
+DECLARE
+  v_proposed text;
+  v_uid uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
+  v_foreign uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
+  v_driver uuid := 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
+  v_r boolean;
+  v_auth int;
+  v_view text;
+BEGIN
+  SELECT md5(p.prosrc) INTO v_proposed
+  FROM pg_proc p
+  JOIN pg_namespace n ON n.oid = p.pronamespace
+  WHERE n.nspname = 'public'
+    AND p.proname = 'can_corporate_user_view_driver';
+
+  IF v_proposed IS DISTINCT FROM '80c738f1ab36c17174bcc98a8416855c' THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: proposed md5=%', v_proposed;
+  END IF;
+
+  -- no JWT
+  PERFORM set_config('request.jwt.claim.sub', '', true);
+  PERFORM set_config('request.jwt.claims', '{}', true);
+  v_r := public.can_corporate_user_view_driver(v_driver, v_uid);
+  IF v_r IS DISTINCT FROM false THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: no JWT expected false';
+  END IF;
+
+  -- authenticated self without membership → false
+  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
+  PERFORM set_config(
+    'request.jwt.claims',
+    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text,
+    true
+  );
+  v_r := public.can_corporate_user_view_driver(v_driver, v_uid);
+  IF v_r IS DISTINCT FROM false THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: self without trip expected false';
+  END IF;
+
+  -- foreign p_user_id under caller JWT → false (self-bind)
+  v_r := public.can_corporate_user_view_driver(v_driver, v_foreign);
+  IF v_r IS DISTINCT FROM false THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: foreign user_id expected false';
+  END IF;
+
+  v_view := pg_get_viewdef('public.drivers_public_safe'::regclass, true);
+  IF v_view IS DISTINCT FROM (SELECT viewdef FROM a8b28_before) THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: drivers_public_safe viewdef changed';
+  END IF;
+  IF v_view !~* 'can_corporate_user_view_driver\(id, auth\.uid\(\)\)' THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: view lost self auth.uid() call';
+  END IF;
+
+  SELECT count(*)::int INTO v_auth
+  FROM pg_proc x
+  JOIN pg_namespace n ON n.oid = x.pronamespace
+  WHERE n.nspname = 'public'
+    AND x.prosecdef
+    AND has_function_privilege('authenticated', x.oid, 'EXECUTE');
+  IF v_auth IS DISTINCT FROM 111 THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: auth_secdef=%', v_auth;
+  END IF;
+
+  IF has_function_privilege(
+       'anon',
+       'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure,
+       'EXECUTE'
+     )
+     OR has_function_privilege(
+       'public',
+       'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure,
+       'EXECUTE'
+     )
+  THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: PUBLIC/anon EXECUTE present';
+  END IF;
+
+  IF NOT has_function_privilege(
+       'authenticated',
+       'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure,
+       'EXECUTE'
+     )
+     OR NOT has_function_privilege(
+       'service_role',
+       'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure,
+       'EXECUTE'
+     )
+  THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: authenticated/service_role EXECUTE missing';
+  END IF;
+
+  IF EXISTS (
+    SELECT 1 FROM supabase_migrations.schema_migrations
+    WHERE version = '20261109420000'
+  ) THEN
+    RAISE EXCEPTION 'A8B28 SIM HARD STOP: migration version unexpectedly present';
+  END IF;
+
+  RAISE NOTICE 'A8B28_SIM_OK';
+END $simulate$;
+
+SELECT 'A8B28_SIM_OK' AS status;
+
+ROLLBACK;
