#!/usr/bin/env bash
# #110 P3 — LOCAL ONLY: completion-shaped UPDATE costs with 52 production-equivalent
# trips UPDATE triggers. Measures P2 tip-column skip vs full tip re-stamp vs atomic.
# Never points at production.
set -euo pipefail
HOST="${PGHOST:-127.0.0.1}"
case "$HOST" in 127.0.0.1|localhost) ;; *) echo "REFUSED: host=$HOST"; exit 2 ;; esac
PORT="${PGPORT:-54329}"
USER="${PGUSER:-postgres}"
DB="${PGDATABASE:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
ITERS="${ITERS:-20}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL=(psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1)

# Ensure parity + body sync + draft RPC
bash "$ROOT/supabase/tests/trips_update_trigger_parity_110_local.sh" >/dev/null
"${PSQL[@]}" -q -f "$ROOT/supabase/tests/trips_update_trigger_fn_body_sync_110_local.sql"
"${PSQL[@]}" -q -f "$ROOT/supabase/migrations/_draft_review_only/DRAFT_complete_trip_atomic_v1.sql"

"${PSQL[@]}" -At <<SQL
SELECT 'trigger_inventory=' || count(*)
  || ' unconditional=' || count(*) FILTER (WHERE pg_get_triggerdef(t.oid) !~* 'WHEN \(')
  || ' conditional=' || count(*) FILTER (WHERE pg_get_triggerdef(t.oid) ~* 'WHEN \(')
FROM pg_trigger t
WHERE t.tgrelid='public.trips'::regclass AND NOT t.tgisinternal
  AND pg_get_triggerdef(t.oid) ILIKE '%UPDATE%';
SQL

DRIVER_ID=$("${PSQL[@]}" -Atc "select id from public.drivers order by created_at limit 1")
SESSION_ID=$("${PSQL[@]}" -Atq <<'SQL'
INSERT INTO public.payment_sessions (client_action_id, user_id, service_area_id, status, provider_state,
  authorised_amount_pence, currency, idempotency_key)
SELECT 'F110-P3-COST-SESSION', gen_random_uuid(), (SELECT id FROM public.service_areas LIMIT 1),
  'authorised_hold', 'AUTHORISED', 1000, 'gbp', 'F110-P3-COST-SESSION'
ON CONFLICT (client_action_id) DO UPDATE SET provider_state = 'AUTHORISED'
RETURNING id;
SQL
)

"${PSQL[@]}" -q <<SQL
SET session_replication_role = replica;
DELETE FROM public.driver_wallet_ledger
 WHERE related_trip_id IN (SELECT id FROM public.trips WHERE pickup_address = 'F110-P3-COST');
DELETE FROM public.trips WHERE pickup_address = 'F110-P3-COST';
SET session_replication_role = DEFAULT;
SQL

echo "=== completion-shaped wall times (n=$ITERS) ==="
"${PSQL[@]}" <<SQL
DO \$\$
DECLARE
  i int;
  t0 timestamptz; t1 timestamptz; ms numeric;
  a_total numeric := 0; a_max numeric := 0;
  b_total numeric := 0; b_max numeric := 0;
  c_total numeric := 0; c_max numeric := 0;
  d_total numeric := 0; d_max numeric := 0;
  tid uuid;
  d uuid := '$DRIVER_ID';
  sid uuid := '$SESSION_ID';
  opened timestamptz;
  expires timestamptz;
  settle jsonb := '{"final_fare_pence":1000,"commissionable_fare_pence":1000,"commission_pence":200,"driver_net_pence":800,"driver_net_before_tip_pence":800,"driver_total_earnings_pence":800,"airport_charge_pence":0,"tip_pence":0,"tip_amount_pence":0,"commission_pct":20,"driver_tier_commission_percent":20,"gross_fare_pence":1000,"provider_fee_pence":null,"onecab_net_pence":200,"platform_gross_revenue_pence":200,"platform_net_revenue_pence":200,"settlement_formula_version":"fixture-110"}'::jsonb;
  comp jsonb := '{"fare":10.00,"estimated_fare":10.00,"final_fare_pence":1000,"final_customer_fare_pence":1000,"pickup_waiting_charge_pence":0,"stop_waiting_charge_pence":0,"stop_charge_total_pence":0,"total_waiting_charge_pence":0,"waiting_charge_pence":0}'::jsonb;
  r jsonb;
  n int := $ITERS;
