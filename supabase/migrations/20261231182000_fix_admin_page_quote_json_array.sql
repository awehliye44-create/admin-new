-- Fix Admin document type rename / save:
-- _admin_page_quote_json_scalar treated JSON arrays as text ('[30, 14, 7]'),
-- which cannot cast to integer[] (reminder_days_before_expiry). The whole
-- admin_page_mutate UPDATE then failed — including name renames — because
-- DocumentTypeConfig always patches reminder_days_before_expiry.

CREATE OR REPLACE FUNCTION public._admin_page_quote_json_scalar(p_val jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_parts text[] := ARRAY[]::text[];
  v_elem jsonb;
BEGIN
  IF p_val IS NULL OR p_val = 'null'::jsonb THEN
    RETURN 'NULL';
  END IF;
  IF jsonb_typeof(p_val) = 'number' THEN
    RETURN p_val #>> '{}';
  END IF;
  IF jsonb_typeof(p_val) = 'boolean' THEN
    RETURN CASE WHEN (p_val #>> '{}')::boolean THEN 'TRUE' ELSE 'FALSE' END;
  END IF;
  IF jsonb_typeof(p_val) = 'array' THEN
    IF jsonb_array_length(p_val) = 0 THEN
      -- Empty Postgres array literal; casts to integer[] / text[] / etc.
      RETURN '''{}''';
    END IF;
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_val) LOOP
      v_parts := array_append(v_parts, public._admin_page_quote_json_scalar(v_elem));
    END LOOP;
    RETURN 'ARRAY[' || array_to_string(v_parts, ',') || ']';
  END IF;
  IF jsonb_typeof(p_val) = 'object' THEN
    -- Object patches are not used by page mutates today; keep fail-closed.
    RAISE EXCEPTION 'not authorized: object patch values are not supported'
      USING ERRCODE = '42501';
  END IF;
  RETURN quote_literal(p_val #>> '{}');
END;
$fn$;

COMMENT ON FUNCTION public._admin_page_quote_json_scalar(jsonb) IS
  'Quote jsonb scalars for admin_page_mutate SQL. Arrays → ARRAY[…]/ empty → ''{}''.';
