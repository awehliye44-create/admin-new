#!/usr/bin/env bash
# Certification for 20261208120000_payment_authorization_ledger_session_owner.sql.
#
# Starts a private throwaway Postgres (initdb in a temp dir, unix socket only), loads the
# finalize race fixture, the production-shaped overlay, the CURRENT finalize_paid_booking_session
# and the ledger migration, then drives booking lifecycles and real concurrent sessions.
# Never connects to a remote database.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG_DIR="$HERE/../migrations"
FINALIZE_FILE="$MIG_DIR/20261207120000_finalize_paid_booking_same_booking_adopt.sql"
LEDGER_FILE="$MIG_DIR/20261208120000_payment_authorization_ledger_session_owner.sql"
ROLLBACK_FILE="$MIG_DIR/rollback/rollback_20261208120000_payment_authorization_ledger_session_owner.sql"

PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb || echo /opt/homebrew/opt/postgresql@17/bin/initdb)")}"
TMP="$(mktemp -d /tmp/pal_ledger.XXXXXX)"
PORT="${LEDGER_PG_PORT:-55443}"
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
expect_err() { if echo "$2" | grep -q "$3"; then ok "$1"; else bad "$1 (got: $2)"; fi; }

reset() {
  "${P[@]}" -f "$HERE/finalize_paid_booking_session_race.schema.sql" >/dev/null 2>&1 || { echo "fixture load failed"; exit 2; }
  "${P[@]}" -f "$HERE/payment_authorization_ledger_session_owner.overlay.sql" >/dev/null || { echo "overlay load failed"; exit 2; }
  "${P[@]}" -f "$FINALIZE_FILE" >/dev/null 2>&1 || { echo "finalize load failed"; exit 2; }
  PGOPTIONS='-c client_min_messages=warning' "${P[@]}" -f "$LEDGER_FILE" >/dev/null || { echo "ledger migration failed"; exit 2; }
}

S=11111111-1111-1111-1111-111111111111
S2=33333333-3333-3333-3333-333333333333
C=22222222-2222-2222-2222-222222222222
CAI=fbd1cb98-ba29-4c88-810f-c03e9dc1d52d
ORD=6abff7a0-80f3-a88b-90db-3dee98c9bc96
fin() { q "SELECT public.finalize_paid_booking_session('$1')"; }
rows() { q "SELECT count(*) FROM payment_authorization_ledger WHERE operation='initial_auth'"; }
led() { q "SELECT status||'|'||coalesce(trip_id::text,'null')||'|'||coalesce(payment_session_id::text,'null')||'|'||coalesce(provider_order_id,'null')||'|'||amount_pence FROM payment_authorization_ledger WHERE idempotency_key='preauth_$CAI'"; }
created_by() { q "SELECT coalesce(metadata->>'created_by','-') FROM payment_authorization_ledger WHERE idempotency_key='preauth_$CAI'"; }
trips() { q "SELECT count(*) FROM trips"; }
disp() { q "SELECT count(*) FROM dispatch_log"; }

echo "=== payment_authorization_ledger session-owner suite ==="

echo "1. PRE-TRIP initial_auth write (create-preauth) succeeds with no trip"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null
r=$(q "SELECT preauth_ledger('$S')")
check "insert accepted" "$r" ""
check "row" "$(led)" "pending|null|$S|$ORD|750"
check "created by create-preauth, not backstop" "$(created_by)" "-"

echo "2. NO FAKE TRIP: invented ids and ownerless rows are still rejected"
e=$(q "INSERT INTO payment_authorization_ledger (trip_id, operation, idempotency_key, amount_pence) VALUES ('$CAI'::uuid, 'initial_auth', 'preauth_fake', 750)")
expect_err "client_action_id as trip_id -> FK violation" "$e" "payment_authorization_ledger_trip_id_fkey"
e=$(q "INSERT INTO payment_authorization_ledger (operation, idempotency_key, amount_pence) VALUES ('initial_auth', 'preauth_noowner', 750)")
expect_err "no trip and no session -> owner CHECK" "$e" "payment_authorization_ledger_owner_chk"
e=$(q "INSERT INTO payment_authorization_ledger (payment_session_id, operation, idempotency_key, amount_pence) VALUES ('$S', 'top_up', 'topup_x', 100)")
expect_err "top_up without a trip -> owner CHECK" "$e" "payment_authorization_ledger_owner_chk"
e=$(q "INSERT INTO payment_authorization_ledger (payment_session_id, operation, idempotency_key, amount_pence) VALUES ('99999999-9999-9999-9999-999999999999', 'initial_auth', 'preauth_ghost', 100)")
expect_err "unknown session -> session FK" "$e" "payment_authorization_ledger_payment_session_id_fkey"

