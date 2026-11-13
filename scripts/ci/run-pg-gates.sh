#!/usr/bin/env bash
# =============================================================================
# Mandatory PostgreSQL gates (CI job `pg-harness`; also runnable locally).
#
#   REQUIRE_PG_HARNESS=1 DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
#     bash scripts/ci/run-pg-gates.sh
#
# Runs, against a LOCAL database that already carries the migrations under test:
#   1. scheduled_rematch_waiting_concurrency_isolated.sh   (scenarios A-F + H, real parallel sessions)
#   2. negotiation_lock_order_concurrency_isolated.sh      (L lock-order proof, N1-N5 races, M bounded retry)
#   3. financial_offer_invariant_guard.sql                 (150000 + 160000 + 170000 + 210000 + 230000, rolled back)
#   4. airport_split_commissionable_follows_payable.sql    (190000 + 210000 global_offer, rolled back)
#   5. vitest committedOfferFareSqlExecution               (SQL SSOT execution, 150000 + 210000, rolled back)
#   6. ack_timeout_lock_order_concurrency_isolated.sh      (220000: sweep trip->offer lock order; L, LB, A1, A1b, A2, A3)
#
# FAILS (non-zero) when: the database is unreachable, the schema / an RPC is missing, any assertion
# fails, any check is SKIPPED, a harness reports a BLOCKER, or a harness prints fewer checks than
# its floor. Nothing here is allowed to skip: REQUIRE_PG_HARNESS is forced to 1.
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

