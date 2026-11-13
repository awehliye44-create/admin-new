#!/usr/bin/env bash
# =============================================================================
# Negotiation lock-order / concurrency harness (LOCAL Supabase DB only).
#
#   bash supabase/tests/negotiation_lock_order_concurrency_isolated.sh
#   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres  (default)
#
# Requires migration 20270222180000_negotiation_rpc_trip_first_lock_order.sql.
#
#   L  lock-order proof (deterministic): while a session holds the TRIP lock, each negotiation RPC
#      must wait on the trip WITHOUT holding the offer row (NOWAIT probe on the offer succeeds).
#      Under the old offer->trip order the probe reports 'locked' and the scenario FAILS.
#   N1 negotiation vs acceptance        (customer counter  vs  competing driver accept)
#   N2 negotiation vs cancellation      (counter vs admin cancel; driver preset vs customer cancel)
#   N3 counter-offer vs reassignment    (counter on a stale offer vs driver_cancel_before_start_rematch)
#   N4 duplicate negotiation actions    (2x counter, 2x driver preset, 2x customer decline grace)
#   N5 expired negotiation vs acceptance(expire_negotiation_offer vs accept_ride_offer)
#   M  bounded retry + domain error (fault-injected real 40P01), run by the verify script.
#
# - Refuses any non-local DB_URL.       - No Edge / Revolut / push calls (pure SQL RPCs).
# - Two (or more) REAL parallel psql sessions per race, released by a shared clock barrier; "hold"
#   modes keep the winner's locks open so the loser genuinely blocks and re-evaluates (READ COMMITTED).
# - Synthetic rows only (ids 00000000-0000-4000-{8100,9100,a100,b100}-*, client_action_id TEST-NEG-*),
#   removed in the EXIT trap; synthetic-row residue must be 0.
# - Exit code != 0 on any FAIL, any SKIPPED check, a missing RPC / schema, or a failed worker.
# =============================================================================
set -uo pipefail
export PATH=/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
HERE="$(cd "$(dirname "$0")" && pwd)"
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
HOLD_MS="${NEG_HOLD_MS:-400}"
DELAY_MS="${NEG_DELAY_MS:-100}"
SETUP_SQL="$HERE/negotiation_lock_order_isolated.setup.sql"
VERIFY_SQL="${NEG_VERIFY_SQL:-$HERE/negotiation_lock_order_isolated.sql}"
WORK="$(mktemp -d)"

