#!/usr/bin/env bash
# =============================================================================
# #92A Payment SSOT — real PostgreSQL integration (LOCAL DB only).
#
#   DB_URL=postgresql://admin@127.0.0.1:5432/onecab_payment_ssot_92a \
#     bash supabase/tests/payment_ssot_92a_integration_isolated.sh
#
# Or against the CI pg-harness DB after bootstrap (migrations already applied).
#
# - Refuses non-local DB_URL.
# - No Edge / Revolut / live money.
# - Two real parallel psql sessions for concurrent claim races.
# - Applies Stage A/B/C/D SQL when tables are missing (isolated stub DB path).
# =============================================================================
set -uo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DB_URL="${DB_URL:-postgresql://admin@127.0.0.1:5432/onecab_payment_ssot_92a}"
WORK="$(mktemp -d)"
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
  echo "ERROR: no Postgres at $DB_URL — report blocker; do not mark DB verification passed via simulation." >&2
  exit 1
fi

PSQL=(psql "$DB_URL" -X -q -v ON_ERROR_STOP=1)

echo "=== #92A payment SSOT PostgreSQL integration ==="
echo "DB_URL=$DB_URL"

# Ensure Stage A schema present (isolated stub DB or full harness).
if [ "$("${PSQL[@]}" -At -c "select to_regclass('public.payment_financial_operations') is not null")" != "t" ]; then
  echo "=== applying Stage A foundation ==="
  "${PSQL[@]}" -f "$REPO/supabase/migrations/20270301120000_payment_coverage_capture_ssot_p0.sql" >/dev/null
fi
if [ "$("${PSQL[@]}" -At -c "select to_regprocedure('public.assert_trip_completion_customer_payment_gate(uuid)') is not null")" != "t" ]; then
  echo "=== applying Stage B completion gate ==="
  "${PSQL[@]}" -f "$REPO/supabase/migrations/20270301140000_completion_gate_payable_snapshot_waiting.sql" >/dev/null
fi
# Stage B/C markers (idempotent)
if [ -f "$REPO/supabase/migrations/20270301125000_payment_ssot_cutover_stage_b.sql" ]; then
  "${PSQL[@]}" -f "$REPO/supabase/migrations/20270301125000_payment_ssot_cutover_stage_b.sql" >/dev/null || true
fi
if [ -f "$REPO/supabase/migrations/20270301126000_payment_ssot_cutover_stage_c.sql" ]; then
  "${PSQL[@]}" -f "$REPO/supabase/migrations/20270301126000_payment_ssot_cutover_stage_c.sql" >/dev/null || true
fi
# Clear any leftover inflight so Stage D enablement gate can pass
"${PSQL[@]}" <<'SQL' >/dev/null
UPDATE public.payment_financial_operations
SET provider_post_inflight = false, state = 'CANCELLED'
WHERE provider_post_inflight = true
   OR state IN (
     'INCREMENT_REQUESTED','INCREMENT_PENDING','INCREMENT_UNKNOWN',
     'CAPTURE_REQUESTED','CAPTURE_PENDING','CAPTURE_UNKNOWN','RECONCILING'
   );
SQL
# Stage D strict (required for mirror tests)
"${PSQL[@]}" -f "$REPO/supabase/migrations/20270301130000_payment_ssot_cutover_stage_d_strict.sql" >/dev/null

# Ensure stub trips/payment_sessions exist for isolated DB
"${PSQL[@]}" <<'SQL' >/dev/null
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS public.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_amount_pence integer,
  payment_status text,
  payment_hold_status text,
  payment_coverage_status text,
  authorised_amount_pence integer,
  final_customer_fare_pence integer,
  estimated_total_pence integer,
  locked_base_fare_pence integer,
  pickup_waiting_charge_pence integer DEFAULT 0,
  stop_waiting_charge_pence integer DEFAULT 0,
  financial_model text,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.payment_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid REFERENCES public.trips(id),
  purpose text,
  captured_amount_pence integer,
  capture_requested_pence integer,
  capture_confirmed_pence integer,
  capture_confirmation_state text,
  financial_operation_fence uuid,
  provider_state text,
  provider_state_verified_at timestamptz,
  authorised_amount_pence integer,
  total_authorised_amount_pence integer,
  captured_at timestamptz,
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.trip_has_unresolved_fare_increase_modification(p_trip_id uuid)
RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
SQL

