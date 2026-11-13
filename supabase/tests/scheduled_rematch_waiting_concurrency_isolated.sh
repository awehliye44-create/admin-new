#!/usr/bin/env bash
# =============================================================================
# Scheduled rematch / waiting-segment CONCURRENCY harness (LOCAL Supabase DB only).
#
#   bash supabase/tests/scheduled_rematch_waiting_concurrency_isolated.sh
#   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres  (default)
#
# - Refuses any non-local DB_URL.            - No Edge / Revolut / push calls (pure SQL).
# - Two (or more) REAL parallel psql sessions per race, released by a shared clock barrier;
#   "hold" modes keep the winner's row lock open so the loser genuinely blocks on the row lock
#   and re-evaluates its predicate under READ COMMITTED (the path production CAS depends on).
# - Reads the production CAS predicates from the TS source and fails on drift:
#     DRIVER_CANCEL_REMATCH_CAS_STATUSES      (_shared/scheduledDriverCancelRematchSSOT.ts)
#     TRIP_ASSIGNED_DRIVER_COLUMN             (_shared/driverCancelRematch.ts)
#     .eq(TRIP_ASSIGNED_DRIVER_COLUMN, ...) / .in("status", [...CAS]) / .is("started_at", null)
#                                             (driver-cancel-before-pickup/index.ts)
# - Synthetic rows only (ids 00000000-0000-4000-{8000,9000,a000,b000}-*, client_action_id
#   TEST-REMATCH-*). Removed in the EXIT trap ("finally"); row counts are diffed before/after.
# =============================================================================
set -uo pipefail
export PATH=/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
FIND_MINUTES="${RMCH_FIND_MINUTES:-6}"
HOLD_MS="${RMCH_HOLD_MS:-400}"
DELAY_MS="${RMCH_DELAY_MS:-100}"
SETUP_SQL="$HERE/scheduled_rematch_waiting_concurrency_isolated.setup.sql"
VERIFY_SQL="$HERE/scheduled_rematch_waiting_concurrency_isolated.sql"
WORK="$(mktemp -d)"
EDGE="$REPO/supabase/functions/driver-cancel-before-pickup/index.ts"
SSOT="$REPO/supabase/functions/_shared/scheduledDriverCancelRematchSSOT.ts"
CANCEL_SSOT="$REPO/supabase/functions/_shared/driverCancelRematch.ts"

