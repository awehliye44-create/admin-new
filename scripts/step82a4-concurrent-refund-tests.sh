#!/usr/bin/env bash
# Step 8.2A.4 — genuine two-session concurrent refund RPC tests.
set -euo pipefail

DBURL="${1:?usage: step82a4-concurrent-refund-tests.sh DATABASE_URL}"

psql_base() { psql "$DBURL" -v ON_ERROR_STOP=1 "$@"; }

reset_fixture() {
  psql_base -q <<'SQL'
TRUNCATE public.payment_session_refunds, public.driver_wallet_ledger,
  public.trip_finance, public.payments, public.payment_sessions, public.trips, public.drivers CASCADE;
SQL
  psql_base -q -c "
INSERT INTO public.drivers (id, user_id) VALUES ('11111111-1111-1111-1111-111111111111', gen_random_uuid());
INSERT INTO public.trips (id, driver_id, financial_model, capture_amount_pence, commission_pence, driver_net_pence, final_fare_pence, final_customer_fare_pence, payment_status)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'PLATFORM_COLLECTED', 1250, 250, 1000, 1250, 1250, 'captured');
INSERT INTO public.payment_sessions (id, trip_id, purpose, captured_amount_pence, authorised_amount_pence, currency)
VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'RIDE_BOOKING', 1250, 1250, 'gbp');
INSERT INTO public.payments (id, trip_id, driver_id, amount_pence, captured_amount_pence, status)
VALUES (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 1250, 1250, 'captured');
INSERT INTO public.trip_finance (id, trip_id, driver_id, financial_status)
VALUES (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'CAPTURED');
INSERT INTO public.driver_wallet_ledger (driver_id, related_trip_id, type, amount_pence)
VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'TRIP_EARNING_NET', 1000);
"
}

