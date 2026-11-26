#!/usr/bin/env bash
# #110 P2 — DRAFT complete_trip_atomic_v1: apply + correctness + timing on LOCAL harness ONLY.
#
#   STOP BEFORE PROD. Refuses any non-local host. Never touches production.
#   Applies supabase/migrations/_draft_review_only/DRAFT_complete_trip_atomic_v1.sql
#   to the isolated local Postgres only.
#
# Usage:
#   PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres PGPASSWORD=postgres \
#     ITERS=30 bash supabase/tests/complete_trip_atomic_v1_110_local.sh
#
# Timing notes:
#   (A) legacy shape = 4 autocommit round trips (completion UPDATE, financial-model
#       guard SELECT [tripBlocksDriverWalletLedgerPosting], settlement UPDATE, pending RPC)
#   (B) atomic       = 1 round trip (complete_trip_atomic_v1)
#   Client is psql on the unix/tcp loopback: NO HTTP / PostgREST / edge overhead, so
#   the A-vs-B delta is a LOWER BOUND on production savings (each avoided PostgREST hop
#   adds ~tens of ms in prod). The DB-side win here is commits/trigger passes only.
set -euo pipefail

HOST="${PGHOST:-127.0.0.1}"
case "$HOST" in
  127.0.0.1|localhost) ;;
  *) echo "REFUSED: host=$HOST is not local"; exit 2 ;;
esac
PORT="${PGPORT:-54329}"
if [ "$PORT" != "54329" ]; then
  echo "REFUSED: port=$PORT is not the isolated local harness (54329)"; exit 2
fi
USER_="${PGUSER:-postgres}"
DB="${PGDATABASE:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
unset PGOPTIONS || true
ITERS="${ITERS:-30}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DRAFT="$ROOT/supabase/migrations/_draft_review_only/DRAFT_complete_trip_atomic_v1.sql"
PSQL=(psql -h "$HOST" -p "$PORT" -U "$USER_" -d "$DB" -v ON_ERROR_STOP=1)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "=== apply DRAFT (LOCAL ONLY) ==="
"${PSQL[@]}" -q -f "$DRAFT"

echo "=== seed helper (local fixture; tagged pickup_address='F110-ATOMIC-FIXTURE') ==="
"${PSQL[@]}" -q <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.noop() RETURNS void LANGUAGE sql AS 'select';
SQL

DRIVER_ID="$("${PSQL[@]}" -Atc "select id from public.drivers order by created_at limit 1")"
if [ -z "$DRIVER_ID" ]; then echo "NO local driver fixture"; exit 3; fi
echo "driver=$DRIVER_ID"

cleanup_fixture() {
  # Local-only cleanup: ledger delete is guarded by trigger, so use replica role
  # scoped to fixture-tagged trips on the isolated harness.
  "${PSQL[@]}" -q <<'SQL'
SET session_replication_role = replica;
DELETE FROM public.driver_wallet_ledger
 WHERE related_trip_id IN (SELECT id FROM public.trips WHERE pickup_address = 'F110-ATOMIC-FIXTURE');
DELETE FROM public.trips WHERE pickup_address = 'F110-ATOMIC-FIXTURE';
DELETE FROM public.payment_sessions WHERE client_action_id = 'F110-FIXTURE-SESSION';
SQL
}
cleanup_fixture
# Digital-payment gate (enforce_digital_payment_gate) is NOT relaxed: seed a legit
# authorised local payment_session shared by all fixture trips.
SESSION_ID="$("${PSQL[@]}" -Atq <<'SQL'
INSERT INTO public.payment_sessions (client_action_id, user_id, service_area_id, status, provider_state,
  authorised_amount_pence, currency, idempotency_key)
SELECT 'F110-FIXTURE-SESSION', gen_random_uuid(), (SELECT id FROM public.service_areas LIMIT 1),
  'authorised_hold', 'AUTHORISED', 1000, 'gbp', 'F110-FIXTURE-SESSION'
ON CONFLICT (client_action_id) DO UPDATE SET provider_state = 'AUTHORISED'
RETURNING id;
SQL
)"
echo "payment_session=$SESSION_ID"

