#!/usr/bin/env bash
# #110 — Isolated trips UPDATE trigger cost profile (LOCAL ONLY).
# Never points at production. Never disables production triggers.
#
# Usage:
#   PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres PGPASSWORD=postgres \
#     bash supabase/tests/trips_update_trigger_cost_110_isolated.sh
set -euo pipefail

HOST="${PGHOST:-127.0.0.1}"
case "$HOST" in
  127.0.0.1|localhost) ;;
  *)
    echo "REFUSED: host=$HOST is not local"
    exit 2
    ;;
esac

PORT="${PGPORT:-54329}"
USER="${PGUSER:-postgres}"
DB="${PGDATABASE:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
unset PGOPTIONS || true

PSQL=(psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 -At)

echo "=== #110 trips UPDATE trigger inventory ==="
"${PSQL[@]}" <<'SQL'
WITH trig AS (
  SELECT t.tgname,
         CASE WHEN pg_get_triggerdef(t.oid) ~* 'BEFORE' THEN 'BEFORE' ELSE 'AFTER' END AS timing,
         CASE WHEN pg_get_triggerdef(t.oid) ~* 'WHEN \(' THEN 'conditional' ELSE 'unconditional' END AS when_class,
         p.proname,
         pg_get_functiondef(p.oid) AS body
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.trips'::regclass
    AND NOT t.tgisinternal
    AND pg_get_triggerdef(t.oid) ILIKE '%UPDATE%'
)
SELECT 'count_total=' || count(*)
  || ' unconditional=' || count(*) FILTER (WHERE when_class='unconditional')
  || ' conditional=' || count(*) FILTER (WHERE when_class='conditional')
  || ' before_uncond=' || count(*) FILTER (WHERE timing='BEFORE' AND when_class='unconditional')
  || ' after_uncond=' || count(*) FILTER (WHERE timing='AFTER' AND when_class='unconditional')
  || ' early_return_guard=' || count(*) FILTER (
       WHERE body ~* 'IF\s+TG_OP|IF\s+NEW\.|RETURN\s+NEW|RETURN\s+NULL'
     )
  || ' http=' || count(*) FILTER (
       WHERE body ~* 'net\.http|http_post|pg_net|supabase_functions\.http'
     )
FROM trig;
SQL

echo "=== early-return / status-gated classification (sample) ==="
"${PSQL[@]}" <<'SQL'
WITH trig AS (
  SELECT t.tgname,
         CASE WHEN pg_get_triggerdef(t.oid) ~* 'WHEN \(' THEN 'WHEN' ELSE 'NO_WHEN' END AS when_class,
         pg_get_functiondef(p.oid) AS body
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.trips'::regclass
    AND NOT t.tgisinternal
    AND pg_get_triggerdef(t.oid) ILIKE '%UPDATE%'
)
SELECT tgname
  || '|when=' || when_class
  || '|status_gate=' || CASE WHEN body ~* 'NEW\.status|OLD\.status' THEN 'yes' ELSE 'no' END
  || '|writes=' || CASE WHEN body ~* 'INSERT INTO|UPDATE public\.|UPDATE\s+[a-z_]+\s+SET' THEN 'yes' ELSE 'no' END
  || '|http=' || CASE WHEN body ~* 'net\.http|http_post|pg_net' THEN 'yes' ELSE 'no' END
FROM trig
ORDER BY tgname;
SQL

echo "=== wall-time UPDATE status=completed on seeded fixture (10 iters) ==="
"${PSQL[@]}" <<'SQL'
DO $$
DECLARE
  i int;
  t0 timestamptz;
  t1 timestamptz;
  ms numeric;
  total numeric := 0;
  mx numeric := 0;
  trip uuid;
  n int := 0;
BEGIN
  -- Prefer an existing completed PLATFORM trip; else skip timing.
  SELECT id INTO trip
  FROM public.trips
  WHERE financial_model = 'PLATFORM_COLLECTED'
  ORDER BY created_at DESC
  LIMIT 1;
  IF trip IS NULL THEN
    RAISE NOTICE 'SKIP_TIMING: no fixture trip';
    RETURN;
  END IF;

  FOR i IN 1..10 LOOP
    t0 := clock_timestamp();
    -- Harmless column touch that still fires UPDATE triggers (updated_at).
    UPDATE public.trips
    SET updated_at = clock_timestamp()
    WHERE id = trip;
    t1 := clock_timestamp();
    ms := EXTRACT(EPOCH FROM (t1 - t0)) * 1000;
    total := total + ms;
    IF ms > mx THEN mx := ms; END IF;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'updated_at_touch_iters=% mean_ms=% max_ms=%',
    n, round(total / n, 1), round(mx, 1);
END $$;
SQL

echo "ALL trips_update_trigger_cost_110_isolated CHECKS COMPLETED"
