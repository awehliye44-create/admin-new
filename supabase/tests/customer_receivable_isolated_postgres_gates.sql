-- ============================================================
-- Isolated Postgres gate — customer receivable SSOT
-- Safe: creates disposable database objects in schema recv_gate_*.
-- Does NOT touch production ONECAB schema.
-- Run:
--   psql -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 -f this_file.sql
-- ============================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS recv_gate;

-- Minimal stub parents (no production FKs)
CREATE TABLE IF NOT EXISTS recv_gate.customers (id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS recv_gate.trips (id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS recv_gate.payment_sessions (id uuid PRIMARY KEY);

DROP TABLE IF EXISTS recv_gate.payment_session_receivable_allocations CASCADE;
DROP TABLE IF EXISTS recv_gate.customer_receivable_events CASCADE;
DROP TABLE IF EXISTS recv_gate.customer_receivables CASCADE;

CREATE TABLE recv_gate.customer_receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES recv_gate.customers(id),
  currency text NOT NULL DEFAULT 'gbp',
  source_trip_id uuid NOT NULL REFERENCES recv_gate.trips(id),
  source_payment_session_id uuid NULL,
  source_authorisation_id uuid NULL,
  source_type text NOT NULL,
  reason_code text NOT NULL,
  original_amount_pence integer NOT NULL,
  outstanding_amount_pence integer NOT NULL,
  status text NOT NULL,
  idempotency_key text NOT NULL,
  reserved_payment_session_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL,
  waived_at timestamptz NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT customer_receivables_status_chk CHECK (
    status IN ('OPEN', 'RESERVED', 'SETTLED', 'WAIVED', 'MANUAL_REVIEW')
  ),
  CONSTRAINT customer_receivables_original_positive_chk CHECK (original_amount_pence > 0),
  CONSTRAINT customer_receivables_outstanding_nonneg_chk CHECK (outstanding_amount_pence >= 0),
  CONSTRAINT customer_receivables_outstanding_lte_original_chk CHECK (
    outstanding_amount_pence <= original_amount_pence
  ),
  CONSTRAINT customer_receivables_settled_invariant_chk CHECK (
    status <> 'SETTLED' OR (outstanding_amount_pence = 0 AND settled_at IS NOT NULL)
  ),
  CONSTRAINT customer_receivables_open_outstanding_chk CHECK (
    status NOT IN ('OPEN', 'RESERVED', 'MANUAL_REVIEW') OR outstanding_amount_pence > 0
  )
);

CREATE UNIQUE INDEX customer_receivables_idempotency_key_uidx
  ON recv_gate.customer_receivables (idempotency_key);

CREATE UNIQUE INDEX customer_receivables_one_open_per_source_uidx
  ON recv_gate.customer_receivables (source_trip_id, source_type, reason_code)
  WHERE status IN ('OPEN', 'RESERVED', 'MANUAL_REVIEW');

CREATE TABLE recv_gate.customer_receivable_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receivable_id uuid NOT NULL REFERENCES recv_gate.customer_receivables(id),
  event_type text NOT NULL,
  amount_pence integer NOT NULL DEFAULT 0,
  payment_session_id uuid NULL,
  trip_id uuid NULL,
  actor_role text NOT NULL DEFAULT 'system',
  note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recv_gate.payment_session_receivable_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_session_id uuid NOT NULL,
  receivable_id uuid NOT NULL REFERENCES recv_gate.customer_receivables(id),
  recovery_trip_id uuid NULL,
  allocated_amount_pence integer NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  captured_at timestamptz NULL,
  released_at timestamptz NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT alloc_amount_positive CHECK (allocated_amount_pence > 0),
  CONSTRAINT alloc_status_chk CHECK (status IN ('RESERVED', 'CAPTURED', 'RELEASED', 'PARTIAL'))
);

CREATE UNIQUE INDEX alloc_session_recv_uidx
  ON recv_gate.payment_session_receivable_allocations (payment_session_id, receivable_id);

