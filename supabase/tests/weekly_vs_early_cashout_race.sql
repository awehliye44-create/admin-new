/**
 * Isolated WEEKLY_SCHEDULED vs EARLY_CASHOUT occupancy + reservation race.
 * Does not touch public payout/wallet/provider tables.
 * Run: psql -h 127.0.0.1 -p 5432 -d postgres -U admin -v ON_ERROR_STOP=1 -f this file
 */

DROP SCHEMA IF EXISTS weekly_early_race_sim CASCADE;
CREATE SCHEMA weekly_early_race_sim;

CREATE TABLE weekly_early_race_sim.driver_wallets (
  driver_id uuid PRIMARY KEY,
  locked_at timestamptz
);

CREATE TABLE weekly_early_race_sim.ledger (
  id uuid PRIMARY KEY,
  driver_id uuid NOT NULL,
  type text NOT NULL,
  amount_pence integer NOT NULL
);

CREATE TABLE weekly_early_race_sim.payout_items (
  id uuid PRIMARY KEY,
  driver_id uuid NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  execution_status text,
  amount_pence integer NOT NULL
);

CREATE TABLE weekly_early_race_sim.allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_item_id uuid NOT NULL REFERENCES weekly_early_race_sim.payout_items(id),
  ledger_entry_id uuid NOT NULL REFERENCES weekly_early_race_sim.ledger(id),
  amount_pence integer NOT NULL
);

CREATE TABLE weekly_early_race_sim.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_item_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  amount_pence integer NOT NULL,
  status text NOT NULL,
  UNIQUE (payout_item_id)
);

CREATE TABLE weekly_early_race_sim.intents (
  payout_item_id uuid PRIMARY KEY,
  provider_payment_id text NOT NULL
);

CREATE TABLE weekly_early_race_sim.debits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_item_id uuid NOT NULL,
  type text NOT NULL,
  amount_pence integer NOT NULL
);

CREATE OR REPLACE FUNCTION weekly_early_race_sim.releases(p_status text, p_exec text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(btrim(coalesce(p_status, ''))) IN (
    'CANCELLED', 'RELEASED', 'INELIGIBLE', 'FAILED', 'REVERSED', 'RETURNED',
    'INVALID_ORPHANED', 'LEDGER_SYNC_FAILED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'
  ) OR upper(btrim(coalesce(p_exec, ''))) IN (
    'CANCELLED', 'RELEASED', 'INELIGIBLE', 'FAILED', 'REVERSED', 'RETURNED',
    'INVALID_ORPHANED', 'LEDGER_SYNC_FAILED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'
  );
$$;

CREATE OR REPLACE FUNCTION weekly_early_race_sim.trg_alloc()
RETURNS trigger
LANGUAGE plpgsql AS $trg$
DECLARE
  v_item weekly_early_race_sim.payout_items%ROWTYPE;
  v_ledger weekly_early_race_sim.ledger%ROWTYPE;
  v_other integer;
BEGIN
  SELECT * INTO v_item FROM weekly_early_race_sim.payout_items WHERE id = NEW.payout_item_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_item.driver_id::text, 0));
  SELECT * INTO v_ledger FROM weekly_early_race_sim.ledger WHERE id = NEW.ledger_entry_id FOR UPDATE;
  SELECT coalesce(sum(a.amount_pence), 0) INTO v_other
  FROM weekly_early_race_sim.allocations a
  JOIN weekly_early_race_sim.payout_items pi ON pi.id = a.payout_item_id
  WHERE a.ledger_entry_id = NEW.ledger_entry_id
    AND a.id IS DISTINCT FROM NEW.id
    AND NOT weekly_early_race_sim.releases(pi.status, pi.execution_status);
  IF v_other + NEW.amount_pence > v_ledger.amount_pence THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISMATCH: ledger entry already allocated'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$trg$;

CREATE TRIGGER trg_alloc BEFORE INSERT ON weekly_early_race_sim.allocations
FOR EACH ROW EXECUTE FUNCTION weekly_early_race_sim.trg_alloc();

CREATE OR REPLACE FUNCTION weekly_early_race_sim.reserve(p_item uuid)
RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  v_item weekly_early_race_sim.payout_items%ROWTYPE;
  v_live integer;
  v_active integer;
  v_available integer;
  v_alloc integer;
  v_res uuid;
