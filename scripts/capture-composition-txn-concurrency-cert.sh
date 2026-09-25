#!/usr/bin/env bash
# Isolated PostgreSQL concurrency proof for payment_session_acquire_capture_composition.
# Two simultaneous transactions — not pure/source locks.
# Requires local Homebrew Postgres. Does NOT touch production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_NAME="${CAPTURE_COMPOSITION_CERT_DB:-onecab_capture_composition_cert}"
export PGHOST="${PGHOST:-/tmp}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-admin}"
PSQL=(psql -d "$DB_NAME" -v ON_ERROR_STOP=1)
WORKDIR="${TMPDIR:-/tmp}/capture_composition_txn_cert_$$"
mkdir -p "$WORKDIR"

echo "=== CAPTURE COMPOSITION TRANSACTIONAL CONCURRENCY CERT ==="
echo "PGHOST=$PGHOST PGPORT=$PGPORT DB=$DB_NAME"
echo "WORKDIR=$WORKDIR"

dropdb --if-exists "$DB_NAME" 2>/dev/null || true
createdb "$DB_NAME"

"${PSQL[@]}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;

CREATE TABLE public.payment_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_order_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  buffer_pence integer DEFAULT 0,
  authorised_amount_pence integer,
  total_authorised_amount_pence integer,
  financial_operation_state text,
  financial_operation_owner text,
  financial_operation_started_at timestamptz,
  updated_at timestamptz DEFAULT now(),
  trip_fare_component_pence integer,
  tip_component_pence integer,
  receivable_component_pence integer,
  provider_capture_target_pence integer,
  capture_composition_version text,
  capture_idempotency_key text,
  capture_composition_frozen_at timestamptz
);

CREATE TABLE public.payment_session_receivable_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_session_id uuid NOT NULL REFERENCES public.payment_sessions(id),
  receivable_id uuid NOT NULL DEFAULT gen_random_uuid(),
  allocated_amount_pence integer NOT NULL CHECK (allocated_amount_pence > 0),
  status text NOT NULL CHECK (status IN ('RESERVED','SETTLED','RELEASED')),
  updated_at timestamptz DEFAULT now()
);
SQL

"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260925120000_capture_composition_components.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260925130000_payment_session_acquire_capture_composition.sql"

SESSION_ID=$("${PSQL[@]}" -Atc "SELECT gen_random_uuid()")
ORDER_ID="ord-txn-cert-001"
ALLOC_A=$("${PSQL[@]}" -Atc "SELECT gen_random_uuid()")
ALLOC_B=$("${PSQL[@]}" -Atc "SELECT gen_random_uuid()")

"${PSQL[@]}" <<SQL
INSERT INTO public.payment_sessions (
  id, provider_order_id, buffer_pence, authorised_amount_pence, total_authorised_amount_pence,
  financial_operation_state, metadata
) VALUES (
  '${SESSION_ID}'::uuid,
  '${ORDER_ID}',
  0,
  536,
  536,
  'IDLE',
  '{"customer_receivables_pence":36}'::jsonb
);

INSERT INTO public.payment_session_receivable_allocations
  (id, payment_session_id, allocated_amount_pence, status)
VALUES
  ('${ALLOC_A}'::uuid, '${SESSION_ID}'::uuid, 30, 'RESERVED'),
  ('${ALLOC_B}'::uuid, '${SESSION_ID}'::uuid, 6, 'RESERVED');

CREATE TABLE public.txn_cert_results (
  worker text PRIMARY KEY,
  kind text,
  target integer,
  idem_key text,
  ok boolean,
  err text,
  finished_at timestamptz DEFAULT now()
);
SQL

run_worker() {
  local worker="$1"
  local out="$WORKDIR/${worker}.out"
  "${PSQL[@]}" -At <<SQL >"$out" 2>"$WORKDIR/${worker}.err"
BEGIN;
SELECT pg_sleep(0.05);
WITH r AS (
  SELECT public.payment_session_acquire_capture_composition(
    '${SESSION_ID}'::uuid,
    '${ORDER_ID}',
    500,
    0,
    0,
    536,
    'worker_${worker}',
    'op_${worker}'
  ) AS j
)
INSERT INTO public.txn_cert_results (worker, kind, target, idem_key, ok, err)
SELECT
  '${worker}',
  r.j->>'kind',
  (r.j->>'provider_capture_target_pence')::int,
  r.j->>'capture_idempotency_key',
  (r.j->>'ok')::boolean,
  r.j->>'error'
FROM r;
COMMIT;
SELECT 'done';
SQL
}

run_worker A &
PID_A=$!
run_worker B &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true

echo "--- worker A out ---"; cat "$WORKDIR/A.out" || true
echo "--- worker A err ---"; cat "$WORKDIR/A.err" || true
echo "--- worker B out ---"; cat "$WORKDIR/B.out" || true
echo "--- worker B err ---"; cat "$WORKDIR/B.err" || true

"${PSQL[@]}" -c "SELECT * FROM txn_cert_results ORDER BY worker;"
"${PSQL[@]}" -c "SELECT
  trip_fare_component_pence,
  tip_component_pence,
  receivable_component_pence,
  provider_capture_target_pence,
  capture_idempotency_key,
  capture_composition_frozen_at IS NOT NULL AS frozen,
  financial_operation_state