echo "3. DUPLICATE initial_auth stays idempotent"
e=$(q "SELECT preauth_ledger('$S')")
expect_err "same key retry -> 23505 (writer maps to duplicate)" "$e" "duplicate key"
e=$(q "INSERT INTO payment_authorization_ledger (payment_session_id, operation, idempotency_key, amount_pence) VALUES ('$S','initial_auth','preauth_other_key',750)")
expect_err "second initial_auth for the same session rejected" "$e" "payment_authorization_ledger_session_initial_auth_uidx"
check "still one row" "$(rows)" 1

echo "4. AUTHORISED then FINALIZE: succeeded, trip stamped in the finalize transaction"
q "SELECT authorise('$S')" >/dev/null
check "authorised -> succeeded, no trip yet" "$(led)" "succeeded|null|$S|$ORD|750"
t=$(fin $S)
check "trip stamped = finalize trip" "$(led)" "succeeded|$t|$S|$ORD|750"
check "one trip" "$(trips)" 1; check "one dispatch" "$(disp)" 1; check "one ledger row" "$(rows)" 1

echo "5. SAME-BOOKING RETRY"
t2=$(fin $S)
check "retry returns same trip" "$t2" "$t"
check "still one ledger row" "$(rows)" 1; check "one dispatch" "$(disp)" 1

echo "6. WEBHOOK / DIRECT-FINALIZE RACE (session FOR UPDATE serialises)"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null; q "SELECT preauth_ledger('$S')" >/dev/null; q "SELECT authorise('$S')" >/dev/null
( "${P[@]}" -c "BEGIN" -c "SELECT public.finalize_paid_booking_session('$S')" -c "SELECT pg_sleep(1.2)" -c "COMMIT" > "$TMP/a.out" 2>&1 ) &
sleep 0.3; b=$(fin $S); wait
a=$(head -1 "$TMP/a.out")
check "both callers resolve to same trip" "$b" "$a"
check "ledger stamped once" "$(led)" "succeeded|$a|$S|$ORD|750"
check "one trip" "$(trips)" 1; check "one dispatch" "$(disp)" 1; check "one ledger row" "$(rows)" 1

echo "6b. CONFIRM + WEBHOOK both mark the session authorised concurrently"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null; q "SELECT preauth_ledger('$S')" >/dev/null
( "${P[@]}" -c "BEGIN" -c "SELECT authorise('$S')" -c "SELECT pg_sleep(1.0)" -c "COMMIT" > /dev/null 2>&1 ) &
sleep 0.3; q "SELECT authorise('$S')" >/dev/null; wait
check "one succeeded row" "$(led)" "succeeded|null|$S|$ORD|750"; check "rows" "$(rows)" 1

echo "7. BACKSTOP: create-preauth write missing -> trigger records it, tagged"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null
q "SELECT authorise('$S')" >/dev/null
check "backstop row succeeded" "$(led)" "succeeded|null|$S|$ORD|750"
check "tagged as backstop" "$(created_by)" "payment_sessions_trigger_backstop"
t=$(fin $S)
check "trip stamped" "$(led)" "succeeded|$t|$S|$ORD|750"

echo "8. FAILURE before authorisation; late provider authorisation wins"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null; q "SELECT preauth_ledger('$S')" >/dev/null
q "UPDATE payment_sessions SET status='failed', failure_reason='REVOLUT_FAILED' WHERE id='$S'" >/dev/null
check "failed" "$(q "SELECT status||'|'||error_message FROM payment_authorization_ledger WHERE payment_session_id='$S'")" "failed|session_failed: REVOLUT_FAILED"
q "UPDATE payment_sessions SET provider_state='AUTHORISED' WHERE id='$S'" >/dev/null
check "late provider AUTHORISED -> succeeded" "$(q "SELECT status FROM payment_authorization_ledger WHERE payment_session_id='$S'")" "succeeded"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null; q "SELECT preauth_ledger('$S')" >/dev/null
q "UPDATE payment_sessions SET status='cancelled' WHERE id='$S'" >/dev/null
check "cancelled before auth -> failed" "$(q "SELECT status FROM payment_authorization_ledger WHERE payment_session_id='$S'")" "failed"