# Re-ensure trigger after stub table create (isolated path only)
if [ "$("${PSQL[@]}" -At -c "select to_regprocedure('public.trips_capture_amount_confirmed_only()') is not null")" = "t" ]; then
  "${PSQL[@]}" <<'SQL' >/dev/null
  DROP TRIGGER IF EXISTS trg_trips_capture_amount_confirmed_only ON public.trips;
  CREATE TRIGGER trg_trips_capture_amount_confirmed_only
    BEFORE UPDATE OF capture_amount_pence ON public.trips
    FOR EACH ROW
    EXECUTE FUNCTION public.trips_capture_amount_confirmed_only();
SQL
fi

echo "=== fixture bootstrap (full schema or stub) ==="
if ! "${PSQL[@]}" -f "$HERE/payment_ssot_92a_integration.setup.sql" >"$WORK/setup.log" 2>&1; then
  fail "fixture_setup" "setup sql failed"
  cat "$WORK/setup.log"
  echo "TOTAL fail=$FAIL pass=$PASS skipped=0"
  exit 1
fi
grep -q '92A_FIXTURE_READY' "$WORK/setup.log" && pass "fixture_setup" || fail "fixture_setup" "ready marker missing"

echo "=== sequential constraint / lifecycle SQL ==="
if "${PSQL[@]}" -f "$HERE/payment_ssot_92a_integration.sql" >"$WORK/seq.log" 2>&1; then
  grep -q 'ALL payment_ssot_92a_integration CHECKS PASSED' "$WORK/seq.log" && pass "sequential_sql" || fail "sequential_sql" "success marker missing"
else
  fail "sequential_sql" "psql exited non-zero"
  tail -n 40 "$WORK/seq.log"
fi
grep -E 'NOTICE:  (PASS|FAIL) ' "$WORK/seq.log" || true

# ── Concurrent claims from two independent connections ───────────────────────
echo "=== concurrent claim race (two psql sessions) ==="
TRIP='00000000-0000-4000-9200-0000000000c1'
SESS='00000000-0000-4000-9200-0000000000c2'
# Fixtures already created by setup.sql for race ids
"${PSQL[@]}" <<SQL >/dev/null
DELETE FROM public.payment_financial_operations WHERE payment_session_id = '$SESS';
SQL

LOGICAL="CAPTURE:fare:${SESS}:ord-race:500:v1:e0"
cat >"$WORK/claim.sql" <<SQL
INSERT INTO public.payment_financial_operations (
  execution_id, fence, payment_session_id, trip_id, op_type,
  logical_idempotency_key, state, requested_amount_pence, provider_order_id,
  lease_expires_at, provider_post_inflight
) VALUES (
  'CAPTURE:$TRIP:' || replace(gen_random_uuid()::text, '-', ''),
  gen_random_uuid(), '$SESS', '$TRIP', 'CAPTURE',
  '$LOGICAL',
  'CAPTURE_REQUESTED', 500, 'ord-race',
  now() + interval '2 minutes', false
);
SELECT 'WON';
SQL

psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$WORK/claim.sql" >"$WORK/w1.out" 2>"$WORK/w1.err" &
PID1=$!
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$WORK/claim.sql" >"$WORK/w2.out" 2>"$WORK/w2.err" &
PID2=$!
wait $PID1; RC1=$?
wait $PID2; RC2=$?

WINS=0
[ $RC1 -eq 0 ] && grep -q WON "$WORK/w1.out" && WINS=$((WINS+1))
[ $RC2 -eq 0 ] && grep -q WON "$WORK/w2.out" && WINS=$((WINS+1))
LOSSES=0
grep -qi 'unique\|duplicate\|conflict' "$WORK/w1.err" "$WORK/w2.err" 2>/dev/null && LOSSES=1
ROWC=$("${PSQL[@]}" -At -c "select count(*) from public.payment_financial_operations where payment_session_id='$SESS' and logical_idempotency_key='$LOGICAL'")

if [ "$WINS" = "1" ] && [ "$ROWC" = "1" ]; then
  pass "concurrent_claims_one_winner"
else
  fail "concurrent_claims_one_winner" "wins=$WINS rows=$ROWC rc1=$RC1 rc2=$RC2"
  cat "$WORK/w1.err" "$WORK/w2.err" 2>/dev/null | head -20
fi