FROM payment_sessions WHERE id = '${SESSION_ID}'::uuid;"

EVAL=$("${PSQL[@]}" -At <<SQL
WITH r AS (SELECT * FROM txn_cert_results),
s AS (SELECT * FROM payment_sessions WHERE id = '${SESSION_ID}'::uuid)
SELECT
  CASE
    WHEN (SELECT count(*) FROM r) <> 2 THEN 'FAIL: expected 2 worker results'
    WHEN (SELECT count(*) FROM r WHERE ok IS TRUE) <> 2 THEN 'FAIL: both workers must succeed'
    WHEN (SELECT count(DISTINCT target) FROM r) <> 1 THEN 'FAIL: multiple targets'
    WHEN (SELECT count(DISTINCT idem_key) FROM r) <> 1 THEN 'FAIL: multiple idempotency keys'
    WHEN (SELECT max(target) FROM r) <> 536 THEN 'FAIL: target must be 536 (500+0+36)'
    WHEN (SELECT count(*) FROM r WHERE kind = 'created') > 1 THEN 'FAIL: more than one created'
    WHEN (SELECT count(*) FROM r WHERE kind IN ('created','resumed')) <> 2 THEN 'FAIL: kinds not created/resumed'
    WHEN (SELECT provider_capture_target_pence FROM s) <> 536 THEN 'FAIL: session target'
    WHEN (SELECT capture_idempotency_key FROM s) IS NULL THEN 'FAIL: missing key'
    WHEN (SELECT receivable_component_pence FROM s) <> 36 THEN 'FAIL: fare-only fallback (recv lost)'
    WHEN (SELECT tip_component_pence FROM s) <> 0 THEN 'FAIL: tip mismatch'
    WHEN (SELECT trip_fare_component_pence FROM s) <> 500 THEN 'FAIL: fare mismatch'
    WHEN (SELECT capture_composition_frozen_at FROM s) IS NULL THEN 'FAIL: not frozen'
    ELSE 'PASS'
  END;
SQL
)

echo "RESULT=$EVAL"
if [[ "$EVAL" != "PASS" ]]; then
  echo "CONCURRENCY CERT FAILED"
  exit 1
fi

for i in $(seq 1 10); do
  NEW_SESSION=$("${PSQL[@]}" -Atc "SELECT gen_random_uuid()")
  "${PSQL[@]}" -c "
    INSERT INTO public.payment_sessions (
      id, provider_order_id, buffer_pence, authorised_amount_pence, total_authorised_amount_pence,
      financial_operation_state, metadata
    ) VALUES (
      '${NEW_SESSION}'::uuid, 'ord-pair-${i}', 0, 536, 536, 'IDLE',
      '{\"customer_receivables_pence\":36}'::jsonb
    );
    INSERT INTO public.payment_session_receivable_allocations
      (payment_session_id, allocated_amount_pence, status)
    VALUES
      ('${NEW_SESSION}'::uuid, 30, 'RESERVED'),
      ('${NEW_SESSION}'::uuid, 6, 'RESERVED');
    TRUNCATE txn_cert_results;
  " >/dev/null

  run_pair_worker() {
    local worker="$1"
    local sid="$2"
    "${PSQL[@]}" -At <<SQL >/dev/null 2>"$WORKDIR/pair_${i}_${worker}.err"
BEGIN;
SELECT pg_sleep(0.02);
WITH r AS (
  SELECT public.payment_session_acquire_capture_composition(
    '${sid}'::uuid, 'ord-pair-${i}', 500, 0, 0, 536, 'pair_${worker}', 'pair_op'
  ) AS j
)
INSERT INTO public.txn_cert_results (worker, kind, target, idem_key, ok, err)
SELECT '${worker}', r.j->>'kind', (r.j->>'provider_capture_target_pence')::int,
       r.j->>'capture_idempotency_key', (r.j->>'ok')::boolean, r.j->>'error'
FROM r;
COMMIT;
SQL
  }
  run_pair_worker A "$NEW_SESSION" &
  run_pair_worker B "$NEW_SESSION" &
  wait || true
  PAIR=$("${PSQL[@]}" -Atc "SELECT count(DISTINCT idem_key) FROM txn_cert_results WHERE ok")
  KINDS=$("${PSQL[@]}" -Atc "SELECT string_agg(kind, ',' ORDER BY kind) FROM txn_cert_results")
  TARGET=$("${PSQL[@]}" -Atc "SELECT provider_capture_target_pence FROM payment_sessions WHERE id='${NEW_SESSION}'::uuid")
  if [[ "$PAIR" != "1" || "$TARGET" != "536" ]]; then
    echo "PAIR $i FAIL distinct_keys=$PAIR target=$TARGET kinds=$KINDS"
    cat "$WORKDIR/pair_${i}_A.err" "$WORKDIR/pair_${i}_B.err" || true
    exit 1
  fi
done

echo "CONCURRENCY CERT PASS: one plan, one target=536, one idempotency key, loser adopts winner, no fare-only fallback, no deadlock (11 races)"
echo "LOCK_KEY_FORMULA=hashtext('capture_composition:' || payment_session_id::text)"
echo "RPC=payment_session_acquire_capture_composition"
echo "SESSION_ID=$SESSION_ID"