CREATE UNIQUE INDEX alloc_one_active_recv_uidx
  ON recv_gate.payment_session_receivable_allocations (receivable_id)
  WHERE status = 'RESERVED';

-- Append-only events
CREATE OR REPLACE FUNCTION recv_gate.deny_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'customer_receivable_events_append_only';
END;
$$;

CREATE TRIGGER trg_deny_recv_event_update
  BEFORE UPDATE OR DELETE ON recv_gate.customer_receivable_events
  FOR EACH ROW EXECUTE FUNCTION recv_gate.deny_event_mutation();

-- Direct mutation denial unless GUC set
CREATE OR REPLACE FUNCTION recv_gate.deny_receivable_direct_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('onecab.allow_customer_receivable_write', true) = '1' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'direct_customer_receivable_write_denied';
END;
$$;

CREATE TRIGGER trg_deny_recv_direct
  BEFORE UPDATE OR DELETE ON recv_gate.customer_receivables
  FOR EACH ROW EXECUTE FUNCTION recv_gate.deny_receivable_direct_write();

-- Seed
INSERT INTO recv_gate.customers (id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
INSERT INTO recv_gate.trips (id) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc');

-- Gate: GUC required for write
DO $$
BEGIN
  BEGIN
    UPDATE recv_gate.customer_receivables SET updated_at = now() WHERE false;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- table empty
  END;
  -- Insert allowed (no UPDATE trigger on INSERT)
  INSERT INTO recv_gate.customer_receivables (
    customer_id, source_trip_id, source_type, reason_code,
    original_amount_pence, outstanding_amount_pence, status, idempotency_key
  ) VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'DECLINED_INCREMENTAL_AUTHORISATION',
    'PICKUP_WAITING_DECLINED',
    30, 30, 'OPEN', 'receivable:trip:bbbb:declined_waiting_v1'
  );
  -- Direct UPDATE denied
  BEGIN
    UPDATE recv_gate.customer_receivables SET outstanding_amount_pence = 20;
    RAISE EXCEPTION 'expected_direct_update_denied';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%direct_customer_receivable_write_denied%' THEN
        RAISE;
      END IF;
  END;
  -- GUC allows update
  PERFORM set_config('onecab.allow_customer_receivable_write', '1', true);
  UPDATE recv_gate.customer_receivables
    SET status = 'RESERVED', outstanding_amount_pence = 30, updated_at = now()
    WHERE idempotency_key = 'receivable:trip:bbbb:declined_waiting_v1';
END $$;

-- Idempotency: duplicate OPEN key rejected
DO $$
BEGIN
  BEGIN
    INSERT INTO recv_gate.customer_receivables (
      customer_id, source_trip_id, source_type, reason_code,
      original_amount_pence, outstanding_amount_pence, status, idempotency_key
    ) VALUES (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'DECLINED_INCREMENTAL_AUTHORISATION',
      'PICKUP_WAITING_DECLINED',
      30, 30, 'OPEN', 'receivable:trip:bbbb:declined_waiting_v1'
    );
    RAISE EXCEPTION 'expected_idempotency_violation';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END $$;

-- Concurrent reservation uniqueness: one RESERVED alloc per receivable
DO $$
DECLARE
  v_recv uuid;
  v_ps1 uuid := 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  v_ps2 uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
BEGIN
  SELECT id INTO v_recv FROM recv_gate.customer_receivables
    WHERE idempotency_key = 'receivable:trip:bbbb:declined_waiting_v1';
  INSERT INTO recv_gate.payment_session_receivable_allocations (
    payment_session_id, receivable_id, allocated_amount_pence, status
  ) VALUES (v_ps1, v_recv, 30, 'RESERVED');
  BEGIN
    INSERT INTO recv_gate.payment_session_receivable_allocations (
      payment_session_id, receivable_id, allocated_amount_pence, status
    ) VALUES (v_ps2, v_recv, 30, 'RESERVED');
    RAISE EXCEPTION 'expected_one_active_reservation';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END $$;

-- Partial settlement: settle 20 of 30 → residual 10 OPEN
DO $$
DECLARE
  v_recv uuid;