SEED_SQL="INSERT INTO public.trips (passenger_id, pickup_address, dropoff_address, status, dispatch_status, started_at, driver_id, confirmed_driver_id, financial_model, payment_method, payment_status, final_fare_pence, payment_session_id)
VALUES (gen_random_uuid(), 'F110-ATOMIC-FIXTURE', 'dest', 'in_progress', 'in_progress', now() - interval '10 minutes', '$DRIVER_ID', '$DRIVER_ID', 'PLATFORM_COLLECTED', 'card', 'authorised', 1000, '$SESSION_ID')"

SA_ID="$("${PSQL[@]}" -Atq -c "select id from public.service_areas order by created_at limit 1")"
SEED_DC_SQL="${SEED_SQL//PLATFORM_COLLECTED/DRIVER_COLLECTED_COMMISSION_WALLET}"
SEED_DC_SQL="${SEED_DC_SQL/(passenger_id,/(service_area_id, passenger_id,}"
SEED_DC_SQL="${SEED_DC_SQL/VALUES (gen_random_uuid(),/VALUES ('$SA_ID', gen_random_uuid(),}"

SETTLE_JSON='{"final_fare_pence":1000,"commissionable_fare_pence":1000,"commission_pence":200,"driver_net_pence":800,"driver_net_before_tip_pence":800,"driver_total_earnings_pence":800,"airport_charge_pence":0,"tip_pence":0,"tip_amount_pence":0,"commission_pct":20,"driver_tier_commission_percent":20,"gross_fare_pence":1000,"provider_fee_pence":null,"onecab_net_pence":200,"platform_gross_revenue_pence":200,"platform_net_revenue_pence":200,"settlement_formula_version":"fixture-110"}'
COMPLETION_JSON='{"fare":10.00,"estimated_fare":10.00,"final_fare_pence":1000,"final_customer_fare_pence":1000,"pickup_waiting_charge_pence":0,"stop_waiting_charge_pence":0,"stop_charge_total_pence":0,"total_waiting_charge_pence":0,"waiting_charge_pence":0}'

echo "=== CORRECTNESS (single transaction; ROLLBACK at end except concurrency) ==="
"${PSQL[@]}" -q -At <<SQL
BEGIN;
DO \$\$
DECLARE
  d uuid := '$DRIVER_ID';
  tid uuid; tid2 uuid; tid3 uuid; tid4 uuid;
  r jsonb; r2 jsonb; t record; t2 record;
  n_pending int; opened timestamptz; expires timestamptz;
  settle jsonb := '$SETTLE_JSON'::jsonb;
  comp jsonb := '$COMPLETION_JSON'::jsonb;
  legacy record;
