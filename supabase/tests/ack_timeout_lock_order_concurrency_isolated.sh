#!/usr/bin/env bash
# =============================================================================
# process_ride_offer_ack_timeouts lock-order / concurrency harness (LOCAL DB only).
#
#   bash supabase/tests/ack_timeout_lock_order_concurrency_isolated.sh
#   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres  (default)
#
# Requires 20270222180000 (negotiation RPCs) + 20270222220000 (ack-timeout sweep trip-first).
# Reuses the negotiation harness fixtures (neg_iso schema, synthetic ids, cleanup).
#
#   L   lock-order proof (deterministic): while a session holds the TRIP lock, the sweep must NOT wait
#       and must NOT hold the OFFER row (NOWAIT probe on the offer succeeds); the trip is skipped and a
#       later sweep expires the offer.  Under the old offer->trip order the probe reports 'locked' and the
#       sweep blocks behind the trip lock.
#   LB  offer lock held elsewhere: the sweep skips (never waits); the next sweep expires it.
#   A1  ack-timeout vs ACCEPT           (due offer: sweep vs driver accept; 9 races)
#   A1b ack-timeout vs ACCEPT at the expiry boundary (accept starts before expires_at and holds; the
#       sweep must skip, never expire an offer that is being accepted; 3 races)
#   A2  ack-timeout vs CANCEL           (sweep vs customer cancellation; 6 races)
#   A3  ack-timeout vs NEGOTIATION      (sweep vs driver_send_preset_offer, sweep vs driver decline; 12 races)
#
# - Refuses any non-local DB_URL.       - Pure SQL RPCs (no Edge / Revolut / push).
# - Two REAL parallel psql sessions per race, released by a shared clock barrier; "hold" modes keep the
#   winner's locks open so the loser genuinely contends.
# - Synthetic rows only (removed in the EXIT trap; residue must be 0).
# - Exit != 0 on any FAIL, any SKIPPED check, a missing RPC / schema, or a failed worker.
# =============================================================================
set -uo pipefail
export PATH=/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
HERE="$(cd "$(dirname "$0")" && pwd)"
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
HOLD_MS="${ACK_HOLD_MS:-400}"
DELAY_MS="${ACK_DELAY_MS:-100}"
NEG_SETUP="$HERE/negotiation_lock_order_isolated.setup.sql"
ACK_SETUP="$HERE/ack_timeout_lock_order_isolated.setup.sql"
VERIFY_SQL="$HERE/ack_timeout_lock_order_isolated.sql"
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
    psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -v cleanup_only=1 -f "$NEG_SETUP" 2>&1 | grep -v '^$' || true
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

echo "=== ack-timeout sweep lock-order / concurrency harness ==="
echo "db      : ${DB_URL%%:*}://…@$(echo "$DB_URL" | sed -E 's#.*@##')"
echo "psql    : $(psql --version)"
echo "server  : $("${PSQL[@]}" -c 'select version()' | cut -c1-60)"
echo "started : $(date -u +%FT%TZ)"

psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -v cleanup_only=1 -f "$NEG_SETUP" >/dev/null 2>&1 || true

echo
echo "=== SETUP ==="
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$NEG_SETUP" 2>&1 | grep -v -E '^\s*$|^-+$|^\s+1$|^\(1 row\)|drivers_created' || true
if [ "$("${PSQL[@]}" -c "select to_regclass('neg_iso.worker_out') is not null")" != "t" ]; then
  echo "SETUP FAILED (neg_iso schema missing)"; exit 4
fi
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$ACK_SETUP" 2>&1 | grep -v -E '^\s*$' || true
if [ "$("${PSQL[@]}" -c "select to_regprocedure('neg_iso.ack_act(text,uuid,uuid,uuid,integer)') is not null")" != "t" ]; then
  echo "ACK SETUP FAILED (neg_iso.ack_act missing)"; exit 4
fi

