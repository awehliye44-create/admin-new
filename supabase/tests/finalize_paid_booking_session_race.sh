#!/usr/bin/env bash
# Concurrency certification for public.finalize_paid_booking_session.
#
# Starts a private throwaway Postgres (initdb in a temp dir, unix socket only), loads
# finalize_paid_booking_session_race.schema.sql plus the function under test, and drives
# real concurrent sessions. Never connects to a remote database.
#
# Usage:
#   supabase/tests/finalize_paid_booking_session_race.sh            # current migration, expects 0 failures
#   supabase/tests/finalize_paid_booking_session_race.sh --baseline # pre-release definition, expects the 4 known failures
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG_DIR="$HERE/../migrations"
FUNC_FILE="$MIG_DIR/20261207120000_finalize_paid_booking_same_booking_adopt.sql"
EXPECT_FAIL=0
if [ "${1:-}" = "--baseline" ]; then
  FUNC_FILE="$MIG_DIR/rollback/rollback_20261207120000_finalize_paid_booking_same_booking_adopt.sql"
  EXPECT_FAIL=4
fi

PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb || echo /opt/homebrew/opt/postgresql@17/bin/initdb)")}"
TMP="$(mktemp -d /tmp/fpbs_race.XXXXXX)"
PORT="${RACE_PG_PORT:-55441}"
cleanup() { "$PG_BIN/pg_ctl" -D "$TMP/data" stop -m fast >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$TMP/data" -U postgres --auth=trust -E UTF8 >/dev/null || { echo "initdb failed"; exit 2; }
"$PG_BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/pg.log" -w start >/dev/null || { echo "postgres start failed"; exit 2; }

P=(psql -h "$TMP" -p "$PORT" -U postgres -X -q -tA -v ON_ERROR_STOP=1)
PASS=0; FAIL=0
q() { "${P[@]}" -c "$1" 2>&1; }
ok() { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (got '$2' want '$3')"; fi; }

reset() {
  "${P[@]}" -f "$HERE/finalize_paid_booking_session_race.schema.sql" >/dev/null 2>&1 || { echo "schema load failed"; exit 2; }
  "${P[@]}" -f "$FUNC_FILE" >/dev/null 2>&1 || { echo "function load failed: $FUNC_FILE"; exit 2; }
  q "CREATE TABLE fail_flag(on_ boolean); INSERT INTO fail_flag VALUES (false);
     CREATE FUNCTION maybe_fail() RETURNS trigger LANGUAGE plpgsql AS \$\$
     BEGIN IF (SELECT on_ FROM fail_flag) THEN RAISE EXCEPTION 'SIMULATED_INSERT_FAILURE'; END IF; RETURN NEW; END \$\$;
     CREATE TRIGGER t_fail BEFORE INSERT ON trips FOR EACH ROW EXECUTE FUNCTION maybe_fail();" >/dev/null
}

S=11111111-1111-1111-1111-111111111111
C=22222222-2222-2222-2222-222222222222
CAI=fbd1cb98-ba29-4c88-810f-c03e9dc1d52d
ORD=6abff7a0-80f3-a88b-90db-3dee98c9bc96
fin() { q "SELECT public.finalize_paid_booking_session('$1')"; }
trips() { q "SELECT count(*) FROM trips"; }
disp() { q "SELECT count(*) FROM dispatch_log"; }
orders() { q "SELECT count(DISTINCT provider_order_id) FROM trips"; }
sess() { q "SELECT status||'|'||coalesce(trip_id::text,'null')||'|'||coalesce(metadata->>'never_capture','-')||'|'||provider_state FROM payment_sessions WHERE id='$S'"; }
one_each() { check "trips" "$(trips)" 1; check "payment orders" "$(orders)" 1; check "dispatches" "$(disp)" 1; }

echo "=== finalize_paid_booking_session race suite: $(basename "$FUNC_FILE") ==="

echo "1. CREATE-PREAUTH WINS (direct finalize, webhook later)"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
a=$(fin $S); b=$(fin $S)
check "same trip returned to webhook" "$b" "$a"
one_each
check "session" "$(sess)" "trip_created|$a|-|AUTHORISED"

echo "2. WEBHOOK WINS (create-preauth finalizes after webhook committed)"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
w=$(fin $S); p=$(fin $S)
check "create-preauth gets existing trip" "$p" "$w"
one_each

echo "3. SIMULTANEOUS finalize (session FOR UPDATE serialises)"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
( "${P[@]}" -c "BEGIN" -c "SELECT public.finalize_paid_booking_session('$S')" -c "SELECT pg_sleep(1.5)" -c "COMMIT" > "$TMP/a.out" 2>&1 ) &
sleep 0.3; t0=$(python3 -c 'import time;print(int(time.time()*1000))'); b=$(fin $S); t1=$(python3 -c 'import time;print(int(time.time()*1000))'); wait
a=$(head -1 "$TMP/a.out")
check "both resolve to same trip" "$b" "$a"
waited=$((t1-t0)); [ "$waited" -ge 900 ] && ok "second caller blocked on session lock (${waited} ms)" || bad "second caller did not block (${waited} ms)"
one_each

echo "4. CLIENT RESPONSE LOST (adopt by client_action_id; retry idempotent)"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
a=$(fin $S)
check "lookup by client_action_id finds same trip" "$(q "SELECT id FROM trips WHERE client_action_id='$CAI'")" "$a"
check "retry returns same trip" "$(fin $S)" "$a"
one_each

echo "5. FINALIZE FAILURE after AUTHORISED (insert failure) -> session untouched, webhook recovers"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
q "UPDATE fail_flag SET on_=true" >/dev/null
e=$(fin $S)
echo "$e" | grep -q SIMULATED_INSERT_FAILURE && ok "direct finalize raised" || bad "expected failure, got: $e"
check "session unchanged (not orphaned, not released)" "$(sess)" "authorised|null|-|AUTHORISED"
check "trips" "$(trips)" 0; check "dispatches" "$(disp)" 0
q "UPDATE fail_flag SET on_=false" >/dev/null
w=$(fin $S)
check "webhook fallback creates the trip" "$(q "SELECT trip_id FROM payment_sessions WHERE id='$S'")" "$w"
one_each

echo "6a. CTAP INSERT IN FLIGHT while finalize runs (same booking)"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
( "${P[@]}" -c "BEGIN" -c "SELECT ctap_insert('$S')" -c "SELECT pg_sleep(1.5)" -c "COMMIT" > "$TMP/c.out" 2>&1 ) &
sleep 0.3; f=$(fin $S); wait
c=$(head -1 "$TMP/c.out")
check "finalize resolves to the CTAP trip (no CUSTOMER_ALREADY_HAS_ACTIVE_TRIP)" "$f" "$c"
check "session linked, not orphaned" "$(sess)" "trip_created|$c|-|AUTHORISED"
one_each

echo "6b. FINALIZE IN FLIGHT while CTAP inserts"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
( "${P[@]}" -c "BEGIN" -c "SELECT public.finalize_paid_booking_session('$S')" -c "SELECT pg_sleep(1.5)" -c "COMMIT" > "$TMP/f.out" 2>&1 ) &
sleep 0.3; ce=$(q "SELECT ctap_insert('$S')"); wait
f=$(head -1 "$TMP/f.out")
echo "$ce" | grep -q "duplicate key" && ok "CTAP insert hit unique index (23505)" || bad "CTAP insert unexpected: $ce"
check "CTAP duplicate re-select by client_action_id = finalize trip" "$(q "SELECT id FROM trips WHERE client_action_id='$CAI'")" "$f"
one_each

echo "6c. CTAP COMMITS between finalize's session-trip check and live-trip check"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
( "${P[@]}" -c "BEGIN" -c "SELECT pg_advisory_xact_lock(hashtextextended('$C'::text,0))" -c "SELECT pg_sleep(1.5)" -c "COMMIT" >/dev/null 2>&1 ) &
sleep 0.2; ( fin $S > "$TMP/f.out" ) & sleep 0.3
c=$(q "SELECT ctap_insert('$S')"); wait
f=$(cat "$TMP/f.out")
check "finalize resolves to the CTAP trip" "$f" "$c"
check "session linked, not orphaned" "$(sess)" "trip_created|$c|-|AUTHORISED"
one_each

echo "7. DUPLICATE BOOK TAP"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
d=$(q "SELECT mk_session('33333333-3333-3333-3333-333333333333','$CAI','other-order','$C')")
echo "$d" | grep -q "duplicate key" && ok "second payment session for same client_action_id rejected" || bad "dup session: $d"
( fin $S > "$TMP/a.out" ) & ( fin $S > "$TMP/b.out" ) & ( q "SELECT ctap_insert('$S')" > "$TMP/c.out" ) & wait
check "concurrent finalize x2 same trip" "$(cat "$TMP/b.out")" "$(cat "$TMP/a.out")"
one_each

echo "8. GENUINE ORPHAN preserved: different live booking already committed"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
q "SELECT mk_session('44444444-4444-4444-4444-444444444444','other-cai','other-order','$C')" >/dev/null
o=$(q "SELECT ctap_insert('44444444-4444-4444-4444-444444444444')")
e=$(fin $S)
echo "$e" | grep -q "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP:$o" && ok "still fails closed with other trip id" || bad "expected fail-closed, got: $e"
check "no trip linked to this session" "$(q "SELECT coalesce(trip_id::text,'null') FROM payment_sessions WHERE id='$S'")" null

echo "8b. GENUINE ORPHAN race: different booking insert in flight"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
q "SELECT mk_session('44444444-4444-4444-4444-444444444444','other-cai','other-order','$C')" >/dev/null
( "${P[@]}" -c "BEGIN" -c "SELECT ctap_insert('44444444-4444-4444-4444-444444444444')" -c "SELECT pg_sleep(1.5)" -c "COMMIT" > "$TMP/c.out" 2>&1 ) &
sleep 0.3; e=$(fin $S); wait
echo "$e" | grep -q "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP" && ok "still fails closed" || bad "expected fail-closed, got: $e"
check "trips" "$(trips)" 1

echo "9. PARTIAL MATCH not adopted (same client_action_id, different order/session)"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
q "INSERT INTO trips (passenger_id,status,trip_type,client_action_id,payment_provider,provider_order_id) VALUES ('$C','cancelled','instant','$CAI','revolut','stale-order')" >/dev/null
e=$(fin $S)
echo "$e" | grep -q "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP" && ok "fails closed, stale trip not adopted" || bad "expected fail-closed, got: $e"
check "no trip linked" "$(q "SELECT coalesce(trip_id::text,'null') FROM payment_sessions WHERE id='$S'")" null

echo "9b. PARTIAL MATCH not adopted (same order/session, different passenger)"
reset; q "SELECT mk_session('$S','$CAI','$ORD','$C')" >/dev/null
( "${P[@]}" -c "BEGIN" -c "INSERT INTO trips (passenger_id,status,trip_type,client_action_id,payment_session_id,payment_provider,provider_order_id) VALUES ('55555555-5555-5555-5555-555555555555','searching','instant','$CAI','$S','revolut','$ORD')" -c "SELECT pg_sleep(1.5)" -c "COMMIT" >/dev/null 2>&1 ) &
sleep 0.3; e=$(fin $S); wait
echo "$e" | grep -q "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP" && ok "fails closed, other passenger's trip not adopted" || bad "expected fail-closed, got: $e"
check "no trip linked" "$(q "SELECT coalesce(trip_id::text,'null') FROM payment_sessions WHERE id='$S'")" null

echo "=== PASS=$PASS FAIL=$FAIL (expected failures: $EXPECT_FAIL) ==="
[ "$FAIL" -eq "$EXPECT_FAIL" ] || exit 1