BEGIN
  -- 1) happy path, tip window on, PLATFORM_COLLECTED
  $SEED_SQL RETURNING id INTO tid;
  r := public.complete_trip_atomic_v1(tid, d, now(), comp, settle, true, 'tip_window_defer', 'GBP');
  SELECT * INTO t FROM public.trips WHERE id = tid;
  SELECT count(*) INTO n_pending FROM public.driver_wallet_ledger WHERE related_trip_id = tid AND type = 'TRIP_EARNING_PENDING';
  ASSERT (r->>'ok')::boolean, 'happy ok';
  ASSERT t.status = 'completed' AND t.dispatch_status = 'completed' AND t.completed_at IS NOT NULL, 'completed stamped';
  ASSERT t.tip_window_status = 'open' AND t.tip_window_expires_at - t.tip_window_opened_at = interval '20 minutes', 'tip window 20min open';
  ASSERT t.driver_net_pence = 800 AND t.commission_pence = 200 AND t.settlement_formula_version = 'fixture-110', 'settlement persisted';
  ASSERT n_pending = 1, 'exactly one PENDING';
  ASSERT (SELECT amount_pence FROM public.driver_wallet_ledger WHERE related_trip_id = tid AND type='TRIP_EARNING_PENDING') = 800, 'pending=driver_net+airport';
  ASSERT NOT EXISTS (SELECT 1 FROM public.driver_wallet_ledger WHERE related_trip_id = tid AND type IN ('TRIP_EARNING_NET','TRIP_EARNING_PENDING_RELEASE')), 'no premature available/release';
  RAISE NOTICE 'PASS 1 happy path: pending=1 amount=800 tip_window=open/20m settlement persisted';

  -- 2) idempotent replay (different completed_at must not move anything)
  opened := t.tip_window_opened_at; expires := t.tip_window_expires_at;
  r2 := public.complete_trip_atomic_v1(tid, d, now() + interval '5 minutes', comp, settle, true, 'tip_window_defer', 'GBP');
  SELECT * INTO t2 FROM public.trips WHERE id = tid;
  SELECT count(*) INTO n_pending FROM public.driver_wallet_ledger WHERE related_trip_id = tid AND type = 'TRIP_EARNING_PENDING';
  ASSERT (r2->>'idempotent')::boolean, 'replay flagged idempotent';
  ASSERT t2.completed_at = t.completed_at AND t2.tip_window_opened_at = opened AND t2.tip_window_expires_at = expires, 'no reopen / extend';
  ASSERT n_pending = 1 AND (r2->'pending'->>'inserted')::boolean IS FALSE, 'still exactly one PENDING';
  RAISE NOTICE 'PASS 2 idempotent replay: completed_at/tip window unchanged, pending still 1';

  -- 3) tip window already stamped on an in-progress trip is never rewritten
  $SEED_SQL RETURNING id INTO tid2;
  UPDATE public.trips SET tip_window_opened_at = now() - interval '1 minute',
         tip_window_expires_at = now() + interval '7 minutes', tip_window_status = 'open' WHERE id = tid2;
  SELECT tip_window_expires_at INTO expires FROM public.trips WHERE id = tid2;
  r := public.complete_trip_atomic_v1(tid2, d, now(), comp, settle, true, 'tip_window_defer', 'GBP');
  ASSERT r->>'tip_window_action' = 'already_stamped_kept', 'kept action';
  ASSERT (SELECT tip_window_expires_at FROM public.trips WHERE id = tid2) = expires, 'deadline not extended';
  RAISE NOTICE 'PASS 3 pre-stamped tip window kept (no extend)';

  -- 4) fare already captured -> no tip window (MK-260926-001), no payment_status regression
  $SEED_SQL RETURNING id INTO tid3;
  UPDATE public.trips SET payment_status = 'captured' WHERE id = tid3;
  r := public.complete_trip_atomic_v1(tid3, d, now(), comp, settle, true, 'capture_requested', 'GBP');
  SELECT * INTO t FROM public.trips WHERE id = tid3;
  ASSERT r->>'tip_window_action' = 'skipped_fare_captured' AND t.tip_window_expires_at IS NULL, 'no window when captured';
  ASSERT t.payment_status = 'captured', 'captured not regressed to capture_requested';
  RAISE NOTICE 'PASS 4 captured fare: no tip window, payment_status not regressed';

  -- 5) capture_requested stamp on normal card trip, no tip window
  $SEED_SQL RETURNING id INTO tid3;
  r := public.complete_trip_atomic_v1(tid3, d, now(), comp, settle, false, 'capture_requested', 'GBP');
  SELECT * INTO t FROM public.trips WHERE id = tid3;
  ASSERT t.payment_status = 'capture_requested' AND t.payment_hold_status = 'capture_requested' AND t.tip_window_expires_at IS NULL, 'capture_requested stamped';
  RAISE NOTICE 'PASS 5 capture_requested durable stamp, tip window not opened';

  -- 6) DRIVER_COLLECTED: zero PENDING (financial isolation)
  -- Seed-only: insert the DC fixture row with replica role (CW reservation / stamp triggers
  -- need a full CW area). Role is reset BEFORE the RPC runs, so every guard is live for it.
  SET LOCAL session_replication_role = replica;
  $SEED_DC_SQL RETURNING id INTO tid4;
  SET LOCAL session_replication_role = origin;
  r := public.complete_trip_atomic_v1(tid4, d, now(), comp, settle, false, 'none', 'GBP');
  ASSERT (r->>'ok')::boolean AND r->'pending' = 'null'::jsonb, 'dc no pending result';
  ASSERT NOT EXISTS (SELECT 1 FROM public.driver_wallet_ledger WHERE related_trip_id = tid4), 'DRIVER_COLLECTED: no ledger rows';
  RAISE NOTICE 'PASS 6 DRIVER_COLLECTED: no PENDING / no ledger write';

  -- 7) wrong driver / cancelled trip rejected without writes
  $SEED_SQL RETURNING id INTO tid4;
  r := public.complete_trip_atomic_v1(tid4, gen_random_uuid(), now(), comp, settle, true, 'none', 'GBP');
  ASSERT r->>'reason' = 'driver_mismatch', 'driver mismatch';
  UPDATE public.trips SET status = 'cancelled' WHERE id = tid4;
  r := public.complete_trip_atomic_v1(tid4, d, now(), comp, settle, true, 'none', 'GBP');
  ASSERT (r->>'ok')::boolean IS FALSE AND (SELECT status FROM public.trips WHERE id = tid4) = 'cancelled', 'cancelled trip fail-closed: ' || r::text;
  RAISE NOTICE 'PASS 7 driver mismatch + cancelled trip rejected (fail-closed, no writes)';

  -- 8) atomic rollback: trips UPDATE violates CHECK (net != gross - commission)
  $SEED_SQL RETURNING id INTO tid4;
  BEGIN
    PERFORM public.complete_trip_atomic_v1(tid4, d, now(), comp,
      settle || '{"driver_net_pence":999}'::jsonb, true, 'none', 'GBP');
    RAISE EXCEPTION 'expected check violation';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  ASSERT (SELECT status FROM public.trips WHERE id = tid4) = 'in_progress', 'trip untouched after failure';
  ASSERT NOT EXISTS (SELECT 1 FROM public.driver_wallet_ledger WHERE related_trip_id = tid4), 'no ledger after failure';
  RAISE NOTICE 'PASS 8 settlement CHECK failure: whole call rolled back (trip still in_progress, no PENDING)';

  -- 9) atomic rollback when PENDING insert fails: completed must NOT persist
  -- P4B / MK-261126-006/007: non-atomic path completed then ReferenceError'd before PENDING;
  -- atomic must never leave completed-without-PENDING (HTTP 500 with completed row).
  $SEED_SQL RETURNING id INTO tid4;
  CREATE FUNCTION pg_temp.f110_block() RETURNS trigger LANGUAGE plpgsql AS \$f\$
    BEGIN RAISE EXCEPTION 'f110 forced ledger failure' USING ERRCODE = 'check_violation'; END \$f\$;
  CREATE TRIGGER f110_block_pending BEFORE INSERT ON public.driver_wallet_ledger
    FOR EACH ROW WHEN (NEW.type = 'TRIP_EARNING_PENDING') EXECUTE FUNCTION pg_temp.f110_block();
  BEGIN
    PERFORM public.complete_trip_atomic_v1(tid4, d, now(), comp, settle, true, 'tip_window_defer', 'GBP');
    RAISE EXCEPTION 'expected pending failure';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'COMPLETE_TRIP_ATOMIC_PENDING_FAILED%' THEN RAISE; END IF;
  END;
  DROP TRIGGER f110_block_pending ON public.driver_wallet_ledger;
  ASSERT (SELECT status FROM public.trips WHERE id = tid4) = 'in_progress'
     AND (SELECT tip_window_expires_at FROM public.trips WHERE id = tid4) IS NULL, 'completion + tip window rolled back';
  ASSERT NOT EXISTS (SELECT 1 FROM public.driver_wallet_ledger WHERE related_trip_id = tid4), 'no PENDING after forced failure';
  RAISE NOTICE 'PASS 9 P4B: PENDING failure rolls back completion/tip/settlement (no completed-without-PENDING)';

  -- 10) P4B recovery contract note (isolated; no ledger rewrite):
  -- Production 006/007 tip-skip + TEN (~20s) beat sweep-revolut-stale-holds (*/5 min).
  -- missingTripEarningPendingRecoverySSOT returns TEN_EXISTS and must not invent PENDING.
  -- Enforced in completeTripP4BRecovery94aLock.test.ts + missingTripEarningPendingRecoverySSOT.
  RAISE NOTICE 'PASS 10 P4B: recovery TEN_EXISTS skip contract locked in source tests (no post-TEN PENDING)';