echo "9. CANCEL / RELEASE after authorisation keeps succeeded"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null; q "SELECT preauth_ledger('$S')" >/dev/null; q "SELECT authorise('$S')" >/dev/null
q "UPDATE payment_sessions SET status='cancelled' WHERE id='$S'" >/dev/null
q "UPDATE payment_sessions SET status='released', provider_state='CANCELLED' WHERE id='$S'" >/dev/null
check "still succeeded" "$(q "SELECT status FROM payment_authorization_ledger WHERE payment_session_id='$S'")" "succeeded"

echo "10. COMPLETION RE-HOLD moves the session to a new order; ledger keeps the original"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null; q "SELECT preauth_ledger('$S')" >/dev/null; q "SELECT authorise('$S')" >/dev/null
t=$(fin $S)
q "UPDATE payment_sessions SET provider_order_id='rehold-order', status='ADDITIONAL_AUTHORISATION_CONFIRMED', authorised_amount_pence=900 WHERE id='$S'" >/dev/null
check "original order and amount kept" "$(led)" "succeeded|$t|$S|$ORD|750"; check "rows" "$(rows)" 1

echo "11. CTAP path: trip-owned write adopted by the session (both orders)"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null
c=$(q "SELECT ctap_insert('$S')")
q "SELECT ctap_ledger('$S','$c')" >/dev/null
q "SELECT ctap_dispatching('$S','$c')" >/dev/null
check "CTAP row adopted (session set), succeeded, trip" "$(led)" "succeeded|$c|$S|$ORD|750"; check "rows" "$(rows)" 1
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null; q "SELECT preauth_ledger('$S')" >/dev/null
c=$(q "SELECT ctap_insert('$S')")
q "SELECT ctap_dispatching('$S','$c')" >/dev/null
e=$(q "SELECT ctap_ledger('$S','$c')")
expect_err "CTAP write after session link -> duplicate (idempotent)" "$e" "duplicate key"
check "dispatching -> succeeded + trip" "$(led)" "succeeded|$c|$S|$ORD|750"; check "rows" "$(rows)" 1

echo "12. LEGACY rows remain valid and readable"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null; q "SELECT authorise('$S')" >/dev/null; t=$(fin $S)
q "INSERT INTO payment_authorization_ledger (trip_id, operation, idempotency_key, amount_pence, status, metadata) VALUES ('$t','initial_auth','preauth_$t',750,'succeeded', jsonb_build_object('provider','revolut','provider_order_id','legacy-order'))" >/dev/null
check "legacy row readable" "$(q "SELECT status||'|'||coalesce(payment_session_id::text,'null') FROM payment_authorization_ledger WHERE idempotency_key='preauth_$t'")" "succeeded|null"
check "metadata provider_order_id lookup finds session row" "$(q "SELECT count(*) FROM payment_authorization_ledger WHERE metadata @> '{\"provider_order_id\":\"$ORD\"}'")" 1
check "provider_order_id column lookup" "$(q "SELECT count(*) FROM payment_authorization_ledger WHERE provider_order_id='$ORD'")" 1

echo "13. AUTHENTICATED writer under RLS: trigger still records (SECURITY DEFINER)"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null
r=$("${P[@]}" -c "SET ROLE authenticated" -c "UPDATE payment_sessions SET status='authorised_hold', provider_state='AUTHORISED' WHERE id='$S'" 2>&1)
check "update as authenticated accepted" "$r" ""
check "ledger written" "$(led)" "succeeded|null|$S|$ORD|750"
e=$("${P[@]}" -c "SET ROLE authenticated" -c "SELECT count(*) FROM payment_authorization_ledger" 2>&1)
expect_err "authenticated still cannot read the ledger" "$e" "permission denied"
e=$("${P[@]}" -c "SET ROLE authenticated" -c "SELECT public.payment_session_has_authorisation_evidence('x', null, null)" 2>&1)
expect_err "authenticated cannot execute the helper" "$e" "permission denied"