BEGIN
  SELECT * INTO v_item FROM weekly_early_race_sim.payout_items WHERE id = p_item;
  BEGIN
    PERFORM 1 FROM weekly_early_race_sim.driver_wallets WHERE driver_id = v_item.driver_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'WALLET_LOCK_TIMEOUT');
  END;

  SELECT coalesce(sum(amount_pence), 0) INTO v_alloc
  FROM weekly_early_race_sim.allocations WHERE payout_item_id = p_item;
  IF v_alloc IS DISTINCT FROM v_item.amount_pence THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_LINEAGE_MISMATCH');
  END IF;

  SELECT coalesce(sum(amount_pence), 0) INTO v_live FROM weekly_early_race_sim.ledger
  WHERE driver_id = v_item.driver_id AND type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT');
  SELECT coalesce(sum(amount_pence), 0) INTO v_active FROM weekly_early_race_sim.reservations
  WHERE driver_id = v_item.driver_id AND status = 'ACTIVE' AND payout_item_id IS DISTINCT FROM p_item;
  v_available := greatest(0, v_live - v_active);
  IF v_available < v_item.amount_pence THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'INSUFFICIENT_AVAILABLE_WALLET',
      'available_pence', v_available, 'required_pence', v_item.amount_pence);
  END IF;

  INSERT INTO weekly_early_race_sim.reservations (payout_item_id, driver_id, amount_pence, status)
  VALUES (p_item, v_item.driver_id, v_item.amount_pence, 'ACTIVE')
  RETURNING id INTO v_res;

  UPDATE weekly_early_race_sim.payout_items SET status = 'RESERVED', execution_status = 'RESERVED'
  WHERE id = p_item;

  RETURN jsonb_build_object('ok', true, 'reservation_id', v_res, 'amount_pence', v_item.amount_pence);
END;
$fn$;

CREATE OR REPLACE FUNCTION weekly_early_race_sim.submit_after_reserve(p_item uuid)
RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  v_item weekly_early_race_sim.payout_items%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM weekly_early_race_sim.payout_items WHERE id = p_item;
  IF v_item.status IS DISTINCT FROM 'RESERVED' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PROVIDER_BEFORE_RESERVATION');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM weekly_early_race_sim.reservations
    WHERE payout_item_id = p_item AND status = 'ACTIVE'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PROVIDER_BEFORE_RESERVATION');
  END IF;
  INSERT INTO weekly_early_race_sim.intents (payout_item_id, provider_payment_id)
  VALUES (p_item, 'sim-ref-' || p_item::text);
  RETURN jsonb_build_object('ok', true);
END;
$fn$;

DO $$
DECLARE
  d uuid := 'c40dd8a6-f422-40bc-9534-bae7be88b93e';
  e1 uuid := 'b373cba7-4153-4519-84cc-6e3e146ef40c'; -- 435
  e2 uuid := '813833c7-1cf3-4c42-a467-eb4d3e275cb0'; -- 777
  e3 uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'; -- 6954 remainder of 8166
  fee uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  weekly uuid := '11111111-1111-1111-1111-111111111111';
  early uuid := '22222222-2222-2222-2222-222222222222';
  early2 uuid := '33333333-3333-3333-3333-333333333333';
  weekly2 uuid := '44444444-4444-4444-4444-444444444444';
  r jsonb;
  n int;
  remaining int;
