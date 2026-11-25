-- #93A / #103 — isolated PostgreSQL proof of original-hold immutability + total non-regression.
-- Run locally:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/authorisation_projection_103_immutable.sql
BEGIN;

CREATE SCHEMA IF NOT EXISTS authproj103;
SET search_path TO authproj103, public;

CREATE TABLE authproj103.payment_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorised_amount_pence integer,
  original_authorised_pence integer,
  total_authorised_amount_pence integer,
  updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION authproj103.payment_sessions_authorisation_projection_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.authorised_amount_pence IS NOT NULL
     AND COALESCE(OLD.authorised_amount_pence, 0) > 0
     AND NEW.authorised_amount_pence IS DISTINCT FROM OLD.authorised_amount_pence THEN
    NEW.authorised_amount_pence := OLD.authorised_amount_pence;
  END IF;

  IF OLD.original_authorised_pence IS NOT NULL
     AND COALESCE(OLD.original_authorised_pence, 0) > 0
     AND NEW.original_authorised_pence IS DISTINCT FROM OLD.original_authorised_pence THEN
    NEW.original_authorised_pence := OLD.original_authorised_pence;
  END IF;

  IF OLD.total_authorised_amount_pence IS NOT NULL
     AND COALESCE(OLD.total_authorised_amount_pence, 0) > 0
     AND NEW.total_authorised_amount_pence IS NOT NULL
     AND COALESCE(NEW.total_authorised_amount_pence, 0) < OLD.total_authorised_amount_pence THEN
    NEW.total_authorised_amount_pence := OLD.total_authorised_amount_pence;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_authproj103_guard
  BEFORE UPDATE ON authproj103.payment_sessions
  FOR EACH ROW
  EXECUTE FUNCTION authproj103.payment_sessions_authorisation_projection_guard();

-- Seed initial authorisation 700
INSERT INTO authproj103.payment_sessions (id, authorised_amount_pence, original_authorised_pence, total_authorised_amount_pence)
VALUES ('11111111-1111-1111-1111-111111111111', 700, 700, 700);

-- Confirm increment to 800 while original remains 700
UPDATE authproj103.payment_sessions
SET total_authorised_amount_pence = 800,
    authorised_amount_pence = 800  -- contamination attempt
WHERE id = '11111111-1111-1111-1111-111111111111';

DO $$
DECLARE
  a int; t int; o int;
BEGIN
  SELECT authorised_amount_pence, total_authorised_amount_pence, original_authorised_pence
    INTO a, t, o
  FROM authproj103.payment_sessions
  WHERE id = '11111111-1111-1111-1111-111111111111';
  IF a IS DISTINCT FROM 700 THEN
    RAISE EXCEPTION 'FAIL: original authorised mutated to %', a;
  END IF;
  IF o IS DISTINCT FROM 700 THEN
    RAISE EXCEPTION 'FAIL: original_authorised_pence mutated to %', o;
  END IF;
  IF t IS DISTINCT FROM 800 THEN
    RAISE EXCEPTION 'FAIL: total not advanced to 800 (got %)', t;
  END IF;
  RAISE NOTICE 'PASS: increment 700→800 preserves original';
END $$;

-- Second sequential increment 800→900
UPDATE authproj103.payment_sessions
SET total_authorised_amount_pence = 900
WHERE id = '11111111-1111-1111-1111-111111111111';

DO $$
DECLARE a int; t int;
BEGIN
  SELECT authorised_amount_pence, total_authorised_amount_pence INTO a, t
  FROM authproj103.payment_sessions
  WHERE id = '11111111-1111-1111-1111-111111111111';
  IF a IS DISTINCT FROM 700 OR t IS DISTINCT FROM 900 THEN
    RAISE EXCEPTION 'FAIL: sequential increment a=% t=%', a, t;
  END IF;
  RAISE NOTICE 'PASS: sequential increment preserves original';
END $$;

-- Delayed / stale response must not regress total
UPDATE authproj103.payment_sessions
SET total_authorised_amount_pence = 750
WHERE id = '11111111-1111-1111-1111-111111111111';

DO $$
DECLARE t int;
BEGIN
  SELECT total_authorised_amount_pence INTO t
  FROM authproj103.payment_sessions
  WHERE id = '11111111-1111-1111-1111-111111111111';
  IF t IS DISTINCT FROM 900 THEN
    RAISE EXCEPTION 'FAIL: total regressed to %', t;
  END IF;
  RAISE NOTICE 'PASS: total non-regression';
END $$;

-- Historical promoted row remains compatible (no forced repair)
INSERT INTO authproj103.payment_sessions (id, authorised_amount_pence, original_authorised_pence, total_authorised_amount_pence)
VALUES ('22222222-2222-2222-2222-222222222222', 1482, 1482, 1482);

UPDATE authproj103.payment_sessions
SET authorised_amount_pence = 500  -- attempted "repair" blocked
WHERE id = '22222222-2222-2222-2222-222222222222';

DO $$
DECLARE a int;
BEGIN
  SELECT authorised_amount_pence INTO a
  FROM authproj103.payment_sessions
  WHERE id = '22222222-2222-2222-2222-222222222222';
  IF a IS DISTINCT FROM 1482 THEN
    RAISE EXCEPTION 'FAIL: promoted historical row was rewritten to % (Phase 1 must not repair)', a;
  END IF;
  RAISE NOTICE 'PASS: historical promoted row compatible without unsafe rewrite';
END $$;

-- Initial authorisation still supported (NULL → 700)
INSERT INTO authproj103.payment_sessions (id, authorised_amount_pence, total_authorised_amount_pence)
VALUES ('33333333-3333-3333-3333-333333333333', NULL, NULL);

UPDATE authproj103.payment_sessions
SET authorised_amount_pence = 700, original_authorised_pence = 700, total_authorised_amount_pence = 700
WHERE id = '33333333-3333-3333-3333-333333333333';

DO $$
DECLARE a int;
BEGIN
  SELECT authorised_amount_pence INTO a FROM authproj103.payment_sessions
  WHERE id = '33333333-3333-3333-3333-333333333333';
  IF a IS DISTINCT FROM 700 THEN
    RAISE EXCEPTION 'FAIL: initial authorisation seed blocked (% )', a;
  END IF;
  RAISE NOTICE 'PASS: initial authorisation confirmation supported';
END $$;

ROLLBACK;