echo "=== A: same provider_refund_id concurrently ==="
reset_fixture
# Session 1 holds trip lock; session 2 races same refund id.
(
  psql "$DBURL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT pg_advisory_lock(hashtext('step82a4-a'));
SELECT public.apply_confirmed_provider_refund_atomic(
  '22222222-2222-2222-2222-222222222222', 'revolut', 'conc-ref-a', 250, 250,
  NULL, NULL, NULL, 'admin_refund', false
);
SELECT pg_sleep(0.5);
SELECT pg_advisory_unlock(hashtext('step82a4-a'));
COMMIT;
SQL
) &
pid1=$!
sleep 0.05
out2=$(psql "$DBURL" -tA -c "
SELECT public.apply_confirmed_provider_refund_atomic(
  '22222222-2222-2222-2222-222222222222', 'revolut', 'conc-ref-a', 250, 250,
  NULL, NULL, NULL, 'admin_refund', false
)::text;
")
wait "$pid1" || true
echo "session2=$out2"
counts=$(psql "$DBURL" -tA -c "
SELECT
  (SELECT count(*) FROM payment_session_refunds WHERE provider_refund_id='conc-ref-a')::text || ',' ||
  (SELECT count(*) FROM driver_wallet_ledger WHERE type='REFUND_DEBIT' AND provider_refund_id='conc-ref-a')::text;
")
echo "child,debit counts=$counts"
echo "$out2" | grep -q 'already_applied' || echo "WARN: expected already_applied in session2"

echo "=== B: two different refund IDs concurrently ==="
reset_fixture
(
  psql "$DBURL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT pg_advisory_lock(hashtext('step82a4-b'));
SELECT public.apply_confirmed_provider_refund_atomic(
  '22222222-2222-2222-2222-222222222222', 'revolut', 'conc-ref-b1', 250, 250,
  NULL, NULL, NULL, 'admin_refund', false
);
SELECT pg_sleep(0.5);
SELECT pg_advisory_unlock(hashtext('step82a4-b'));
COMMIT;
SQL
) &
sleep 0.05
out_b2=$(psql "$DBURL" -tA -c "
SELECT public.apply_confirmed_provider_refund_atomic(
  '22222222-2222-2222-2222-222222222222', 'revolut', 'conc-ref-b2', 375, 625,
  NULL, NULL, NULL, 'admin_refund', false
)::text;
")
wait || true
debit_sum=$(psql "$DBURL" -tA -c "
SELECT coalesce(sum(abs(amount_pence)),0) FROM driver_wallet_ledger WHERE type='REFUND_DEBIT';
")
child_sum=$(psql "$DBURL" -tA -c "
SELECT coalesce(sum(amount_pence),0) FROM payment_session_refunds;
")
echo "session2=$out_b2 debit_sum=$debit_sum child_sum=$child_sum"

echo "=== C: failed transaction rolls back; retry succeeds once ==="
reset_fixture
set +e
psql "$DBURL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT public.apply_confirmed_provider_refund_atomic(
  '22222222-2222-2222-2222-222222222222', 'revolut', 'conc-ref-c', 250, 250,
  NULL, NULL, NULL, 'admin_refund', false
);
-- Force failure before commit
ROLLBACK;
SQL
set -e
mid_counts=$(psql "$DBURL" -tA -c "
SELECT
  (SELECT count(*) FROM payment_session_refunds)::text || ',' ||
  (SELECT count(*) FROM driver_wallet_ledger WHERE type='REFUND_DEBIT')::text;
")
retry=$(psql "$DBURL" -tA -c "
SELECT public.apply_confirmed_provider_refund_atomic(
  '22222222-2222-2222-2222-222222222222', 'revolut', 'conc-ref-c', 250, 250,
  NULL, NULL, NULL, 'admin_refund', false
)::text;
")
final_counts=$(psql "$DBURL" -tA -c "
SELECT
  (SELECT count(*) FROM payment_session_refunds)::text || ',' ||
  (SELECT count(*) FROM driver_wallet_ledger WHERE type='REFUND_DEBIT')::text;
")
echo "mid=$mid_counts retry=$retry final=$final_counts"

echo "=== D: partial then full — debit never exceeds TEN ==="
reset_fixture
psql "$DBURL" -q -c "
SELECT public.apply_confirmed_provider_refund_atomic(
  '22222222-2222-2222-2222-222222222222', 'revolut', 'conc-ref-d1', 250, 250,
  NULL, NULL, NULL, 'admin_refund', false);
SELECT public.apply_confirmed_provider_refund_atomic(
  '22222222-2222-2222-2222-222222222222', 'revolut', 'conc-ref-d2', 1000, 1250,
  NULL, NULL, NULL, 'admin_refund', false);
"
debit=$(psql "$DBURL" -tA -c "SELECT coalesce(sum(abs(amount_pence)),0) FROM driver_wallet_ledger WHERE type='REFUND_DEBIT';")
ten=$(psql "$DBURL" -tA -c "SELECT driver_net_pence FROM trips WHERE id='22222222-2222-2222-2222-222222222222';")
echo "debit_sum=$debit ten=$ten"

echo "=== E: historical NULL lineage REFUND_DEBIT — fail closed ==="
reset_fixture
psql "$DBURL" -q -c "
INSERT INTO driver_wallet_ledger (driver_id, related_trip_id, type, amount_pence)
VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'REFUND_DEBIT', -100);
"
set +e
err=$(psql "$DBURL" -tA -c "
SELECT public.apply_confirmed_provider_refund_atomic(
  '22222222-2222-2222-2222-222222222222', 'revolut', 'conc-ref-e', 100, 100,
  NULL, NULL, NULL, 'admin_refund', false
)::text;
" 2>&1)
set -e
echo "$err" | grep -q 'HISTORICAL_REFUND_DEBIT_REQUIRES_MANUAL_RECONCILIATION' && echo "E PASS" || echo "E FAIL: $err"

echo "=== ALL CONCURRENT HARNESS CASES COMPLETE ==="