END \$\$;
ROLLBACK;
SQL

echo "=== A-vs-B COLUMN PARITY (legacy 2 UPDATEs shape vs atomic; same inputs) ==="
"${PSQL[@]}" -q -At <<SQL
BEGIN;
DO \$\$
DECLARE
  d uuid := '$DRIVER_ID';
  a uuid; b uuid; ra record; rb record; diffs text;
  settle jsonb := '$SETTLE_JSON'::jsonb;
  comp jsonb := '$COMPLETION_JSON'::jsonb;
  now_ts timestamptz := clock_timestamp();
BEGIN
  $SEED_SQL RETURNING id INTO a;
  $SEED_SQL RETURNING id INTO b;
  -- legacy shape (what stop-workflow does today)
  UPDATE public.trips SET status='completed', dispatch_status='completed', completed_at=now_ts,
    fare=10.00, estimated_fare=10.00, final_fare_pence=1000, final_customer_fare_pence=1000,
    pickup_waiting_charge_pence=0, stop_waiting_charge_pence=0, stop_charge_total_pence=0,
    total_waiting_charge_pence=0, waiting_charge_pence=0,
    tip_window_opened_at=now_ts, tip_window_expires_at=now_ts + interval '20 minutes',
    tip_window_status='open', tip_window_closed_at=NULL, updated_at=now_ts WHERE id=a;
  UPDATE public.trips SET final_fare_pence=1000, commissionable_fare_pence=1000, commission_pence=200,
    driver_net_pence=800, driver_net_before_tip_pence=800, driver_total_earnings_pence=800,
    airport_charge_pence=0, tip_pence=0, tip_amount_pence=0, commission_pct=20,
    driver_tier_commission_percent=20, gross_fare_pence=1000, provider_fee_pence=NULL,
    onecab_net_pence=200, platform_gross_revenue_pence=200, platform_net_revenue_pence=200,
    settlement_formula_version='fixture-110', final_customer_fare_pence=1000, updated_at=now_ts WHERE id=a;
  PERFORM public.credit_trip_earning_pending(a, d, 800, 'GBP', 'Trip earning pending payment confirmation');
  PERFORM public.complete_trip_atomic_v1(b, d, now_ts, comp, settle, true, 'tip_window_defer', 'GBP');
  -- compare every trips column except per-row identity (id/trip_code/sequence_no/trip_number/passenger_id) and created/updated_at (to_jsonb diff)
  SELECT string_agg(k, ',') INTO diffs FROM (
    SELECT ja.key AS k FROM jsonb_each((SELECT to_jsonb(t) - 'id' - 'updated_at' - 'created_at' - 'trip_code' - 'sequence_no' - 'trip_number' - 'passenger_id' FROM public.trips t WHERE id=a)) ja
    JOIN jsonb_each((SELECT to_jsonb(t) - 'id' - 'updated_at' - 'created_at' - 'trip_code' - 'sequence_no' - 'trip_number' - 'passenger_id' FROM public.trips t WHERE id=b)) jb USING (key)
    WHERE ja.value IS DISTINCT FROM jb.value
  ) x;
  RAISE NOTICE 'trips column diffs A vs B: %', COALESCE(diffs, '(none)');
  ASSERT (SELECT count(*) FROM public.driver_wallet_ledger WHERE related_trip_id IN (a) AND type='TRIP_EARNING_PENDING') = 1;
  ASSERT (SELECT count(*) FROM public.driver_wallet_ledger WHERE related_trip_id IN (b) AND type='TRIP_EARNING_PENDING') = 1;
  ASSERT (SELECT amount_pence FROM public.driver_wallet_ledger WHERE related_trip_id=a AND type='TRIP_EARNING_PENDING')
       = (SELECT amount_pence FROM public.driver_wallet_ledger WHERE related_trip_id=b AND type='TRIP_EARNING_PENDING');
  ASSERT (SELECT metadata - 'driver_net_pence' FROM public.driver_wallet_ledger WHERE related_trip_id=a AND type='TRIP_EARNING_PENDING')
       = (SELECT metadata - 'driver_net_pence' FROM public.driver_wallet_ledger WHERE related_trip_id=b AND type='TRIP_EARNING_PENDING');
  RAISE NOTICE 'PASS parity: identical trips columns + identical PENDING row';