export REQUIRE_PG_HARNESS=1
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
export DB_URL
case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*|*@127.0.0.1/*|*@localhost/*) ;;
  *) echo "REFUSING: DB_URL must be a LOCAL database (127.0.0.1/localhost). Got: $DB_URL" >&2; exit 2 ;;
esac

OUT="${PG_GATES_OUT:-$(mktemp -d)}"
FAILED=0
fail() { echo "GATE FAILED: $*" >&2; FAILED=1; }

if ! command -v psql >/dev/null 2>&1; then echo "ERROR: psql is required (REQUIRE_PG_HARNESS=1)" >&2; exit 1; fi
if ! PGCONNECT_TIMEOUT=5 psql "$DB_URL" -X -q -At -c 'select 1' >/dev/null 2>&1; then
  echo "ERROR: REQUIRE_PG_HARNESS=1 but no Postgres accepts connections at $DB_URL" >&2; exit 1
fi

echo "=== preflight: schema + RPCs (a missing object FAILS, never skips) ==="
hard_missing="$(psql "$DB_URL" -X -q -At -c "
  select coalesce(string_agg(x, ', '), '') from unnest(array[
    'public.trips','public.ride_offers','public.drivers','public.payment_sessions','public.trip_waiting_segments',
    'public.customers','public.global_dispatch_settings','public.server_fare_quotes']) x where to_regclass(x) is null")"
hard_missing_fn="$(psql "$DB_URL" -X -q -At -c "
  select coalesce(string_agg(x, ', '), '') from unnest(array[
    'public.accept_ride_offer_core(uuid,uuid,boolean)',
    'public.customer_counter_ride_offer_core(uuid,integer,uuid,uuid)','public.driver_send_preset_offer_core(uuid,integer,integer[],integer)',
    'public.driver_cancel_negotiation_core(uuid,uuid)','public.expire_negotiation_offer_core(uuid)','public.decline_ride_offer_core(uuid,uuid,text)',
    'public.apply_customer_decline_grace_core(uuid,text)','public.negotiation_contention_outcome(uuid,text)',
    'public.trip_negotiation_base_fare_pence(public.trips)','public.offer_trip_financial_authority(public.trips)',
    'public.tr_ride_offer_financial_invariant_guard_fn()',
    'public.apply_consumed_server_fare_airport_split_to_trip(uuid,uuid,uuid,uuid,uuid,integer)',
    'public.process_ride_offer_ack_timeouts()',
    'public.offer_driver_net_split_for_trip(public.trips,integer,integer,integer,numeric,numeric)',
    'public.offer_global_offer_promotion_pence(public.trips)',
    'public.driver_cancel_before_start_rematch(uuid,uuid,text,text,jsonb)']) x where to_regprocedure(x) is null")"
[ -z "$hard_missing" ] || { echo "ERROR: schema missing tables: $hard_missing" >&2; exit 1; }
[ -z "$hard_missing_fn" ] || { echo "ERROR: schema missing RPCs: $hard_missing_fn" >&2; exit 1; }
echo "preflight OK"

# run <name> <logfile> <cmd...>
run() {
  local name="$1" log="$2"; shift 2
  echo
  echo "=== $name ==="
  "$@" >"$log" 2>&1
  local rc=$?
  tail -n 25 "$log"
  if [ $rc -ne 0 ]; then fail "$name exited $rc (full log: $log)"; return 1; fi
  if grep -qE '^(SKIPPED|BLOCKER)|BLOCKER:|SKIPPING|PREDICATE_DRIFT' "$log"; then fail "$name reported a SKIP/BLOCKER (full log: $log)"; return 1; fi
  return 0
}

# --- 1. rematch / waiting harness ------------------------------------------------------------
if run "scheduled rematch / waiting concurrency (A-F)" "$OUT/rematch.log" \
     bash supabase/tests/scheduled_rematch_waiting_concurrency_isolated.sh; then
  grep -qE '^TOTAL fail=0 pass=[0-9]+ skipped=0' "$OUT/rematch.log" || fail "rematch harness: 'TOTAL fail=0 ... skipped=0' line missing"
  pass_n="$(grep -oE '^TOTAL fail=0 pass=[0-9]+' "$OUT/rematch.log" | grep -oE '[0-9]+$' || echo 0)"
  [ "${pass_n:-0}" -ge 40 ] || fail "rematch harness ran only ${pass_n:-0} checks (floor 40)"
  for s in A B C D E F; do
    grep -qE "^SCENARIO $s => PASS" "$OUT/rematch.log" || fail "rematch harness: scenario $s not PASS"
  done
  grep -qE '^SYNTHETIC_ROWS_REMAINING=0' "$OUT/rematch.log" || fail "rematch harness left synthetic rows behind"
fi

# --- 2. negotiation lock-order / concurrency harness ---------------------------------------------
if run "negotiation lock order + concurrency (L, N1-N5, M)" "$OUT/negotiation.log" \
     bash supabase/tests/negotiation_lock_order_concurrency_isolated.sh; then
  grep -qE '^TOTAL fail=0 pass=[0-9]+ skipped=0' "$OUT/negotiation.log" || fail "negotiation harness: 'TOTAL fail=0 ... skipped=0' line missing"
  pass_n="$(grep -oE '^TOTAL fail=0 pass=[0-9]+' "$OUT/negotiation.log" | grep -oE '[0-9]+$' || echo 0)"
  [ "${pass_n:-0}" -ge 55 ] || fail "negotiation harness ran only ${pass_n:-0} checks (floor 55)"
  for s in L M N1 N2 N3 N4 N5; do
    grep -qE "^SCENARIO $s => PASS" "$OUT/negotiation.log" || fail "negotiation harness: scenario $s not PASS"
  done
  grep -qE '^SYNTHETIC_ROWS_REMAINING=0' "$OUT/negotiation.log" || fail "negotiation harness left synthetic rows behind"
fi

# --- 3. financial offer invariant guard -------------------------------------------------------------
if run "financial offer invariant guard (incl. stacked + recovery)" "$OUT/guard.log" \
     psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 \
       -v ssot_migration=supabase/migrations/20270222150000_committed_offer_fare_sql_ssot.sql \
       -v migration=supabase/migrations/20270222160000_financial_offer_invariant_guard.sql \
       -v stacked_migration=supabase/migrations/20270222170000_financial_offer_invariant_guard_stacked_and_recovery.sql \
       -v global_offer_migration=supabase/migrations/20270222210000_global_offer_commission_base_pre_promotion.sql \
       -v warn_migration=supabase/migrations/20270222230000_financial_offer_invariant_warn_by_default.sql \
       -f supabase/tests/financial_offer_invariant_guard.sql; then
  grep -q 'ALL financial_offer_invariant_guard CHECKS PASSED' "$OUT/guard.log" || fail "guard test: success marker missing"
  n="$(grep -c 'PASS ' "$OUT/guard.log" || true)"
  [ "${n:-0}" -ge 60 ] || fail "guard test printed only ${n:-0} PASS lines (floor 60)"
  grep -q 'stacked' "$OUT/guard.log" || fail "guard test never exercised stacked offers"
fi

# --- 4. commissionable stamp -----------------------------------------------------------------------------
if run "airport split: commissionable follows payable (MK-007)" "$OUT/split.log" \
     psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 \
       -v migration=supabase/migrations/20270222190000_airport_split_commissionable_follows_payable.sql \
       -v global_offer_migration=supabase/migrations/20270222210000_global_offer_commission_base_pre_promotion.sql \
       -f supabase/tests/airport_split_commissionable_follows_payable.sql; then
  grep -q 'ALL airport_split_commissionable_follows_payable CHECKS PASSED' "$OUT/split.log" || fail "stamp test: success marker missing"
fi

# --- 5. SQL offer SSOT execution (vitest drives psql; must EXECUTE, not skip) ----------------------------------------
if run "SQL offer SSOT execution (vitest, rolled back)" "$OUT/ssot.log" \
     env LOCAL_DB_URL="$DB_URL" npx vitest run tests/committedOfferFareSqlExecution.test.ts --reporter=verbose; then
  grep -q 'SQL offer SSOT — execution (local DB, rolled back)' "$OUT/ssot.log" || fail "SSOT execution suite did not run"
  if grep -qE '↓|skipped' "$OUT/ssot.log"; then fail "SSOT execution suite was SKIPPED (no database?)"; fi
fi

# --- 6. ack-timeout sweep lock order (trip -> offer) + concurrency -----------------------------------------------
# Needs the migration APPLIED (real parallel sessions, not a rolled-back transaction). CI applies every repo
# migration newer than the baseline (pg-harness-bootstrap.sh); a stale local DB FAILS here, never skips.
if [ "$(psql "$DB_URL" -X -q -At -c "select position('trip_locked_or_missing' in pg_get_functiondef('public.process_ride_offer_ack_timeouts()'::regprocedure)) > 0")" != "t" ]; then
  fail "public.process_ride_offer_ack_timeouts() is the OLD offer->trip version: apply supabase/migrations/20270222220000_ack_timeout_sweep_trip_first_lock_order.sql to $DB_URL"
fi
if run "ack-timeout sweep lock order + concurrency (L, LB, A1, A1b, A2, A3)" "$OUT/acktimeout.log" \
     bash supabase/tests/ack_timeout_lock_order_concurrency_isolated.sh; then
  grep -qE '^TOTAL fail=0 pass=[0-9]+ skipped=0' "$OUT/acktimeout.log" || fail "ack-timeout harness: 'TOTAL fail=0 ... skipped=0' line missing"
  pass_n="$(grep -oE '^TOTAL fail=0 pass=[0-9]+' "$OUT/acktimeout.log" | grep -oE '[0-9]+$' || echo 0)"
  [ "${pass_n:-0}" -ge 40 ] || fail "ack-timeout harness ran only ${pass_n:-0} checks (floor 40)"
  for s in L LB A1 A1b A2 A3; do
    grep -qE "^SCENARIO $s => PASS" "$OUT/acktimeout.log" || fail "ack-timeout harness: scenario $s not PASS"
  done
  grep -qE '^SYNTHETIC_ROWS_REMAINING=0' "$OUT/acktimeout.log" || fail "ack-timeout harness left synthetic rows behind"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "PG GATES: FAILED (logs in $OUT)" >&2
  exit 1
fi
echo "PG GATES: ALL PASSED (logs in $OUT)"