BEGIN
  SELECT id INTO v_recv FROM recv_gate.customer_receivables
    WHERE idempotency_key = 'receivable:trip:bbbb:declined_waiting_v1';
  PERFORM set_config('onecab.allow_customer_receivable_write', '1', true);
  -- Partial: reduce outstanding, stay OPEN (not full SETTLED)
  UPDATE recv_gate.customer_receivables
    SET outstanding_amount_pence = 10,
        status = 'OPEN',
        reserved_payment_session_id = NULL,
        updated_at = now()
    WHERE id = v_recv;
  UPDATE recv_gate.payment_session_receivable_allocations
    SET status = 'PARTIAL', captured_at = now(), updated_at = now(),
        allocated_amount_pence = 20
    WHERE receivable_id = v_recv AND status = 'RESERVED';
  IF (SELECT outstanding_amount_pence FROM recv_gate.customer_receivables WHERE id = v_recv) <> 10 THEN
    RAISE EXCEPTION 'partial_settlement_failed';
  END IF;
  -- Full settle invariant
  UPDATE recv_gate.customer_receivables
    SET outstanding_amount_pence = 0, status = 'SETTLED', settled_at = now()
    WHERE id = v_recv;
END $$;

-- Settlement idempotency: second settle of already SETTLED is no-op shape
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM recv_gate.customer_receivables WHERE status = 'SETTLED';
  IF v_count <> 1 THEN RAISE EXCEPTION 'expected_one_settled'; END IF;
END $$;

-- Append-only events
DO $$
DECLARE
  v_recv uuid;
  v_ev uuid;
BEGIN
  SELECT id INTO v_recv FROM recv_gate.customer_receivables LIMIT 1;
  INSERT INTO recv_gate.customer_receivable_events (receivable_id, event_type, amount_pence)
    VALUES (v_recv, 'SETTLED', 30) RETURNING id INTO v_ev;
  BEGIN
    UPDATE recv_gate.customer_receivable_events SET amount_pence = 1 WHERE id = v_ev;
    RAISE EXCEPTION 'expected_append_only';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%append_only%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM recv_gate.customer_receivable_events WHERE id = v_ev;
    RAISE EXCEPTION 'expected_append_only_delete';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%append_only%' THEN RAISE; END IF;
  END;
END $$;

-- Later booking availability: after release, OPEN again
DO $$
DECLARE
  v_recv uuid;
BEGIN
  -- Second trip receivable OPEN
  INSERT INTO recv_gate.customer_receivables (
    customer_id, source_trip_id, source_type, reason_code,
    original_amount_pence, outstanding_amount_pence, status, idempotency_key
  ) VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'DECLINED_INCREMENTAL_AUTHORISATION',
    'PICKUP_WAITING_DECLINED',
    6, 6, 'OPEN', 'receivable:trip:cccc:declined_waiting_v1'
  );
  SELECT id INTO v_recv FROM recv_gate.customer_receivables
    WHERE idempotency_key = 'receivable:trip:cccc:declined_waiting_v1';
  PERFORM set_config('onecab.allow_customer_receivable_write', '1', true);
  UPDATE recv_gate.customer_receivables SET status = 'RESERVED' WHERE id = v_recv;
  -- Safe release → OPEN again (available to later booking)
  UPDATE recv_gate.customer_receivables
    SET status = 'OPEN', reserved_payment_session_id = NULL WHERE id = v_recv;
  IF (SELECT status FROM recv_gate.customer_receivables WHERE id = v_recv) <> 'OPEN' THEN
    RAISE EXCEPTION 'release_to_open_failed';
  END IF;
END $$;

COMMIT;

-- Cleanup schema (leave evidence in output)
SELECT 'ISOLATED_POSTGRES_GATES_PASS' AS result,
  (SELECT count(*) FROM recv_gate.customer_receivables) AS receivable_rows,
  (SELECT count(*) FROM recv_gate.customer_receivable_events) AS event_rows;

DROP SCHEMA recv_gate CASCADE;