BEGIN
  FOR i IN 1..n LOOP
    -- Seed in_progress PC trip
    INSERT INTO public.trips (
      passenger_id, pickup_address, dropoff_address, status, dispatch_status, started_at,
      driver_id, confirmed_driver_id, financial_model, payment_method, payment_status,
      final_fare_pence, payment_session_id
    ) VALUES (
      gen_random_uuid(), 'F110-P3-COST', 'dest', 'in_progress', 'in_progress', now() - interval '10 minutes',
      d, d, 'PLATFORM_COLLECTED', 'card', 'authorised', 1000, sid
    ) RETURNING id INTO tid;

    opened := clock_timestamp();
    expires := opened + interval '20 minutes';

    -- A: completion UPDATE with tip window (first write)
    t0 := clock_timestamp();
    UPDATE public.trips SET
      status = 'completed',
      dispatch_status = 'completed',
      completed_at = opened,
      final_fare_pence = 1000,
      final_customer_fare_pence = 1000,
      tip_window_opened_at = opened,
      tip_window_expires_at = expires,
      tip_window_status = 'open',
      tip_window_closed_at = null,
      updated_at = clock_timestamp()
    WHERE id = tid;
    t1 := clock_timestamp();
    ms := EXTRACT(EPOCH FROM (t1 - t0)) * 1000;
    a_total := a_total + ms; IF ms > a_max THEN a_max := ms; END IF;

    -- B: settlement UPDATE WITH tip_window rewrite (pre-P2 redundant)
    t0 := clock_timestamp();
    UPDATE public.trips SET
      commissionable_fare_pence = 1000,
      commission_pence = 200,
      driver_net_pence = 800,
      tip_window_opened_at = opened,
      tip_window_expires_at = expires,
      tip_window_status = 'open',
      tip_window_closed_at = null,
      updated_at = clock_timestamp()
    WHERE id = tid;
    t1 := clock_timestamp();
    ms := EXTRACT(EPOCH FROM (t1 - t0)) * 1000;
    b_total := b_total + ms; IF ms > b_max THEN b_max := ms; END IF;

    -- Reset tip columns change detection: touch settlement without tip cols (P2)
    -- Use a fresh trip for fair C measurement
    DELETE FROM public.trips WHERE id = tid;
    INSERT INTO public.trips (
      passenger_id, pickup_address, dropoff_address, status, dispatch_status, started_at,
      driver_id, confirmed_driver_id, financial_model, payment_method, payment_status,
      final_fare_pence, payment_session_id
    ) VALUES (
      gen_random_uuid(), 'F110-P3-COST', 'dest', 'in_progress', 'in_progress', now() - interval '10 minutes',
      d, d, 'PLATFORM_COLLECTED', 'card', 'authorised', 1000, sid
    ) RETURNING id INTO tid;
    opened := clock_timestamp();
    expires := opened + interval '20 minutes';
    UPDATE public.trips SET
      status = 'completed', dispatch_status = 'completed', completed_at = opened,
      final_fare_pence = 1000, final_customer_fare_pence = 1000,
      tip_window_opened_at = opened, tip_window_expires_at = expires,
      tip_window_status = 'open', tip_window_closed_at = null,
      updated_at = clock_timestamp()
    WHERE id = tid;

    -- C: settlement UPDATE WITHOUT tip_window columns (P2 skip)
    t0 := clock_timestamp();
    UPDATE public.trips SET
      commissionable_fare_pence = 1000,
      commission_pence = 200,
      driver_net_pence = 800,
      updated_at = clock_timestamp()
    WHERE id = tid;
    t1 := clock_timestamp();
    ms := EXTRACT(EPOCH FROM (t1 - t0)) * 1000;
    c_total := c_total + ms; IF ms > c_max THEN c_max := ms; END IF;

    -- D: atomic RPC on a fresh in_progress trip
    DELETE FROM public.trips WHERE id = tid;
    INSERT INTO public.trips (
      passenger_id, pickup_address, dropoff_address, status, dispatch_status, started_at,
      driver_id, confirmed_driver_id, financial_model, payment_method, payment_status,
      final_fare_pence, payment_session_id
    ) VALUES (
      gen_random_uuid(), 'F110-P3-COST', 'dest', 'in_progress', 'in_progress', now() - interval '10 minutes',
      d, d, 'PLATFORM_COLLECTED', 'card', 'authorised', 1000, sid
    ) RETURNING id INTO tid;
    t0 := clock_timestamp();
    r := public.complete_trip_atomic_v1(
      tid, d, clock_timestamp(), comp, settle, true, 'tip_window_defer', 'GBP'
    );
    t1 := clock_timestamp();
    IF COALESCE((r->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'atomic failed: %', r;
    END IF;
    ms := EXTRACT(EPOCH FROM (t1 - t0)) * 1000;
    d_total := d_total + ms; IF ms > d_max THEN d_max := ms; END IF;

    -- Cleanup ledger for this trip so next iter is clean
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.driver_wallet_ledger WHERE related_trip_id = tid;
    DELETE FROM public.trips WHERE id = tid;
  END LOOP;

  RAISE NOTICE 'A_completion_with_tip_window n=% mean_ms=% max_ms=%', n, round(a_total/n,2), round(a_max,2);
  RAISE NOTICE 'B_settlement_WITH_tip_rewrite n=% mean_ms=% max_ms=%', n, round(b_total/n,2), round(b_max,2);
  RAISE NOTICE 'C_settlement_WITHOUT_tip_cols_P2 n=% mean_ms=% max_ms=%', n, round(c_total/n,2), round(c_max,2);
  RAISE NOTICE 'D_atomic_rpc n=% mean_ms=% max_ms=%', n, round(d_total/n,2), round(d_max,2);
  RAISE NOTICE 'P2_tip_skip_delta_B_minus_C_mean_ms=%', round((b_total-c_total)/n,2);
  RAISE NOTICE 'legacy_A_plus_B_mean_ms=% atomic_D_mean_ms=%', round((a_total+b_total)/n,2), round(d_total/n,2);
END \$\$;
SQL

# Cleanup
"${PSQL[@]}" -q <<'SQL'
SET session_replication_role = replica;
DELETE FROM public.driver_wallet_ledger
 WHERE related_trip_id IN (SELECT id FROM public.trips WHERE pickup_address = 'F110-P3-COST');
DELETE FROM public.trips WHERE pickup_address = 'F110-P3-COST';
DELETE FROM public.payment_sessions WHERE client_action_id = 'F110-P3-COST-SESSION';
SET session_replication_role = DEFAULT;
SQL
echo "complete_trip_shaped_trigger_cost_110_local COMPLETE — STOP BEFORE PROD atomic cutover"