case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*|*@127.0.0.1/*|*@localhost/*) ;;
  *) echo "REFUSING: DB_URL must be a LOCAL database (127.0.0.1/localhost). Got: $DB_URL" >&2; exit 2 ;;
esac

PSQL=(psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=1)

CLEANED=0
finally_cleanup() {
  local rc=$?
  if [ "$CLEANED" = "0" ]; then
    CLEANED=1
    echo
    echo "=== FINALLY: cleanup synthetic rows (TEST-NEG-*) ==="
    psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -v cleanup_only=1 -f "$SETUP_SQL" 2>&1 | grep -v '^$' || true
    local left
    left=$("${PSQL[@]}" -c "select (select count(*) from trips where id::text like '00000000-0000-4000-8100-%')
                                 +(select count(*) from drivers where id::text like '00000000-0000-4000-b100-%')
                                 +(select count(*) from payment_sessions where id::text like '00000000-0000-4000-a100-%')
                                 +(select count(*) from customers where id::text like '00000000-0000-4000-9100-%')
                                 +(select count(*) from ride_offers where trip_id::text like '00000000-0000-4000-8100-%')" 2>/dev/null || echo "?")
    echo "SYNTHETIC_ROWS_REMAINING=$left"
    if [ "$left" != "0" ] && [ $rc -eq 0 ]; then rc=5; fi
  fi
  rm -rf "$WORK"
  exit $rc
}
trap finally_cleanup EXIT

echo "=== negotiation lock-order / concurrency harness ==="
echo "db      : ${DB_URL%%:*}://…@$(echo "$DB_URL" | sed -E 's#.*@##')"
echo "psql    : $(psql --version)"
echo "server  : $("${PSQL[@]}" -c 'select version()' | cut -c1-60)"
echo "started : $(date -u +%FT%TZ)"

psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -v cleanup_only=1 -f "$SETUP_SQL" >/dev/null 2>&1 || true

echo
echo "=== SETUP ==="
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$SETUP_SQL" 2>&1 | grep -v -E '^\s*$|^-+$|^\s+1$|^\(1 row\)|drivers_created' || true
# grep above swallows the exit code: re-check the schema really exists.
if [ "$("${PSQL[@]}" -c "select to_regclass('neg_iso.worker_out') is not null")" != "t" ]; then
  echo "SETUP FAILED (neg_iso schema missing)"; exit 4
fi

# ---------------------------------------------------------------------------
# Worker SQL (each statement autocommits, exactly like separate PostgREST calls)
# ---------------------------------------------------------------------------
read -r -d '' SQL_ACT <<'SQL'
select pg_sleep(greatest(0, extract(epoch from (:'t0'::timestamptz - clock_timestamp())) + :delay/1000.0)) \gset
select clock_timestamp()::text as ts \gset
select neg_iso.act(:'action', :'trip'::uuid, nullif(:'offer', '')::uuid, nullif(:'drv', '')::uuid, :fare, :hold)::text as r \gset
select neg_iso.rec(:'scn', :iter, :'w', :'action', :'r'::jsonb, :'ts'::timestamptz) \gset
SQL

read -r -d '' SQL_HOLD_TRIP <<'SQL'
begin;
select 1 as x from public.trips where id = :'trip'::uuid for update \gset
select pg_sleep(:hold/1000.0) \gset
commit;
SQL

read -r -d '' SQL_PROBE <<'SQL'
select pg_sleep(greatest(0, extract(epoch from (:'t0'::timestamptz - clock_timestamp())) + :delay/1000.0)) \gset
select clock_timestamp()::text as ts \gset
select neg_iso.probe_offer_lock(:'offer'::uuid) as p \gset
select neg_iso.rec(:'scn', :iter, :'w', 'probe_offer_lock', jsonb_build_object('probe', :'p'), :'ts'::timestamptz) \gset
SQL

PIDS=()
BAD_WORKERS=0
# spawn <SQLVAR> scn iter worker trip offer drv action fare t0 delay hold
spawn() {
  local sqlvar="$1" scn="$2" iter="$3" w="$4" trip="$5" offer="$6" drv="$7" action="$8" fare="$9" t0="${10}" delay="${11}" hold="${12}"
  (
    printf '%s\n' "${!sqlvar}" | psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=0 \
      -v scn="$scn" -v iter="$iter" -v w="$w" -v trip="$trip" -v offer="$offer" -v drv="$drv" \
      -v action="$action" -v fare="$fare" -v t0="$t0" -v delay="$delay" -v hold="$hold" -f - \
      >"$WORK/w.$scn.$iter.$w.out" 2>"$WORK/w.$scn.$iter.$w.err"
  ) &
  PIDS+=($!)
}
join_workers() {
  local p
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && { wait "$p" || BAD_WORKERS=$((BAD_WORKERS + 1)); }; done
  PIDS=()
}
barrier() { "${PSQL[@]}" -c "select (clock_timestamp() + interval '700 ms')::text"; }
sql() { "${PSQL[@]}" -c "$1" >/dev/null; }
tid() { "${PSQL[@]}" -c "select neg_iso.uid('t', $1)"; }
did() { "${PSQL[@]}" -c "select neg_iso.uid('d', $1)"; }
mk() { "${PSQL[@]}" -c "select neg_iso.mk_trip($1, '$2', '$3', $4)"; }       # n variant scn iter
off() { "${PSQL[@]}" -c "select neg_iso.offer_of('$1'::uuid, $2)"; }          # trip driver_n
D1="$(did 1)"; D2="$(did 2)"; D3="$(did 3)"

# mode -> (delay/hold of worker A, delay/hold of worker B). A is the "negotiation" side.
modes() {  # echo "ad ah bd bh" for a mode
  case "$1" in
    free)    echo "0 0 0 0" ;;
    a_holds) echo "0 $HOLD_MS $DELAY_MS 0" ;;
    b_holds) echo "$DELAY_MS 0 0 $HOLD_MS" ;;
  esac
}

# ---------------------------------------------------------------------------
# L. Lock-order proof (deterministic)  (trip ids 50+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN L: lock-order proof — 6 negotiation RPCs wait on the TRIP lock without holding the OFFER row ==="
i=0
for spec in counter:negotiating:1:570 send_preset:preset_pending:1:570 driver_cancel_neg:negotiating:1:0 \
            expire:negotiating:1:0 decline:negotiating:1:0 grace:negotiating:1:0; do
  IFS=: read -r action variant dn fare <<<"$spec"
  i=$((i + 1)); n=$((50 + i)); trip="$(mk $n "$variant" L $i)"; offer="$(off "$trip" "$dn")"
  t0="$(barrier)"
  # H takes the trip lock at spawn and holds it ~2.3s (until ~t0+1.6s); the RPC under test starts 200ms later and must queue on the trip.
  spawn SQL_HOLD_TRIP L $i holder "$trip" "" "" hold 0 "$t0" 0 2300
  spawn SQL_ACT       L $i rpc    "$trip" "$offer" "$D1" "$action" "$fare" "$t0" 200 0
  # Probe at ~t0+800ms: is the offer row free while the RPC is queued behind the trip lock?
  spawn SQL_PROBE     L $i probe  "$trip" "$offer" "" probe 0 "$t0" 800 0
  join_workers
done
echo "L: $i RPCs probed"

# ---------------------------------------------------------------------------
# N1. Negotiation vs acceptance  (trip ids 100+)
#   N1a: A = customer counter on D1's waiting_customer offer ; B = customer ACCEPTS that same driver offer
#   N1b: A = customer counter ;                                B = competing driver D2 accepts its own offer
# ---------------------------------------------------------------------------
echo
echo "=== RUN N1: customer counter-offer vs acceptance — 6 same-offer + 6 competing-driver races ==="
i=0
for grp in same other; do
  for mode in free a_holds b_holds; do
    for rep in 1 2; do
      i=$((i + 1)); n=$((100 + i)); trip="$(mk $n negotiating N1 $i)"
      o1="$(off "$trip" 1)"; o2="$(off "$trip" 2)"
      read -r ad ah bd bh <<<"$(modes $mode)"
      [ "$mode" = free ] && bd=$(( (rep - 1) * 14 ))
      t0="$(barrier)"
      spawn SQL_ACT N1 $i counter "$trip" "$o1" "$D1" counter 570 "$t0" $ad $ah
      if [ "$grp" = same ]; then
        spawn SQL_ACT N1 $i accept "$trip" "$o1" "$D1" accept_offer 0 "$t0" $bd $bh
      else
        spawn SQL_ACT N1 $i accept "$trip" "$o2" "$D2" accept_offer 0 "$t0" $bd $bh
      fi
      join_workers
    done
  done
done
echo "N1: $i races executed"

# ---------------------------------------------------------------------------
# N2. Negotiation vs cancellation  (trip ids 200+ / 250+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN N2: negotiation vs cancellation — 9 counter-vs-admin-cancel + 6 preset-vs-customer-cancel races ==="
i=0
for mode in free a_holds b_holds; do
  for rep in 1 2 3; do
    i=$((i + 1)); n=$((200 + i)); trip="$(mk $n negotiating N2 $i)"; o1="$(off "$trip" 1)"
    read -r ad ah bd bh <<<"$(modes $mode)"
    [ "$mode" = free ] && bd=$(( (rep - 1) * 15 ))
    t0="$(barrier)"
    spawn SQL_ACT N2 $i counter      "$trip" "$o1" "$D1" counter      570 "$t0" $ad $ah
    spawn SQL_ACT N2 $i admin_cancel "$trip" ""    ""    admin_cancel 0   "$t0" $bd $bh
    join_workers
  done
done
for mode in free a_holds b_holds; do
  for rep in 1 2; do
    i=$((i + 1)); n=$((200 + i)); trip="$(mk $n preset_pending N2 $i)"; o1="$(off "$trip" 1)"
    read -r ad ah bd bh <<<"$(modes $mode)"
    [ "$mode" = free ] && bd=$(( (rep - 1) * 15 ))
    t0="$(barrier)"
    spawn SQL_ACT N2 $i send_preset     "$trip" "$o1" "$D1" send_preset     570 "$t0" $ad $ah
    spawn SQL_ACT N2 $i customer_cancel "$trip" ""    ""    customer_cancel 0   "$t0" $bd $bh
    join_workers
  done
done
echo "N2: $i races executed"

# ---------------------------------------------------------------------------
# N3. Counter-offer vs reassignment  (trip ids 300+)
#   A = customer counter on a stale waiting_customer offer (D3) ; B = D1 (assigned) cancels -> rematch
# ---------------------------------------------------------------------------
echo
echo "=== RUN N3: customer counter-offer vs driver reassignment (rematch) — 9 races ==="
i=0
for mode in free a_holds b_holds; do
  for rep in 1 2 3; do
    i=$((i + 1)); n=$((300 + i)); trip="$(mk $n assigned_stale N3 $i)"; o3="$(off "$trip" 3)"
    read -r ad ah bd bh <<<"$(modes $mode)"
    [ "$mode" = free ] && bd=$(( (rep - 1) * 20 ))
    t0="$(barrier)"
    spawn SQL_ACT N3 $i counter "$trip" "$o3" "$D3" counter 570 "$t0" $ad $ah
    spawn SQL_ACT N3 $i rematch "$trip" ""    "$D1" rematch 0   "$t0" $bd $bh
    join_workers
  done
done
echo "N3: $i races executed"

# ---------------------------------------------------------------------------
# N4. Duplicate negotiation actions  (trip ids 400+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN N4: duplicate negotiation actions — 4x double counter, 4x double driver preset, 4x double decline-grace ==="
i=0
for spec in counter:negotiating:1:570 send_preset:preset_pending:1:570 grace:negotiating:1:0; do
  IFS=: read -r action variant dn fare <<<"$spec"
  for rep in 1 2 3 4; do
    i=$((i + 1)); n=$((400 + i)); trip="$(mk $n "$variant" N4 $i)"; o1="$(off "$trip" $dn)"
    t0="$(barrier)"
    if [ $((rep % 2)) -eq 0 ]; then h1=$HOLD_MS; d2=$DELAY_MS; else h1=0; d2=$(( (rep - 1) * 10 )); fi
    spawn SQL_ACT N4 $i a1 "$trip" "$o1" "$D1" "$action" "$fare" "$t0" 0   $h1
    spawn SQL_ACT N4 $i a2 "$trip" "$o1" "$D1" "$action" "$fare" "$t0" $d2 0
    join_workers
  done
done
echo "N4: $i races executed"

# ---------------------------------------------------------------------------
# N5. Expired negotiation vs acceptance  (trip ids 500+)
#   O1 is waiting_driver_final (customer countered 570): D1 accepts the customer counter  vs  expiry sweep.
# ---------------------------------------------------------------------------
echo
echo "=== RUN N5: expired negotiation vs acceptance — 12 races ==="
i=0
for mode in free a_holds b_holds; do
  for rep in 1 2 3 4; do
    i=$((i + 1)); n=$((500 + i)); trip="$(mk $n waiting_final N5 $i)"; o1="$(off "$trip" 1)"
    # A = expire (the sweeper) ; B = accept
    read -r ad ah bd bh <<<"$(modes $mode)"
    [ "$mode" = free ] && bd=$(( (rep - 1) * 12 ))
    t0="$(barrier)"
    spawn SQL_ACT N5 $i expire "$trip" "$o1" ""    expire 0 "$t0" $ad $ah
    spawn SQL_ACT N5 $i accept "$trip" "$o1" "$D1" accept 0 "$t0" $bd $bh
    join_workers
  done
done
echo "N5: $i races executed"

echo
echo "=== WORKER HEALTH ==="
echo "psql worker non-zero exits: $BAD_WORKERS"
cat "$WORK"/w.*.err 2>/dev/null | grep -v '^$' | sort | uniq -c | sort -rn | head -10 || true

echo
echo "=== VERIFY ==="
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -v bad_workers="$BAD_WORKERS" -f "$VERIFY_SQL"
VRC=$?
echo
echo "VERIFY_EXIT=$VRC"
exit $VRC