echo "14. FAIL CLOSED: a ledger failure aborts the session write"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null
q "ALTER TABLE payment_authorization_ledger ADD CONSTRAINT sim_fail CHECK (amount_pence < 0) NOT VALID" >/dev/null
e=$(q "SELECT authorise('$S')")
expect_err "authorise raised" "$e" "sim_fail"
check "session unchanged" "$(q "SELECT status||'|'||provider_state||'|'||coalesce(authorised_at::text,'null') FROM payment_sessions WHERE id='$S'")" "pending_payment|PENDING|null"
q "ALTER TABLE payment_authorization_ledger DROP CONSTRAINT sim_fail" >/dev/null
q "SELECT authorise('$S')" >/dev/null
check "retry succeeds" "$(led)" "succeeded|null|$S|$ORD|750"
q "SELECT mk_pending('$S2','other-cai','other-order','$C')" >/dev/null; q "SELECT authorise('$S2')" >/dev/null
q "ALTER TABLE payment_authorization_ledger ADD CONSTRAINT sim_fail CHECK (trip_id IS NULL) NOT VALID" >/dev/null
e=$(fin $S2)
expect_err "finalize raised" "$e" "sim_fail"
check "no trip, no dispatch for that session" "$(q "SELECT count(*) FROM trips WHERE client_action_id='other-cai'")|$(disp)" "0|0"
check "session not linked" "$(q "SELECT coalesce(trip_id::text,'null')||'|'||status FROM payment_sessions WHERE id='$S2'")" "null|authorised_hold"
q "ALTER TABLE payment_authorization_ledger DROP CONSTRAINT sim_fail" >/dev/null

echo "15. SESSION DELETE: RESTRICT once a ledger row exists; orderless pending sessions still deletable"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null; q "SELECT preauth_ledger('$S')" >/dev/null
e=$(q "DELETE FROM payment_sessions WHERE id='$S'")
expect_err "delete blocked" "$e" "payment_authorization_ledger_payment_session_id_fkey"
q "INSERT INTO payment_sessions (id, client_action_id, payment_provider, idempotency_key) VALUES ('$S2','orderless','revolut','preauth_orderless')" >/dev/null
check "orderless pending session delete (rollbackOrphanPendingPaymentSession)" "$(q "DELETE FROM payment_sessions WHERE id='$S2' AND status='pending_payment' AND provider_order_id IS NULL")" ""
check "no ledger row for orderless session" "$(q "SELECT count(*) FROM payment_authorization_ledger WHERE payment_session_id='$S2'")" 0

echo "16. NON-BOOKING sessions are ignored"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C','SAVE_CARD')" >/dev/null; q "SELECT authorise('$S')" >/dev/null
check "SAVE_CARD writes no ledger row" "$(rows)" 0
q "SELECT mk_pending('$S2','rec-cai','rec-order','$C','PAYMENT_RECOVERY')" >/dev/null; q "SELECT authorise('$S2')" >/dev/null
check "PAYMENT_RECOVERY writes no ledger row" "$(rows)" 0

echo "17. CORPORATE booking uses the same session-owned path"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null
q "UPDATE payment_sessions SET buffer_pence=0, booking_snapshot = booking_snapshot || '{\"booking_source\":\"corporate_portal\",\"buffer_pence\":0}' WHERE id='$S'" >/dev/null
q "SELECT preauth_ledger('$S')" >/dev/null; q "SELECT authorise('$S')" >/dev/null; t=$(fin $S)
check "corporate ledger stamped" "$(q "SELECT status||'|'||(trip_id='$t') FROM payment_authorization_ledger WHERE payment_session_id='$S'")" "succeeded|true"

echo "18. ROLLBACK keeps audit evidence; forward migration re-applies cleanly"
reset; q "SELECT mk_pending('$S','$CAI','$ORD','$C')" >/dev/null; q "SELECT preauth_ledger('$S')" >/dev/null
out=$("${P[@]}" -f "$ROLLBACK_FILE" 2>&1)
expect_err "rollback retains columns when session rows exist" "$out" "session-owned rows exist"
check "trigger gone" "$(q "SELECT count(*) FROM pg_trigger WHERE tgname='trg_payment_session_ledger_sync'")" 0
check "row preserved" "$(led)" "pending|null|$S|$ORD|750"
"${P[@]}" -f "$LEDGER_FILE" >/dev/null 2>&1 && ok "forward migration re-applied" || bad "forward re-apply failed"
q "SELECT authorise('$S')" >/dev/null
check "trigger active again" "$(led)" "succeeded|null|$S|$ORD|750"
reset
"${P[@]}" -f "$ROLLBACK_FILE" >/dev/null 2>&1
check "empty ledger rollback restores trip_id NOT NULL" "$(q "SELECT is_nullable FROM information_schema.columns WHERE table_name='payment_authorization_ledger' AND column_name='trip_id'")" "NO"
check "session column removed" "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='payment_authorization_ledger' AND column_name='payment_session_id'")" 0

echo "=== PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