# ---------------------------------------------------------------------------
# Worker SQL (each statement autocommits, like separate PostgREST / cron calls)
# ---------------------------------------------------------------------------
read -r -d '' SQL_ACT <<'SQL'
select pg_sleep(greatest(0, extract(epoch from (:'t0'::timestamptz - clock_timestamp())) + :delay/1000.0)) \gset
select clock_timestamp()::text as ts \gset
select neg_iso.ack_act(:'action', :'trip'::uuid, nullif(:'offer', '')::uuid, nullif(:'drv', '')::uuid, :hold)::text as r \gset
select neg_iso.rec(:'scn', :iter, :'w', :'action', :'r'::jsonb, :'ts'::timestamptz) \gset
SQL

read -r -d '' SQL_HOLD_TRIP <<'SQL'
begin;
select 1 as x from public.trips where id = :'trip'::uuid for update \gset
select pg_sleep(:hold/1000.0) \gset
commit;
SQL

read -r -d '' SQL_HOLD_OFFER <<'SQL'
begin;
select 1 as x from public.ride_offers where id = :'offer'::uuid for update \gset
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
# spawn <SQLVAR> scn iter worker trip offer drv action t0 delay hold
spawn() {
  local sqlvar="$1" scn="$2" iter="$3" w="$4" trip="$5" offer="$6" drv="$7" action="$8" t0="$9" delay="${10}" hold="${11}"
  (
    printf '%s\n' "${!sqlvar}" | psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=0 \
      -v scn="$scn" -v iter="$iter" -v w="$w" -v trip="$trip" -v offer="$offer" -v drv="$drv" \
      -v action="$action" -v t0="$t0" -v delay="$delay" -v hold="$hold" -f - \
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
# trip with D1's offer due (expires_at in the past): ack_trip n scn iter
due_trip() { "${PSQL[@]}" -c "select neg_iso.mk_ack_trip($1, '$2', $3, now() - interval '1 minute')"; }
# trip whose D1 offer expires at <t0> + <ms>: boundary_trip n scn iter t0 ms
boundary_trip() { "${PSQL[@]}" -c "select neg_iso.mk_ack_trip($1, '$2', $3, '$4'::timestamptz + interval '$5 milliseconds')"; }
off() { "${PSQL[@]}" -c "select neg_iso.offer_of('$1'::uuid, $2)"; }
D1="$("${PSQL[@]}" -c "select neg_iso.uid('d', 1)")"

modes() {  # echo "ad ah bd bh": A = the sweep, B = the competing action
  case "$1" in
    free)    echo "0 0 0 0" ;;
    a_holds) echo "0 $HOLD_MS $DELAY_MS 0" ;;
    b_holds) echo "$DELAY_MS 0 0 $HOLD_MS" ;;
  esac
}

# ---------------------------------------------------------------------------
# L. TRIP lock held elsewhere: the sweep must not wait, must not hold the offer (trip ids 600+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN L: sweep while the TRIP lock is held elsewhere — must skip without waiting or holding the offer ==="
for i in 1 2 3; do
  n=$((600 + i)); trip="$(due_trip $n L $i)"; offer="$(off "$trip" 1)"
  t0="$(barrier)"
  spawn SQL_HOLD_TRIP L $i holder "$trip" "" "" hold "$t0" 0 2300
  spawn SQL_ACT       L $i sweep  "$trip" "$offer" "$D1" sweep "$t0" 200 0
  spawn SQL_PROBE     L $i probe  "$trip" "$offer" "" probe "$t0" 800 0
  join_workers
  t0="$(barrier)"
  spawn SQL_ACT L $i sweep2 "$trip" "$offer" "$D1" sweep "$t0" 0 0   # next run, trip lock free again
  join_workers
done
echo "L: 3 sweeps probed"

# ---------------------------------------------------------------------------
# LB. OFFER lock held elsewhere (trip ids 610+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN LB: sweep while the OFFER row is locked elsewhere — must skip without waiting ==="
for i in 1 2 3; do
  n=$((610 + i)); trip="$(due_trip $n LB $i)"; offer="$(off "$trip" 1)"
  t0="$(barrier)"
  spawn SQL_HOLD_OFFER LB $i holder "$trip" "$offer" "" hold "$t0" 0 1500
  spawn SQL_ACT        LB $i sweep  "$trip" "$offer" "$D1" sweep "$t0" 200 0
  join_workers
  t0="$(barrier)"
  spawn SQL_ACT LB $i sweep2 "$trip" "$offer" "$D1" sweep "$t0" 0 0
  join_workers