case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*|*@127.0.0.1/*|*@localhost/*) ;;
  *) echo "REFUSING: DB_URL must be a LOCAL database (127.0.0.1/localhost). Got: $DB_URL" >&2; exit 2 ;;
esac

PSQL=(psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=1)
count_snapshot() {
  "${PSQL[@]}" -c "select table_name||'='||(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text
                   from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"
}

CLEANED=0
finally_cleanup() {
  local rc=$?
  if [ "$CLEANED" = "0" ]; then
    CLEANED=1
    echo
    echo "=== FINALLY: cleanup synthetic rows (TEST-REMATCH-*) ==="
    psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -v cleanup_only=1 -f "$SETUP_SQL" 2>&1 | grep -v '^$' || true
    count_snapshot > "$WORK/counts.after" 2>/dev/null || true
    if [ -s "$WORK/counts.before" ] && [ -s "$WORK/counts.after" ]; then
      if diff -u "$WORK/counts.before" "$WORK/counts.after" > "$WORK/counts.diff"; then
        echo "RESIDUE_CHECK: PASS — every public table has the same row count as before the run"
      else
        echo "RESIDUE_CHECK: DIFF (before -> after row counts):"; grep -E '^[+-][a-z_0-9]+=' "$WORK/counts.diff" || true
      fi
    fi
    local left
    left=$("${PSQL[@]}" -c "select (select count(*) from trips where id::text like '00000000-0000-4000-8000-%')
                                 +(select count(*) from drivers where id::text like '00000000-0000-4000-b000-%')
                                 +(select count(*) from payment_sessions where id::text like '00000000-0000-4000-a000-%')
                                 +(select count(*) from ride_offers where trip_id::text like '00000000-0000-4000-8000-%')
                                 +(select count(*) from trip_waiting_segments where trip_id::text like '00000000-0000-4000-8000-%')" 2>/dev/null || echo "?")
    echo "SYNTHETIC_ROWS_REMAINING=$left"
  fi
  rm -rf "$WORK"
  exit $rc
}
trap finally_cleanup EXIT

echo "=== scheduled rematch / waiting concurrency harness ==="
echo "db      : ${DB_URL%%:*}://…@$(echo "$DB_URL" | sed -E 's#.*@##')"
echo "psql    : $(psql --version)"
echo "server  : $("${PSQL[@]}" -c 'select version()' | cut -c1-60)"
echo "started : $(date -u +%FT%TZ)"

# ---------------------------------------------------------------------------
# 0. Predicate parity: parse the TS SSOT, abort on drift
# ---------------------------------------------------------------------------
CAS_STATUSES="$(python3 - "$SSOT" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'DRIVER_CANCEL_REMATCH_CAS_STATUSES\s*=\s*\[(.*?)\]\s*as const', src, re.S)
if not m: sys.exit(3)
print('{' + ','.join(re.findall(r'"([^"]+)"', m.group(1))) + '}')
PY
)" || { echo "BLOCKER: cannot parse DRIVER_CANCEL_REMATCH_CAS_STATUSES from $SSOT"; exit 3; }
grep -q 'TRIP_ASSIGNED_DRIVER_COLUMN = "confirmed_driver_id"' "$CANCEL_SSOT" \
  || { echo "PREDICATE_DRIFT: TRIP_ASSIGNED_DRIVER_COLUMN is no longer confirmed_driver_id"; exit 3; }
grep -q '\.eq(TRIP_ASSIGNED_DRIVER_COLUMN, driver\.id)' "$EDGE" \
  || { echo "PREDICATE_DRIFT: CAS .eq(TRIP_ASSIGNED_DRIVER_COLUMN, driver.id) missing in Edge"; exit 3; }
grep -q '\.in("status", \[\.\.\.DRIVER_CANCEL_REMATCH_CAS_STATUSES\])' "$EDGE" \
  || { echo "PREDICATE_DRIFT: CAS .in(\"status\", [...DRIVER_CANCEL_REMATCH_CAS_STATUSES]) missing in Edge"; exit 3; }
grep -q '\.is("started_at", null)' "$EDGE" \
  || { echo "PREDICATE_DRIFT: CAS .is(\"started_at\", null) missing in Edge"; exit 3; }
echo "PREDICATES (parsed from TS source, mirrored by rmch_iso.dc_cas):"
echo "  CAS: confirmed_driver_id = driver AND status IN $CAS_STATUSES AND started_at IS NULL"

# Start from a clean slate (removes leftovers of an aborted earlier run), THEN snapshot row counts.
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -v cleanup_only=1 -f "$SETUP_SQL" >/dev/null 2>&1 || true
count_snapshot > "$WORK/counts.before"

# ---------------------------------------------------------------------------
# 1. Setup
# ---------------------------------------------------------------------------
echo
echo "=== SETUP ==="
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -v cas_statuses="$CAS_STATUSES" -v find_minutes="$FIND_MINUTES" \
  -f "$SETUP_SQL" 2>&1 | grep -v -E '^\s*$|^-+$|^\s+1$|^\(1 row\)|drivers_created' || { echo "SETUP FAILED"; exit 4; }

# ---------------------------------------------------------------------------
# Worker SQL (each statement autocommits, exactly like separate PostgREST calls)
# ---------------------------------------------------------------------------
read -r -d '' SQL_CANCEL <<'SQL'
select pg_sleep(greatest(0, extract(epoch from (:'t0'::timestamptz - clock_timestamp())) + :delay/1000.0)) \gset
select clock_timestamp()::text as ts \gset
select rmch_iso.dc_precheck(:'trip'::uuid, :'drv'::uuid) as pre \gset
select (:'pre' = 'proceed') as go \gset
\if :go
  select rmch_iso.dc_revoke(:'trip'::uuid) as revoked \gset
  select rmch_iso.dc_cas(:'trip'::uuid, :'drv'::uuid, :hold)::text as cas \gset
  select coalesce((:'cas'::jsonb->>'rows')::int, -9) as rows \gset
  select (:rows = 1) as won \gset
  \if :won
    select rmch_iso.dc_post_cas(:'trip'::uuid) as post \gset
  \else
    \set post -1
  \endif
  select rmch_iso.rec(:'scn', :iter, :'w', case when :'won'::boolean then 'cas_won' else 'cas_miss' end, :rows,
         :'cas'::jsonb || jsonb_build_object('pre', :'pre', 'revoked', :revoked, 'post', :post, 'mode', :'mode'),
         :'ts'::timestamptz) \gset
\else
  select rmch_iso.rec(:'scn', :iter, :'w', 'pre_' || :'pre', 0,
         jsonb_build_object('pre', :'pre', 'mode', :'mode'), :'ts'::timestamptz) \gset
\endif
SQL

read -r -d '' SQL_START <<'SQL'
select pg_sleep(greatest(0, extract(epoch from (:'t0'::timestamptz - clock_timestamp())) + :delay/1000.0)) \gset
select clock_timestamp()::text as ts \gset
select rmch_iso.start_real(:'trip'::uuid, :'drv'::uuid, :hold)::text as r \gset
select rmch_iso.rec(:'scn', :iter, :'w',
  case when (:'r'::jsonb->>'ok')::boolean and not coalesce((:'r'::jsonb->>'idempotent')::boolean, false) then 'start_won'
       when (:'r'::jsonb->>'ok')::boolean then 'start_idempotent' else 'start_rejected' end,
  0, :'r'::jsonb || jsonb_build_object('mode', :'mode'), :'ts'::timestamptz) \gset
SQL

read -r -d '' SQL_ACCEPT <<'SQL'
select pg_sleep(greatest(0, extract(epoch from (:'t0'::timestamptz - clock_timestamp())) + :delay/1000.0)) \gset
select clock_timestamp()::text as ts \gset
select rmch_iso.accept_safe(:'trip'::uuid, :'drv'::uuid, :hold)::text as r \gset
select rmch_iso.rec(:'scn', :iter, :'w',
  case when (:'r'::jsonb->>'success')::boolean then 'accepted' else coalesce(:'r'::jsonb->>'error', 'unknown') end,
  0, :'r'::jsonb || jsonb_build_object('mode', :'mode'), :'ts'::timestamptz) \gset
SQL

read -r -d '' SQL_WSEG_OPEN <<'SQL'
select pg_sleep(greatest(0, extract(epoch from (:'t0'::timestamptz - clock_timestamp())) + :delay/1000.0)) \gset
select clock_timestamp()::text as ts \gset
select rmch_iso.wseg_open_prod(:'trip'::uuid, :hold) as r \gset
select rmch_iso.rec(:'scn', :iter, :'w', :'r', 0, jsonb_build_object('mode', :'mode'), :'ts'::timestamptz) \gset
SQL

read -r -d '' SQL_WSEG_HEAL <<'SQL'
select pg_sleep(greatest(0, extract(epoch from (:'t0'::timestamptz - clock_timestamp())) + :delay/1000.0)) \gset
select clock_timestamp()::text as ts \gset
select rmch_iso.wseg_heal(:'trip'::uuid) as r \gset
select rmch_iso.rec(:'scn', :iter, :'w', 'healed', :r, jsonb_build_object('mode', :'mode'), :'ts'::timestamptz) \gset
SQL

read -r -d '' SQL_OFFER <<'SQL'
select pg_sleep(greatest(0, extract(epoch from (:'t0'::timestamptz - clock_timestamp())) + :delay/1000.0)) \gset
select clock_timestamp()::text as ts \gset
select coalesce(rmch_iso.ins_offer(:'trip'::uuid, :'drv'::uuid, :round, 'pending', :'exp'::timestamptz, true)::text, '') as r \gset
select rmch_iso.rec(:'scn', :iter, :'w', case when :'r' = '' then 'conflict_ignored' else 'inserted' end, 0,
  jsonb_build_object('mode', :'mode'), :'ts'::timestamptz) \gset
SQL

# ---------------------------------------------------------------------------
# Runner helpers
# ---------------------------------------------------------------------------
PIDS=()
BAD_WORKERS=0
# spawn <SQLVAR> scn iter worker trip drv t0 delay hold mode [extra -v ...]
spawn() {
  local sqlvar="$1" scn="$2" iter="$3" w="$4" trip="$5" drv="$6" t0="$7" delay="$8" hold="$9" mode="${10}"
  shift 10
  (
    printf '%s\n' "${!sqlvar}" | psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=0 \
      -v scn="$scn" -v iter="$iter" -v w="$w" -v trip="$trip" -v drv="$drv" -v t0="$t0" \
      -v delay="$delay" -v hold="$hold" -v mode="$mode" "$@" -f - \
      >"$WORK/w.$scn.$iter.$w.out" 2>"$WORK/w.$scn.$iter.$w.err"
  ) &
  PIDS+=($!)
}
join_workers() {
  local p
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && wait "$p" || BAD_WORKERS=$((BAD_WORKERS + 1)); done
  PIDS=()
}
barrier() { "${PSQL[@]}" -c "select (clock_timestamp() + interval '700 ms')::text"; }
tid() { "${PSQL[@]}" -c "select rmch_iso.uid('t', $1)"; }
did() { "${PSQL[@]}" -c "select rmch_iso.uid('d', $1)"; }
sql()  { "${PSQL[@]}" -c "$1" >/dev/null; }
D1="$(did 1)"; D2="$(did 2)"; D3="$(did 3)"; D4="$(did 4)"

# ---------------------------------------------------------------------------
# A. Cancel vs Start Trip   (trip ids 100+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN A: driver cancel (CAS) vs REAL finalize_pickup_waiting_and_start_trip RPC — 24 races (free / start-holds-lock / cancel-holds-lock) ==="
i=0
for mode in free start_holds cancel_holds; do
  for rep in 1 2 3 4 5 6 7 8; do
    i=$((i + 1)); n=$((100 + i)); trip="$(tid $n)"
    sql "select rmch_iso.mk_trip($n, 'scheduled_arrived')"
    sql "select rmch_iso.mk_stops('$trip')"   # pickup(arrived)+dropoff stops the REAL Start RPC requires
    t0="$(barrier)"
    case "$mode" in
      # free: no lock held; Start is released 0..56ms after Cancel's precheck/revoke/CAS (sweeps the window)
      free)         ch=0;        sh=0;        cd=0;          sd=$(( (rep - 1) * 8 )) ;;
      start_holds)  ch=0;        sh=$HOLD_MS; cd=$DELAY_MS;  sd=0 ;;
      cancel_holds) ch=$HOLD_MS; sh=0;        cd=0;          sd=$DELAY_MS ;;
    esac
    spawn SQL_CANCEL A $i cancel "$trip" "$D1" "$t0" $cd $ch $mode
    spawn SQL_START  A $i start  "$trip" "$D1" "$t0" $sd $sh $mode
    join_workers
  done
done
echo "A: $i races executed"

# ---------------------------------------------------------------------------
# B. Duplicate cancellation  (trip ids 200+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN B: duplicate driver cancellation — 11 races (scheduled+instant origin, free / hold) ==="
i=0
for spec in free:scheduled_assigned:4 hold:scheduled_assigned:3 free:instant_assigned:2 hold:instant_assigned:2; do
  mode="${spec%%:*}"; rest="${spec#*:}"; variant="${rest%%:*}"; reps="${rest##*:}"
  for rep in $(seq 1 "$reps"); do
    i=$((i + 1)); n=$((200 + i)); trip="$(tid $n)"
    sql "select rmch_iso.mk_trip($n, '$variant')"
    t0="$(barrier)"
    if [ "$mode" = hold ]; then h1=$HOLD_MS; d2=$DELAY_MS; else h1=0; d2=0; fi
    spawn SQL_CANCEL B $i c1 "$trip" "$D1" "$t0" 0   $h1 "${mode}_${variant}"
    spawn SQL_CANCEL B $i c2 "$trip" "$D1" "$t0" $d2 0   "${mode}_${variant}"
    join_workers
  done
done
echo "B: $i races executed"

# ---------------------------------------------------------------------------
# C. Stale offer claim vs replacement assignment  (trip ids 300+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN C: stale offer claim vs replacement assignment — 9 races ==="
i=0
for mode in free d3_holds d2_holds; do
  for rep in 1 2 3; do
    i=$((i + 1)); n=$((300 + i)); trip="$(tid $n)"
    sql "select rmch_iso.mk_rematched($n)"
    # D3: pending offer from a PRIOR cycle (round 2 < current_broadcast_round 3) that a late
    # dispatcher wave inserted after the cancel's revoke step (still unexpired = worst case).
    # D2: the fresh replacement offer for the new cycle (round 4).
    sql "select rmch_iso.ins_offer('$trip', '$D3', 2, 'pending', now() + interval '10 minutes')"
    sql "select rmch_iso.ins_offer('$trip', '$D2', 4, 'pending', now() + interval '5 minutes')"
    t0="$(barrier)"
    case "$mode" in
      free)     h2=0;        h3=0;        d2=0;         d3=0;         d1=0 ;;
      d3_holds) h2=0;        h3=$HOLD_MS; d2=$DELAY_MS; d3=0;         d1=$DELAY_MS ;;
      d2_holds) h2=$HOLD_MS; h3=0;        d2=0;         d3=$DELAY_MS; d1=$DELAY_MS ;;
    esac
    spawn SQL_ACCEPT C $i d2 "$trip" "$D2" "$t0" $d2 $h2 $mode
    spawn SQL_ACCEPT C $i d3 "$trip" "$D3" "$t0" $d3 $h3 $mode
    spawn SQL_ACCEPT C $i d1 "$trip" "$D1" "$t0" $d1 0   $mode
    join_workers
  done
done
echo "C: $i races executed"

# ---------------------------------------------------------------------------
# D. Concurrent waiting-segment open  (trip ids 400+)
# ---------------------------------------------------------------------------
echo
echo "=== RUN D: concurrent pickup waiting-segment open — 6 trips x 4 parallel openers, then 2 healers, then 4 re-openers ==="
for i in 1 2 3 4 5 6; do
  n=$((400 + i)); trip="$(tid $n)"
  sql "select rmch_iso.mk_trip($n, 'scheduled_assigned')"
  t0="$(barrier)"
  for k in 1 2 3 4; do spawn SQL_WSEG_OPEN D $i "open$k" "$trip" "$D1" "$t0" 0 150 raw; done
  join_workers
  sql "select rmch_iso.rec('D', $i, 'probe_raw', 'open_rows', (select count(*)::int from trip_waiting_segments where trip_id='$trip' and location_type='pickup' and ended_at is null), jsonb_build_object('total_rows', (select count(*) from trip_waiting_segments where trip_id='$trip')), clock_timestamp())"
  t0="$(barrier)"
  for k in 1 2; do spawn SQL_WSEG_HEAL D $i "heal$k" "$trip" "$D1" "$t0" 0 0 heal; done
  join_workers
  sql "select rmch_iso.rec('D', $i, 'probe_healed', 'open_rows', (select count(*)::int from trip_waiting_segments where trip_id='$trip' and location_type='pickup' and ended_at is null), '{}', clock_timestamp())"
  t0="$(barrier)"
  for k in 1 2 3 4; do spawn SQL_WSEG_OPEN D $i "reopen$k" "$trip" "$D1" "$t0" 0 150 reopen; done
  join_workers
  sql "select rmch_iso.rec('D', $i, 'probe_reopen', 'open_rows', (select count(*)::int from trip_waiting_segments where trip_id='$trip' and location_type='pickup' and ended_at is null), '{}', clock_timestamp())"
done
echo "D: 6 trips executed"

# D2. Concurrent waiting-segment FINALISATION (trip ids 410+): three parallel REAL Start-Trip
#     finalisers (same driver; one holds the trip lock) + two parallel segment openers racing them.
echo "=== RUN D2: concurrent waiting-segment finalisation — 4 trips x (3 parallel real Start RPCs + 2 racing openers) ==="
for i in 1 2 3 4; do
  n=$((410 + i)); trip="$(tid $n)"
  sql "select rmch_iso.mk_trip($n, 'scheduled_arrived')"
  sql "select rmch_iso.mk_stops('$trip')"
  t0="$(barrier)"
  spawn SQL_START      D $((10 + i)) fin1  "$trip" "$D1" "$t0" 0   $HOLD_MS fin
  spawn SQL_START      D $((10 + i)) fin2  "$trip" "$D1" "$t0" 50  0        fin
  spawn SQL_START      D $((10 + i)) fin3  "$trip" "$D1" "$t0" 100 0        fin
  spawn SQL_WSEG_OPEN  D $((10 + i)) open1 "$trip" "$D1" "$t0" 0   0        raceopen
  spawn SQL_WSEG_OPEN  D $((10 + i)) open2 "$trip" "$D1" "$t0" 120 0        raceopen
  join_workers
done
echo "D2: 4 trips executed"

# ---------------------------------------------------------------------------
# E. scheduled cancel -> converted rematch + fresh find window + replacement offers  (ids 500+)
# F. replacement acceptance claim (same trips)
# ---------------------------------------------------------------------------
echo
echo "=== RUN E/F: scheduled cancel -> instant rematch -> replacement offers -> acceptance — 6 trips ==="
for i in 1 2 3 4 5 6; do
  n=$((500 + i)); trip="$(tid $n)"
  sql "select rmch_iso.mk_trip($n, 'scheduled_arrived')"
  t0="$(barrier)"
  spawn SQL_CANCEL E $i cancel "$trip" "$D1" "$t0" 0 0 single
  join_workers
  sql "select rmch_iso.cap('E', $i, 'after_rematch', '$trip')"
  exp="$("${PSQL[@]}" -c "select searching_expires_at::text from trips where id='$trip'")"
  rnd="$("${PSQL[@]}" -c "select current_broadcast_round + 1 from trips where id='$trip'")"
  # two dispatcher workers race to insert the SAME replacement offer (trip, D2, round) ...
  t0="$(barrier)"
  spawn SQL_OFFER E $i ins_d2_a "$trip" "$D2" "$t0" 0 0 dup -v round="$rnd" -v exp="$exp"
  spawn SQL_OFFER E $i ins_d2_b "$trip" "$D2" "$t0" 0 0 dup -v round="$rnd" -v exp="$exp"
  join_workers
  # ... and a second candidate driver D4 gets one replacement offer.
  t0="$(barrier)"
  spawn SQL_OFFER E $i ins_d4 "$trip" "$D4" "$t0" 0 0 single -v round="$rnd" -v exp="$exp"
  join_workers
  sql "select rmch_iso.cap('E', $i, 'after_offers', '$trip')"
  # F: replacement acceptance claim — D2, D4 and excluded D1 all try at once.
  t0="$(barrier)"
  if [ $((i % 2)) -eq 0 ]; then mode=d2_holds; h2=$HOLD_MS; dd=$DELAY_MS; else mode=free; h2=0; dd=0; fi
  spawn SQL_ACCEPT F $i d2 "$trip" "$D2" "$t0" 0   $h2 $mode
  spawn SQL_ACCEPT F $i d4 "$trip" "$D4" "$t0" $dd 0   $mode
  spawn SQL_ACCEPT F $i d1 "$trip" "$D1" "$t0" $dd 0   $mode
  join_workers
done
echo "E/F: 6 trips executed"

echo
echo "=== WORKER HEALTH ==="
echo "psql worker non-zero exits: $BAD_WORKERS"
cat "$WORK"/w.*.err 2>/dev/null | grep -v '^$' | sort | uniq -c | sort -rn | head -10 || true

# ---------------------------------------------------------------------------
# Verify (assertions live in the .sql file)
# ---------------------------------------------------------------------------
echo
echo "=== VERIFY ==="
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -v bad_workers="$BAD_WORKERS" -f "$VERIFY_SQL"
VRC=$?
echo
echo "VERIFY_EXIT=$VRC"
exit $VRC
