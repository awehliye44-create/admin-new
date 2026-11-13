-- Rollback of 20270222190000: stamp commissionable from the quote ride fare again.
-- LOCAL / release-candidate only. Rows already stamped keep their value (no data is rewritten).
DO $rb$
DECLARE
  v_def text;
  v_sig constant text :=
    'public.apply_consumed_server_fare_airport_split_to_trip(uuid,uuid,uuid,uuid,uuid,integer)';
BEGIN
  SELECT pg_get_functiondef(to_regprocedure(v_sig)) INTO v_def;
  IF v_def IS NULL OR position('v_commissionable' in v_def) = 0 THEN RETURN; END IF;
  v_def := replace(v_def, 'commissionable_fare_pence = v_commissionable,', 'commissionable_fare_pence = v_trip_fare,');
  v_def := replace(v_def, '''commissionable_fare_pence'', v_commissionable,', '''commissionable_fare_pence'', v_trip_fare,');
  -- The now-unused v_commissionable declaration / calculation are harmless and left in place.
  EXECUTE v_def;
END
$rb$;