BEGIN
  INSERT INTO weekly_early_race_sim.driver_wallets(driver_id) VALUES (d);
  INSERT INTO weekly_early_race_sim.ledger(id, driver_id, type, amount_pence) VALUES
    (e1, d, 'TRIP_EARNING_NET', 435),
    (e2, d, 'TRIP_EARNING_NET', 777),
    (e3, d, 'TRIP_EARNING_NET', 6954),
    (fee, d, 'CASHOUT_FEE', -50);

  INSERT INTO weekly_early_race_sim.payout_items(id, driver_id, kind, status, execution_status, amount_pence)
  VALUES
    (weekly, d, 'WEEKLY_SCHEDULED', 'CREATED', 'CREATED', 8166),
    (early, d, 'EARLY_CASHOUT', 'VALIDATED', 'VALIDATED', 8166);

  -- 6. Completed early principal+fee never repayable as weekly credits.
  IF EXISTS (
    SELECT 1 FROM weekly_early_race_sim.ledger
    WHERE type IN ('EARLY_CASHOUT', 'CASHOUT_FEE') AND amount_pence > 0
  ) THEN
    RAISE EXCEPTION 'FEE_CREDIT_FAIL';
  END IF;

  -- Sequential: weekly freeze occupies 8166; early same earnings must fail.
  INSERT INTO weekly_early_race_sim.allocations(payout_item_id, ledger_entry_id, amount_pence)
  VALUES (weekly, e1, 435), (weekly, e2, 777), (weekly, e3, 6954);

  BEGIN
    INSERT INTO weekly_early_race_sim.allocations(payout_item_id, ledger_entry_id, amount_pence)
    VALUES (early, e1, 435);
    RAISE EXCEPTION 'EARLY_AFTER_WEEKLY_FREEZE_SHOULD_FAIL';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  SELECT count(*) INTO n FROM weekly_early_race_sim.allocations WHERE payout_item_id = early;
  IF n <> 0 THEN RAISE EXCEPTION 'EARLY_ALLOC_LEAK n=%', n; END IF;

  r := weekly_early_race_sim.reserve(weekly);
  IF r->>'ok' <> 'true' OR (r->>'amount_pence')::int <> 8166 THEN
    RAISE EXCEPTION 'WEEKLY_RESERVE_FAIL %', r;
  END IF;

  -- 5/9. Provider only after ACTIVE 8166 reservation.
  r := weekly_early_race_sim.submit_after_reserve(weekly);
  IF r->>'ok' <> 'true' THEN RAISE EXCEPTION 'PROVIDER_AFTER_RESERVE_FAIL %', r; END IF;
  SELECT count(*) INTO n FROM weekly_early_race_sim.intents;
  IF n <> 1 THEN RAISE EXCEPTION 'INTENT_CARDINALITY %', n; END IF;
  SELECT count(*) INTO n FROM weekly_early_race_sim.reservations WHERE status = 'ACTIVE';
  IF n <> 1 THEN RAISE EXCEPTION 'RESERVATION_CARDINALITY %', n; END IF;

  -- Losing reserve cannot create a second ACTIVE reservation or intent.
  r := weekly_early_race_sim.reserve(early);
  IF r->>'ok' <> 'false' OR r->>'error_code' NOT IN ('INSUFFICIENT_AVAILABLE_WALLET', 'PAYOUT_LINEAGE_MISMATCH') THEN
    RAISE EXCEPTION 'LOSER_RESERVE_NOT_CONFLICT %', r;
  END IF;
  SELECT count(*) INTO n FROM weekly_early_race_sim.reservations WHERE status = 'ACTIVE';
  IF n <> 1 THEN RAISE EXCEPTION 'SECOND_ACTIVE_RESERVATION %', n; END IF;
  SELECT count(*) INTO n FROM weekly_early_race_sim.intents;
  IF n <> 1 THEN RAISE EXCEPTION 'SECOND_PROVIDER_INTENT %', n; END IF;
  SELECT count(*) INTO n FROM weekly_early_race_sim.debits;
  IF n <> 0 THEN RAISE EXCEPTION 'UNEXPECTED_DEBIT'; END IF;

  -- 8. After a completed early withdrawal of 435, weekly remaining is 7731.
  DELETE FROM weekly_early_race_sim.intents;
  DELETE FROM weekly_early_race_sim.reservations;
  DELETE FROM weekly_early_race_sim.allocations;
  UPDATE weekly_early_race_sim.payout_items SET status = 'COMPLETED', execution_status = 'COMPLETED' WHERE id = early;
  INSERT INTO weekly_early_race_sim.allocations(payout_item_id, ledger_entry_id, amount_pence)
  VALUES (early, e1, 435);
  -- COMPLETED does not release occupancy.
  INSERT INTO weekly_early_race_sim.payout_items(id, driver_id, kind, status, execution_status, amount_pence)
  VALUES (weekly2, d, 'WEEKLY_SCHEDULED', 'CREATED', 'CREATED', 7731);
  INSERT INTO weekly_early_race_sim.allocations(payout_item_id, ledger_entry_id, amount_pence)
  VALUES (weekly2, e2, 777), (weekly2, e3, 6954);
  SELECT coalesce(sum(amount_pence), 0) INTO remaining
  FROM weekly_early_race_sim.allocations WHERE payout_item_id = weekly2;
  IF remaining <> 7731 THEN RAISE EXCEPTION 'REMAINING_FAIL %', remaining; END IF;
  BEGIN
    INSERT INTO weekly_early_race_sim.allocations(payout_item_id, ledger_entry_id, amount_pence)
    VALUES (weekly2, e1, 435);
    RAISE EXCEPTION 'COMPLETED_EARLY_REALLOCATED';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  RAISE NOTICE 'weekly_early_race_sim serial PASS';
END $$;