done
echo "LB: 3 sweeps"

# ---------------------------------------------------------------------------
# A1. ack-timeout vs ACCEPT, offer already due (trip ids 620+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN A1: ack-timeout sweep vs driver accept (due offer) — 9 races ==="
i=0
for mode in free a_holds b_holds; do
  for rep in 1 2 3; do
    i=$((i + 1)); n=$((620 + i)); trip="$(due_trip $n A1 $i)"; offer="$(off "$trip" 1)"
    read -r ad ah bd bh <<<"$(modes $mode)"
    [ "$mode" = free ] && bd=$(( (rep - 1) * 12 ))
    t0="$(barrier)"
    spawn SQL_ACT A1 $i sweep  "$trip" "$offer" "$D1" sweep  "$t0" $ad $ah
    spawn SQL_ACT A1 $i accept "$trip" "$offer" "$D1" accept "$t0" $bd $bh
    join_workers
  done
done
echo "A1: $i races executed"

# ---------------------------------------------------------------------------
# A1b. ack-timeout vs ACCEPT at the expiry boundary (trip ids 640+)
#   offer expires t0+300ms. accept starts at t0 (still valid) and holds its locks until t0+700ms;
#   the sweep starts at t0+450ms (offer now due) and must SKIP, never expire an offer being accepted.
# ---------------------------------------------------------------------------
echo
echo "=== RUN A1b: ack-timeout sweep vs accept at the expiry boundary — 3 races ==="
for i in 1 2 3; do
  n=$((640 + i)); t0="$(barrier)"
  trip="$(boundary_trip $n A1b $i "$t0" 300)"; offer="$(off "$trip" 1)"
  spawn SQL_ACT A1b $i accept "$trip" "$offer" "$D1" accept "$t0" 0 700
  spawn SQL_ACT A1b $i sweep  "$trip" "$offer" "$D1" sweep  "$t0" 450 0
  join_workers
done
echo "A1b: 3 races executed"

# ---------------------------------------------------------------------------
# A2. ack-timeout vs CANCELLATION (trip ids 650+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN A2: ack-timeout sweep vs customer cancellation — 6 races ==="
i=0
for mode in free a_holds b_holds; do
  for rep in 1 2; do
    i=$((i + 1)); n=$((650 + i)); trip="$(due_trip $n A2 $i)"; offer="$(off "$trip" 1)"
    read -r ad ah bd bh <<<"$(modes $mode)"
    [ "$mode" = free ] && bd=$(( (rep - 1) * 15 ))
    t0="$(barrier)"
    spawn SQL_ACT A2 $i sweep  "$trip" "$offer" "$D1" sweep           "$t0" $ad $ah
    spawn SQL_ACT A2 $i cancel "$trip" ""       ""    customer_cancel "$t0" $bd $bh
    join_workers
  done
done
echo "A2: $i races executed"

# ---------------------------------------------------------------------------
# A3. ack-timeout vs NEGOTIATION (trip ids 670+ preset, 690+ decline)
# ---------------------------------------------------------------------------
echo
echo "=== RUN A3: ack-timeout sweep vs negotiation — 6 driver_send_preset_offer + 6 driver decline races ==="
i=0
for action in send_preset decline; do
  for mode in free a_holds b_holds; do
    for rep in 1 2; do
      i=$((i + 1)); n=$((670 + i)); trip="$(due_trip $n A3 $i)"; offer="$(off "$trip" 1)"
      read -r ad ah bd bh <<<"$(modes $mode)"
      [ "$mode" = free ] && bd=$(( (rep - 1) * 15 ))
      t0="$(barrier)"
      spawn SQL_ACT A3 $i sweep "$trip" "$offer" "$D1" sweep   "$t0" $ad $ah
      spawn SQL_ACT A3 $i neg   "$trip" "$offer" "$D1" "$action" "$t0" $bd $bh
      join_workers
    done
  done
done
echo "A3: $i races executed"

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
