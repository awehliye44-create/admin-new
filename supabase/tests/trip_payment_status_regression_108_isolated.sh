#!/usr/bin/env bash
# =============================================================================
# #108 — Real PostgreSQL concurrency and out-of-order payment_status regression.
#
#   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
#     bash supabase/tests/trip_payment_status_regression_108_isolated.sh
#
#   A  captured trip + later authorized write stays captured
#   B  split row (authorized + captured hold + capture amount) promotes to captured
#   C  concurrent authorized write waits out a capture commit and stays captured
#   D  reconcile function repairs a split row from existing session evidence
#   E  captured → refunded is still allowed
#   F  anon cannot execute the reconcile function
#   G  Stage D flags are not rewritten
#
# LOCAL DB only. No Revolut. No production mutations. Synthetic rows cleaned up.
# =============================================================================
set -uo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); echo "PASS $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL $1 — $2"; }

case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*|*@127.0.0.1/*|*@localhost/*) ;;
  *) echo "REFUSING: DB_URL must be LOCAL. Got: $DB_URL" >&2; exit 2 ;;
esac

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql required" >&2; exit 1
fi
if ! PGCONNECT_TIMEOUT=5 psql "$DB_URL" -X -q -At -c 'select 1' >/dev/null 2>&1; then
  echo "ERROR: no Postgres at $DB_URL" >&2; exit 1
fi

PSQL=(psql "$DB_URL" -X -q -v ON_ERROR_STOP=1)
TAG="108$(python3 -c 'import uuid; print(uuid.uuid4().hex[:8])')"
DRIVER_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
CUST_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
TRIP_A="$(python3 -c 'import uuid; print(uuid.uuid4())')"
TRIP_B="$(python3 -c 'import uuid; print(uuid.uuid4())')"
TRIP_C="$(python3 -c 'import uuid; print(uuid.uuid4())')"
TRIP_D="$(python3 -c 'import uuid; print(uuid.uuid4())')"
TRIP_E="$(python3 -c 'import uuid; print(uuid.uuid4())')"
SESS_D="$(python3 -c 'import uuid; print(uuid.uuid4())')"
SESS_C="$(python3 -c 'import uuid; print(uuid.uuid4())')"

echo "=== #108 payment_status regression PostgreSQL integration ==="
echo "DB_URL=$DB_URL TAG=$TAG"

STAGE_BEFORE="$("${PSQL[@]}" -At -c "select coalesce((select require_financial_op_claim::text||','||strict_trip_capture_mirror::text from public.payment_ssot_cutover where id=1), 'absent')" 2>/dev/null || echo absent)"

echo "=== applying 20270301210000_trip_payment_status_no_capture_regression_108.sql ==="
"${PSQL[@]}" -f "$REPO/supabase/migrations/20270301210000_trip_payment_status_no_capture_regression_108.sql" >/dev/null

# Local databases that predate 20270301120000 lack the capture-evidence columns.
# Production already has them. ADD IF NOT EXISTS is a no-op there.
"${PSQL[@]}" -c "
ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS capture_confirmation_state text,
  ADD COLUMN IF NOT EXISTS capture_confirmed_pence integer;
" >/dev/null

SA_ID="$("${PSQL[@]}" -At -c "select id::text from service_areas where is_active is true limit 1")"
REGION_ID="$("${PSQL[@]}" -At -c "select region_id::text from service_areas where id='${SA_ID}'::uuid")"
if [ -z "$SA_ID" ] || [ -z "$REGION_ID" ]; then
  echo "ERROR: need an active service_areas row to seed synthetic trips" >&2
  exit 1
fi

"${PSQL[@]}" <<SQL >/dev/null
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.drivers (id, first_name, last_name, phone, email, region_id, service_area_id)
VALUES (
  '${DRIVER_ID}'::uuid, 'Pay', '108', '+449108${TAG:3:7}', 'pay108-${TAG}@example.com',
  '${REGION_ID}'::uuid, '${SA_ID}'::uuid
);
INSERT INTO public.customers (id, first_name, last_name, phone)
VALUES ('${CUST_ID}'::uuid, 'Pay', 'Rider', '+449109${TAG:3:7}');
INSERT INTO public.trips (
  id, trip_code, status, driver_id, confirmed_driver_id, financial_model,
  driver_net_pence, airport_charge_pence, payment_status, payment_hold_status,
  capture_amount_pence, completed_at, passenger_id, pickup_address, dropoff_address,
  service_area_id, payment_method
) VALUES
  ('${TRIP_A}'::uuid, 'T-${TAG}-A', 'completed', '${DRIVER_ID}'::uuid, '${DRIVER_ID}'::uuid,
   'PLATFORM_COLLECTED', 425, 0, 'captured', 'captured', 500, now(),
   '${CUST_ID}'::uuid, 'Pickup A', 'Drop A', '${SA_ID}'::uuid, 'CARD'),
  ('${TRIP_B}'::uuid, 'T-${TAG}-B', 'completed', '${DRIVER_ID}'::uuid, '${DRIVER_ID}'::uuid,
   'PLATFORM_COLLECTED', 425, 0, 'authorized', 'captured', 500, now(),
   '${CUST_ID}'::uuid, 'Pickup B', 'Drop B', '${SA_ID}'::uuid, 'CARD'),
  ('${TRIP_C}'::uuid, 'T-${TAG}-C', 'completed', '${DRIVER_ID}'::uuid, '${DRIVER_ID}'::uuid,
   'PLATFORM_COLLECTED', 425, 0, 'authorized', 'authorized', NULL, now(),
   '${CUST_ID}'::uuid, 'Pickup C', 'Drop C', '${SA_ID}'::uuid, 'CARD'),
  ('${TRIP_D}'::uuid, 'T-${TAG}-D', 'completed', '${DRIVER_ID}'::uuid, '${DRIVER_ID}'::uuid,
   'PLATFORM_COLLECTED', 425, 0, 'authorized', 'captured', 500, now(),
   '${CUST_ID}'::uuid, 'Pickup D', 'Drop D', '${SA_ID}'::uuid, 'CARD'),
  ('${TRIP_E}'::uuid, 'T-${TAG}-E', 'completed', '${DRIVER_ID}'::uuid, '${DRIVER_ID}'::uuid,
   'PLATFORM_COLLECTED', 425, 0, 'captured', 'captured', 500, now(),
   '${CUST_ID}'::uuid, 'Pickup E', 'Drop E', '${SA_ID}'::uuid, 'CARD');
-- Session evidence must exist before an origin-role capture_amount write.
-- Stage D refuses capture_amount_pence unless capture_confirmed_pence matches.
INSERT INTO public.payment_sessions (
  id, user_id, service_area_id, idempotency_key, client_action_id, status, purpose,
  trip_id, provider_state, authorised_amount_pence, captured_amount_pence,
  capture_confirmed_pence, capture_confirmation_state
) VALUES (
  '${SESS_C}'::uuid, gen_random_uuid(), '${SA_ID}'::uuid, 'pay108c-${TAG}', 'PAY108C-${TAG}',
  'captured', 'RIDE_BOOKING', '${TRIP_C}'::uuid, 'COMPLETED', 700, 500, 500,
  'FULLY_CAPTURED'
);
INSERT INTO public.payment_sessions (
  id, user_id, service_area_id, idempotency_key, client_action_id, status, purpose,
  trip_id, provider_state, authorised_amount_pence, captured_amount_pence,
  capture_confirmed_pence, capture_confirmation_state
) VALUES (
  '${SESS_D}'::uuid, gen_random_uuid(), '${SA_ID}'::uuid, 'pay108-${TAG}', 'PAY108-${TAG}',
  'captured', 'RIDE_BOOKING', '${TRIP_D}'::uuid, 'COMPLETED', 700, 500, 500,
  'FULLY_CAPTURED'
);
UPDATE public.trips SET updated_at = '2000-01-01T00:00:00Z' WHERE id = '${TRIP_D}'::uuid;
COMMIT;
SQL

# --- A: out-of-order authorised after captured ---
"${PSQL[@]}" -c "UPDATE public.trips SET payment_status='authorized', updated_at=now() WHERE id='${TRIP_A}'::uuid" >/dev/null
STATUS_A="$("${PSQL[@]}" -At -c "select payment_status from public.trips where id='${TRIP_A}'::uuid")"
if [ "$STATUS_A" = "captured" ]; then
  pass "A-late-authorised-kept-captured"
else
  fail "A-late-authorised-kept-captured" "status=$STATUS_A"
fi

# --- B: split row promoted when a stale authorised write arrives ---
"${PSQL[@]}" -c "UPDATE public.trips SET payment_status='authorized', updated_at=now() WHERE id='${TRIP_B}'::uuid" >/dev/null
STATUS_B="$("${PSQL[@]}" -At -c "select payment_status||','||payment_hold_status||','||capture_amount_pence::text from public.trips where id='${TRIP_B}'::uuid")"
if [ "$STATUS_B" = "captured,captured,500" ]; then
  pass "B-split-row-promoted"
else
  fail "B-split-row-promoted" "got=$STATUS_B"
fi

# --- C: concurrent authorised write during an in-flight capture commit ---
"${PSQL[@]}" <<SQL >/dev/null &
BEGIN;
SELECT id FROM public.trips WHERE id = '${TRIP_C}'::uuid FOR UPDATE;
SELECT pg_sleep(1.2);
UPDATE public.trips
   SET payment_status = 'captured',
       payment_hold_status = 'captured',
       capture_amount_pence = 500,
       updated_at = now()
 WHERE id = '${TRIP_C}'::uuid;
COMMIT;
SQL
PID_CAPTURE=$!
sleep 0.4
"${PSQL[@]}" -c "UPDATE public.trips SET payment_status='authorized', updated_at=now() WHERE id='${TRIP_C}'::uuid" >/dev/null &
PID_STALE=$!
wait "$PID_CAPTURE" || fail "C-concurrent-authorised-after-capture" "capture txn failed"
wait "$PID_STALE" || fail "C-concurrent-authorised-after-capture" "stale txn failed"
STATUS_C="$("${PSQL[@]}" -At -c "select payment_status||','||coalesce(payment_hold_status,'')||','||coalesce(capture_amount_pence::text,'') from public.trips where id='${TRIP_C}'::uuid")"
if [ "$STATUS_C" = "captured,captured,500" ]; then
  pass "C-concurrent-authorised-after-capture"
else
  fail "C-concurrent-authorised-after-capture" "got=$STATUS_C"
fi

# --- D: reconcile from existing session evidence, no provider call ---
BEFORE_D="$("${PSQL[@]}" -At -c "select payment_status from public.trips where id='${TRIP_D}'::uuid")"
DRY="$("${PSQL[@]}" -At -c "select public.reconcile_confirmed_capture_payment_status(100, true)::text")"
AFTER_DRY="$("${PSQL[@]}" -At -c "select payment_status from public.trips where id='${TRIP_D}'::uuid")"
LIVE="$("${PSQL[@]}" -At -c "select public.reconcile_confirmed_capture_payment_status(100, false)::text")"
AFTER_D="$("${PSQL[@]}" -At -c "select payment_status from public.trips where id='${TRIP_D}'::uuid")"
if [ "$BEFORE_D" = "authorized" ] && [ "$AFTER_DRY" = "authorized" ] \
  && echo "$DRY" | grep -q "$TRIP_D" \
  && echo "$LIVE" | grep -q "$TRIP_D" \
  && [ "$AFTER_D" = "captured" ]; then
  pass "D-reconcile-from-session"
else
  fail "D-reconcile-from-session" "before=$BEFORE_D after_dry=$AFTER_DRY after=$AFTER_D dry=$DRY live=$LIVE"
fi

# --- E: refund still allowed ---
"${PSQL[@]}" -c "UPDATE public.trips SET payment_status='refunded', updated_at=now() WHERE id='${TRIP_E}'::uuid" >/dev/null
STATUS_E="$("${PSQL[@]}" -At -c "select payment_status from public.trips where id='${TRIP_E}'::uuid")"
if [ "$STATUS_E" = "refunded" ]; then
  pass "E-refund-still-allowed"
else
  fail "E-refund-still-allowed" "status=$STATUS_E"
fi

# --- F: anon cannot execute ---
ANON_DENY="$("${PSQL[@]}" -At -c "
SET ROLE anon;
SELECT public.reconcile_confirmed_capture_payment_status(1, true);
" 2>&1 || true)"
if echo "$ANON_DENY" | grep -qiE 'permission denied|42501'; then
  pass "F-anon-denied"
else
  fail "F-anon-denied" "$ANON_DENY"
fi

# --- G: Stage D untouched ---
if grep -q 'payment_ssot_cutover' \
  "$REPO/supabase/migrations/20270301210000_trip_payment_status_no_capture_regression_108.sql"; then
  fail "G-stage-d-untouched" "migration mentions payment_ssot_cutover"
else
  STAGE_AFTER="$("${PSQL[@]}" -At -c "select coalesce((select require_financial_op_claim::text||','||strict_trip_capture_mirror::text from public.payment_ssot_cutover where id=1), 'absent')" 2>/dev/null || echo absent)"
  if [ "$STAGE_BEFORE" = "$STAGE_AFTER" ]; then
    pass "G-stage-d-untouched before=$STAGE_BEFORE"
  else
    fail "G-stage-d-untouched" "before=$STAGE_BEFORE after=$STAGE_AFTER"
  fi
fi

"${PSQL[@]}" <<SQL >/dev/null
BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.payment_sessions WHERE id IN ('${SESS_D}'::uuid, '${SESS_C}'::uuid);
DELETE FROM public.trips WHERE id IN (
  '${TRIP_A}'::uuid,'${TRIP_B}'::uuid,'${TRIP_C}'::uuid,'${TRIP_D}'::uuid,'${TRIP_E}'::uuid
);
DELETE FROM public.drivers WHERE id = '${DRIVER_ID}'::uuid;
DELETE FROM public.customers WHERE id = '${CUST_ID}'::uuid;
COMMIT;
SQL

REMAIN="$("${PSQL[@]}" -At -c "select count(*) from public.trips where id in (
  '${TRIP_A}'::uuid,'${TRIP_B}'::uuid,'${TRIP_C}'::uuid,'${TRIP_D}'::uuid,'${TRIP_E}'::uuid
)")"
if [ "$REMAIN" = "0" ]; then
  pass "cleanup"
else
  fail "cleanup" "remain=$REMAIN"
fi

echo
echo "TOTAL fail=$FAIL pass=$PASS skipped=0"
if [ "$FAIL" -ne 0 ]; then
  echo "SCENARIO 108 => FAIL" >&2
  exit 1
fi
echo "SCENARIO 108 => PASS"
echo "ALL trip_payment_status_regression_108_isolated CHECKS PASSED"