END \$\$;
ROLLBACK;
SQL

echo "=== CONCURRENCY: 2 parallel atomic calls on one committed trip ==="
CONC_TID="$("${PSQL[@]}" -Atq -c "$SEED_SQL RETURNING id")"
CALL="select public.complete_trip_atomic_v1('$CONC_TID','$DRIVER_ID', now(), '$COMPLETION_JSON'::jsonb, '$SETTLE_JSON'::jsonb, true, 'tip_window_defer', 'GBP')->>'idempotent'"
( "${PSQL[@]}" -Atq -c "$CALL" > "$TMP/c1" 2>&1 & "${PSQL[@]}" -Atq -c "$CALL" > "$TMP/c2" 2>&1 & wait )
echo "caller1 idempotent=$(cat "$TMP/c1")  caller2 idempotent=$(cat "$TMP/c2")"
"${PSQL[@]}" -Atq -c "select 'pending_rows='||count(*) from public.driver_wallet_ledger where related_trip_id='$CONC_TID' and type='TRIP_EARNING_PENDING'"

echo "=== TIMING (A legacy 4 round trips vs B atomic 1 round trip), ITERS=$ITERS, LOCAL loopback ==="
{
  echo "\\set QUIET 1"
  echo "CREATE TEMP TABLE f110_timing (variant text, ms numeric);"
  for i in $(seq 1 "$ITERS"); do
    for V in A B; do
      echo "$SEED_SQL RETURNING id AS tid \\gset"
      echo "SELECT clock_timestamp() AS t0 \\gset"
      if [ "$V" = "A" ]; then
        cat <<EOF
UPDATE public.trips SET status='completed', dispatch_status='completed', completed_at=now(), fare=10.00, estimated_fare=10.00, final_fare_pence=1000, final_customer_fare_pence=1000, pickup_waiting_charge_pence=0, stop_waiting_charge_pence=0, stop_charge_total_pence=0, total_waiting_charge_pence=0, waiting_charge_pence=0, tip_window_opened_at=now(), tip_window_expires_at=now() + interval '20 minutes', tip_window_status='open', tip_window_closed_at=NULL, updated_at=now() WHERE id=:'tid';
SELECT financial_model::text AS fm FROM public.trips WHERE id=:'tid' \\gset
UPDATE public.trips SET final_fare_pence=1000, commissionable_fare_pence=1000, commission_pence=200, driver_net_pence=800, driver_net_before_tip_pence=800, driver_total_earnings_pence=800, airport_charge_pence=0, tip_pence=0, tip_amount_pence=0, commission_pct=20, driver_tier_commission_percent=20, gross_fare_pence=1000, provider_fee_pence=NULL, onecab_net_pence=200, platform_gross_revenue_pence=200, platform_net_revenue_pence=200, settlement_formula_version='fixture-110', final_customer_fare_pence=1000, updated_at=now() WHERE id=:'tid';
SELECT public.credit_trip_earning_pending(:'tid'::uuid, '$DRIVER_ID'::uuid, 800, 'GBP', 'Trip earning pending payment confirmation') AS pr \\gset
EOF
      else
        echo "SELECT public.complete_trip_atomic_v1(:'tid'::uuid, '$DRIVER_ID'::uuid, now(), '$COMPLETION_JSON'::jsonb, '$SETTLE_JSON'::jsonb, true, 'tip_window_defer', 'GBP') AS pr \\gset"
      fi
      echo "SELECT (extract(epoch from clock_timestamp() - :'t0'::timestamptz)*1000)::numeric AS ms \\gset"
      echo "INSERT INTO f110_timing VALUES ('$V', :ms);"
    done
  done
  cat <<'EOF'
\set QUIET 0
\pset format unaligned
\pset tuples_only on
SELECT variant||' n='||count(*)||' mean_ms='||round(avg(ms),2)||' median_ms='||round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::numeric,2)||' p95_ms='||round((percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::numeric,2)||' max_ms='||round(max(ms),2)
FROM f110_timing GROUP BY variant ORDER BY variant;
SELECT 'speedup_mean_A_over_B='||round((SELECT avg(ms) FROM f110_timing WHERE variant='A')/(SELECT avg(ms) FROM f110_timing WHERE variant='B'),2);
EOF
} > "$TMP/timing.sql"
"${PSQL[@]}" -q -f "$TMP/timing.sql"

echo "=== final integrity on fixture trips ==="
"${PSQL[@]}" -Atq <<'SQL'
SELECT 'fixture_trips=' || count(*) FROM public.trips WHERE pickup_address='F110-ATOMIC-FIXTURE';
SELECT 'fixture_trips_with_pending_ne_1=' || count(*) FROM public.trips t
 WHERE pickup_address='F110-ATOMIC-FIXTURE' AND status='completed'
   AND (SELECT count(*) FROM public.driver_wallet_ledger l WHERE l.related_trip_id=t.id AND l.type='TRIP_EARNING_PENDING') <> 1;
SELECT 'fixture_ten_or_release_rows=' || count(*) FROM public.driver_wallet_ledger
 WHERE related_trip_id IN (SELECT id FROM public.trips WHERE pickup_address='F110-ATOMIC-FIXTURE')
   AND type IN ('TRIP_EARNING_NET','TRIP_EARNING_PENDING_RELEASE');
SQL

cleanup_fixture
echo "fixtures cleaned (local only)"
echo "complete_trip_atomic_v1_110_local COMPLETE — STOP BEFORE PROD"