# Same-owner concurrent re-entry (second insert same session, different key, both inflight)
echo "=== same-owner concurrent re-entry (inflight fence) ==="
"${PSQL[@]}" <<SQL >/dev/null
DELETE FROM public.payment_financial_operations WHERE payment_session_id = '$SESS';
INSERT INTO public.payment_financial_operations (
  execution_id, fence, payment_session_id, trip_id, op_type,
  logical_idempotency_key, state, requested_amount_pence, provider_order_id,
  lease_expires_at, provider_post_inflight
) VALUES (
  'CAPTURE:$TRIP:owner1', gen_random_uuid(), '$SESS', '$TRIP', 'CAPTURE',
  'CAPTURE:fare:$SESS:ord-own:500:v1:e0',
  'CAPTURE_PENDING', 500, 'ord-own', now() + interval '2 minutes', true
);
SQL
cat >"$WORK/reentry.sql" <<SQL
INSERT INTO public.payment_financial_operations (
  execution_id, fence, payment_session_id, trip_id, op_type,
  logical_idempotency_key, state, requested_amount_pence, provider_order_id,
  lease_expires_at, provider_post_inflight
) VALUES (
  'CAPTURE:$TRIP:owner2', gen_random_uuid(), '$SESS', '$TRIP', 'CAPTURE',
  'CAPTURE:fare:$SESS:ord-own:600:v1:e0',
  'CAPTURE_PENDING', 600, 'ord-own', now() + interval '2 minutes', true
);
SELECT 'REENTRY_WON';
SQL
if psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$WORK/reentry.sql" >"$WORK/re.out" 2>"$WORK/re.err"; then
  fail "same_owner_inflight_reentry_blocked" "second inflight insert succeeded"
else
  pass "same_owner_inflight_reentry_blocked"
fi

# Rollback Stage D → C compatibility (flags only; schema retained)
echo "=== Stage D → C rollback flag compatibility ==="
"${PSQL[@]}" <<'SQL' >/dev/null
UPDATE public.payment_ssot_cutover
SET stage='C', require_financial_op_claim=false, strict_trip_capture_mirror=false, updated_at=now()
WHERE id=1;
SQL
STAGE=$("${PSQL[@]}" -At -c "select stage||':'||require_financial_op_claim||':'||strict_trip_capture_mirror from payment_ssot_cutover where id=1")
if [ "$STAGE" = "C:f:f" ] || [ "$STAGE" = "C:false:false" ]; then
  pass "stage_d_to_c_flag_rollback"
else
  # postgres may print t/f
  if echo "$STAGE" | grep -q '^C:f'; then pass "stage_d_to_c_flag_rollback"; else fail "stage_d_to_c_flag_rollback" "got $STAGE"; fi
fi
# Cleanup ALL synthetic fixtures BEFORE Stage D restore (enablement refuses inflight)
"${PSQL[@]}" <<'SQL' >/dev/null
DELETE FROM public.payment_financial_events
 WHERE payment_session_id::text LIKE '00000000-0000-4000-9200-%'
    OR trip_id::text LIKE '00000000-0000-4000-9200-%';
DELETE FROM public.payment_financial_operations
 WHERE payment_session_id::text LIKE '00000000-0000-4000-9200-%'
    OR trip_id::text LIKE '00000000-0000-4000-9200-%';
DELETE FROM public.payment_payable_snapshots
 WHERE trip_id::text LIKE '00000000-0000-4000-9200-%';
DELETE FROM public.payment_sessions WHERE id::text LIKE '00000000-0000-4000-9200-%';
DELETE FROM public.trips WHERE id::text LIKE '00000000-0000-4000-9200-%';
UPDATE public.payment_financial_operations
SET provider_post_inflight = false, state = 'CANCELLED'
WHERE provider_post_inflight = true
   OR state IN (
     'INCREMENT_REQUESTED','INCREMENT_PENDING','INCREMENT_UNKNOWN',
     'CAPTURE_REQUESTED','CAPTURE_PENDING','CAPTURE_UNKNOWN','RECONCILING'
   );
SQL
# Restore Stage D for subsequent CI consumers of this DB
if ! "${PSQL[@]}" -f "$REPO/supabase/migrations/20270301130000_payment_ssot_cutover_stage_d_strict.sql" >/dev/null; then
  fail "stage_d_restore_after_quiesce"
else
  pass "stage_d_restore_after_quiesce"
fi

left=$("${PSQL[@]}" -At -c "select (select count(*) from trips where id::text like '00000000-0000-4000-9200-%')+(select count(*) from payment_sessions where id::text like '00000000-0000-4000-9200-%')" 2>/dev/null || echo "?")
echo "SYNTHETIC_ROWS_REMAINING=$left"

echo
echo "TOTAL fail=$FAIL pass=$PASS skipped=0"
rm -rf "$WORK"
if [ "$FAIL" -ne 0 ]; then
  echo "SCENARIO 92A => FAIL"
  exit 1
fi
echo "SCENARIO 92A => PASS"
echo "ALL payment_ssot_92a_integration_isolated CHECKS PASSED"
exit 0
