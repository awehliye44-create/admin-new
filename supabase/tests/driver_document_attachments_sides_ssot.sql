-- Local structural/regression checks for document attachments sides SSOT.
-- Run after applying 20260907120000_driver_document_attachments_sides_ssot.sql on a local DB.
-- DO NOT run against production from this task.
--
-- Covers local-runnable portions of the sides contract:
--   table + side enum CHECK, current-side uniqueness, idempotency unique index,
--   RLS enabled, single submit_driver_document overload with p_side,
--   SSOT view exposes side, path extractor behaviour.
--
-- Behavioral RPC fixtures (Front/Back independence, overwrite, invalid side,
-- cross-driver forbid) require a seeded local Supabase (Docker). Without Docker,
-- use admin-new vitest migration contract + driver mobile unit tests instead.
--
-- Run (local only):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/driver_document_attachments_sides_ssot.sql

DO $$
DECLARE
  v_cols text;
  v_fn text;
  v_view text;
  v_check text;
  v_rls boolean;
BEGIN
  IF to_regclass('public.document_attachments') IS NULL THEN
    RAISE EXCEPTION 'document_attachments table missing';
  END IF;

  SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
    INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'document_attachments';

  IF v_cols !~ 'side'
     OR v_cols !~ 'storage_path'
     OR v_cols !~ 'is_current'
     OR v_cols !~ 'submission_idempotency_key'
     OR v_cols !~ 'superseded_by' THEN
    RAISE EXCEPTION 'document_attachments missing required columns: %', v_cols;
  END IF;

  SELECT pg_get_constraintdef(c.oid)
    INTO v_check
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'document_attachments'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%side%'
  LIMIT 1;

  IF v_check IS NULL
     OR v_check !~* 'front'
     OR v_check !~* 'back'
     OR v_check !~* 'full'
     OR v_check !~* 'other' THEN
    RAISE EXCEPTION 'document_attachments.side CHECK missing stable enums; got %', v_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'uniq_document_attachments_doc_side_current'
  ) THEN
    RAISE EXCEPTION 'uniq_document_attachments_doc_side_current missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'uniq_document_attachments_idempotency'
  ) THEN
    RAISE EXCEPTION 'uniq_document_attachments_idempotency missing';
  END IF;

  SELECT c.relrowsecurity INTO v_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'document_attachments';

  IF v_rls IS NOT TRUE THEN
    RAISE EXCEPTION 'document_attachments RLS must be enabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'document_attachments'
      AND policyname = 'Drivers can view own document attachments'
  ) THEN
    RAISE EXCEPTION 'Drivers SELECT RLS policy missing on document_attachments';
  END IF;

  -- Drivers must not have direct INSERT/UPDATE/DELETE policies (RPC owns writes).
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'document_attachments'
      AND roles::text ILIKE '%authenticated%'
      AND (
        cmd = 'INSERT'
        OR cmd = 'UPDATE'
        OR cmd = 'DELETE'
        OR (cmd = 'ALL' AND policyname ILIKE '%driver%')
      )
      AND policyname ILIKE '%driver%'
      AND policyname NOT ILIKE '%view%'
  ) THEN
    RAISE EXCEPTION 'Drivers must not have write policies on document_attachments';
  END IF;

  SELECT pg_get_function_identity_arguments(p.oid)
    INTO v_fn
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'submit_driver_document'
  ORDER BY 1
  LIMIT 1;

  IF v_fn IS NULL OR v_fn !~ 'p_side' THEN
    RAISE EXCEPTION 'submit_driver_document must expose p_side; got %', v_fn;
  END IF;

  -- Exactly one overload
  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'submit_driver_document'
  ) <> 1 THEN
    RAISE EXCEPTION 'submit_driver_document must have exactly one overload';
  END IF;

  SELECT pg_get_viewdef('public.driver_document_attachments_ssot'::regclass, true)
    INTO v_view;
  IF v_view IS NULL OR v_view !~ 'side' OR v_view !~ 'is_current' THEN
    RAISE EXCEPTION 'driver_document_attachments_ssot view missing or incomplete';
  END IF;

  -- Path helper: public URL → path; raw path passthrough
  IF public.driver_document_storage_path_from_locator(
    'https://thazislrdkjpvvghtvzo.supabase.co/storage/v1/object/public/driver-documents/uid/file.jpg'
  ) IS DISTINCT FROM 'uid/file.jpg' THEN
    RAISE EXCEPTION 'storage path extractor failed for public URL';
  END IF;

  IF public.driver_document_storage_path_from_locator('uid/front.jpg')
     IS DISTINCT FROM 'uid/front.jpg' THEN
    RAISE EXCEPTION 'storage path extractor failed for raw path';
  END IF;

  IF public.driver_document_storage_path_from_locator(
    'https://example.com/storage/v1/object/sign/driver-documents/uid/back.jpg?token=abc'
  ) IS DISTINCT FROM 'uid/back.jpg' THEN
    RAISE EXCEPTION 'storage path extractor failed for signed URL';
  END IF;

  RAISE NOTICE 'driver_document_attachments_sides_ssot checks passed';
END;
$$;
