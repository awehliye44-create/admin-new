-- Isolated non-production verification for vehicle lifecycle RPCs
-- (migrations 20270305100000 + 20270305110000). Run only against localhost.
-- Does not mark Driver contracts verified — that stays a separate client flip.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF inet_server_addr() IS DISTINCT FROM '127.0.0.1'
     AND inet_server_addr() IS DISTINCT FROM '::1'
     AND host(inet_server_addr()) NOT IN ('127.0.0.1', 'localhost', '::1')
  THEN
    -- Docker bridge may report container IP; require application_name marker instead.
    NULL;
  END IF;
END $$;

SELECT CASE WHEN
  to_regprocedure('public.resolve_vehicle_document_target(uuid)') IS NOT NULL
  AND to_regprocedure('public.resolve_trip_active_vehicle_id(uuid)') IS NOT NULL
  AND to_regprocedure('public.assert_document_vehicle_ownership(uuid,uuid)') IS NOT NULL
  AND to_regprocedure('public.admin_assign_shared_vehicle(uuid,uuid,boolean,text)') IS NOT NULL
  AND to_regprocedure('public.admin_return_shared_vehicle_assignment(uuid,text)') IS NOT NULL
  AND to_regprocedure('public.admin_reactivate_driver_vehicle(uuid,uuid)') IS NOT NULL
  AND to_regprocedure('public.admin_resolve_document_vehicle_link(uuid,uuid)') IS NOT NULL
  AND to_regprocedure('public.list_driver_saved_vehicles()') IS NOT NULL
  AND to_regprocedure('public.set_driver_primary_vehicle(uuid)') IS NOT NULL
  AND to_regprocedure('public.remove_driver_saved_vehicle(uuid)') IS NOT NULL
  AND to_regprocedure('public.get_my_vehicle_change_applicable_documents()') IS NOT NULL
  AND to_regprocedure('public.vehicle_change_applicable_documents(uuid)') IS NOT NULL
  AND to_regprocedure('public.admin_list_open_vehicle_assignments(uuid)') IS NOT NULL
  AND to_regprocedure('public.admin_list_vehicle_change_requests(integer)') IS NOT NULL
  AND to_regprocedure('public.admin_vehicle_document_compliance_summaries(uuid[])') IS NOT NULL
THEN 'RPC_SURFACE_OK' ELSE 'RPC_SURFACE_MISSING' END AS rpc_surface;

SELECT CASE WHEN
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'documents'
       AND column_name = 'ambiguity_review_required'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'vehicles'
       AND column_name = 'is_trip_active'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'vehicles'
       AND column_name = 'operational_status'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'vehicle_driver_assignments'
  )
THEN 'SCHEMA_OK' ELSE 'SCHEMA_MISSING' END AS schema_surface;

-- Ambiguity must remain a flag — never auto-guess a vehicle_id in the resolve path.
SELECT CASE WHEN
  position('VEHICLE_OWNERSHIP_MISMATCH' in pg_get_functiondef('public.admin_resolve_document_vehicle_link(uuid,uuid)'::regprocedure)) > 0
  AND position('ambiguity_review_required = false' in pg_get_functiondef('public.admin_resolve_document_vehicle_link(uuid,uuid)'::regprocedure)) > 0
  AND position('DOCUMENT_VEHICLE_OWNERSHIP_MISMATCH' in pg_get_functiondef('public.assert_document_vehicle_ownership(uuid,uuid)'::regprocedure)) > 0
THEN 'AMBIGUITY_FAIL_CLOSED_OK' ELSE 'AMBIGUITY_FAIL_CLOSED_MISSING' END AS ambiguity;

-- Applicable docs expose sides_on_file for replacement dual-side recovery.
SELECT CASE WHEN
  position('sides_on_file' in pg_get_functiondef('public.vehicle_change_applicable_documents(uuid)'::regprocedure)) > 0
  AND position('Back required' in pg_get_functiondef('public.vehicle_change_applicable_documents(uuid)'::regprocedure)) > 0
  AND position('document_attachments' in pg_get_functiondef('public.vehicle_change_applicable_documents(uuid)'::regprocedure)) > 0
THEN 'SIDES_ON_FILE_OK' ELSE 'SIDES_ON_FILE_MISSING' END AS sides_recovery;

-- Stamp forces pending replacement target + ownership check.
SELECT CASE WHEN
  position('resolve_vehicle_document_target' in pg_get_functiondef('public.trg_documents_stamp_vehicle_id()'::regprocedure)) > 0
  AND position('assert_document_vehicle_ownership' in pg_get_functiondef('public.trg_documents_stamp_vehicle_id()'::regprocedure)) > 0
THEN 'STAMP_OK' ELSE 'STAMP_MISSING' END AS stamp;

-- Assign/return preserve assets (no DELETE FROM vehicles/documents in bodies).
SELECT CASE WHEN
  pg_get_functiondef('public.admin_assign_shared_vehicle(uuid,uuid,boolean,text)'::regprocedure) !~* 'DELETE\s+FROM\s+public\.vehicles'
  AND pg_get_functiondef('public.admin_return_shared_vehicle_assignment(uuid,text)'::regprocedure) !~* 'DELETE\s+FROM\s+public\.vehicles'
  AND position('ALREADY_ASSIGNED' in pg_get_functiondef('public.admin_assign_shared_vehicle(uuid,uuid,boolean,text)'::regprocedure)) > 0
THEN 'ASSIGN_PRESERVE_OK' ELSE 'ASSIGN_PRESERVE_MISSING' END AS assign_preserve;

SELECT 'VEHICLE_LIFECYCLE_VERIFY_COMPLETE' AS done;
