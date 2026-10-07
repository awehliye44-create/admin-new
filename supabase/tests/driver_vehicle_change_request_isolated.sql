\set ON_ERROR_STOP on
\pset pager off
\pset tuples_only on

CREATE OR REPLACE FUNCTION public.t_ok(cond boolean, label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RETURN 'PASS: ' || label;
END $$;
GRANT EXECUTE ON FUNCTION public.t_ok(boolean, text) TO PUBLIC;

-- Users: admin a1; driver users 11 (D1, approved+locked), 12 (D2, other plate), 13 (D3, pending vehicle)
INSERT INTO public.user_roles VALUES ('a1a1a1a1-0000-0000-0000-000000000001', 'admin');
INSERT INTO public.drivers (id, user_id, vehicle_locked, approval_status) VALUES
  ('d1d1d1d1-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', true, 'approved'),
  ('d2d2d2d2-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', true, 'approved'),
  ('d3d3d3d3-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000003', false, 'pending');
INSERT INTO public.vehicles (id, driver_id, make, model, year, color, license_plate, approval_status) VALUES
  ('e1e1e1e1-0000-0000-0000-000000000001', 'd1d1d1d1-0000-0000-0000-000000000001', 'Toyota', 'Corrolla', 2022, 'Blue', 'KX14 HLD', 'approved'),
  ('e2e2e2e2-0000-0000-0000-000000000002', 'd2d2d2d2-0000-0000-0000-000000000002', 'Ford', 'Galaxy', 2020, 'Black', 'ZZ11 ZZZ', 'approved'),
  ('e3e3e3e3-0000-0000-0000-000000000003', 'd3d3d3d3-0000-0000-0000-000000000003', 'Kia', 'Niro', 2021, 'White', 'AB12 CDE', 'pending');
INSERT INTO public.vehicle_types (id, name, slug, is_default, driver_controllable, is_active) VALUES
  ('f0000000-0000-0000-0000-000000000001', 'ONECAB GO', 'economy', true, false, true),
  ('f0000000-0000-0000-0000-000000000002', 'Comfort', 'comfort', false, false, true),
  ('f0000000-0000-0000-0000-000000000003', 'Pet-Friendly', 'pet', false, true, true),
  ('f0000000-0000-0000-0000-000000000004', 'Retired', 'retired', false, false, false);
INSERT INTO public.driver_vehicle_categories (driver_id, vehicle_type_id, is_enabled) VALUES
  ('d1d1d1d1-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000002', true);
INSERT INTO public.document_types (slug, name) VALUES
  ('v5_logbook', 'V5C Logbook'), ('mot_certificate', 'MOT Certificate'),
  ('phv_license', 'PHV Vehicle Licence'), ('private_hire_insurance', 'Private Hire Insurance'),
  ('driver_license', 'Driving Licence');
INSERT INTO public.documents (id, driver_id, document_type, status, is_current, created_at) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'd1d1d1d1-0000-0000-0000-000000000001', 'v5_logbook', 'approved', true, now() - interval '2 days'),
  ('c0000000-0000-0000-0000-000000000002', 'd1d1d1d1-0000-0000-0000-000000000001', 'mot_certificate', 'approved', true, now() - interval '2 days'),
  ('c0000000-0000-0000-0000-000000000003', 'd1d1d1d1-0000-0000-0000-000000000001', 'phv_license', 'approved', true, now() - interval '2 days'),
  ('c0000000-0000-0000-0000-000000000004', 'd1d1d1d1-0000-0000-0000-000000000001', 'private_hire_insurance', 'approved', true, now() - interval '2 days'),
  ('c0000000-0000-0000-0000-000000000005', 'd1d1d1d1-0000-0000-0000-000000000001', 'private_hire_insurance', 'approved', false, now() - interval '20 days'),
  ('c0000000-0000-0000-0000-000000000006', 'd1d1d1d1-0000-0000-0000-000000000001', 'driver_license', 'approved', true, now() - interval '2 days');
INSERT INTO public.test_eligibility VALUES ('d1d1d1d1-0000-0000-0000-000000000001', '{
  "approved": true, "code": null,
  "required_documents": ["private_hire_insurance","mot_certificate","phv_license","v5_logbook","driver_license"],
  "missing_documents": [], "expired_documents": [], "pending_documents": [], "rejected_documents": [],
  "expiring_soon_documents": ["mot_certificate"]}');

\echo === migration applies; constraints and access
SELECT t_ok((SELECT count(*) FROM pg_policies WHERE tablename='vehicle_change_requests' AND policyname ILIKE 'Drivers%') = 0, 'driver table policies removed');
SELECT t_ok(NOT has_table_privilege('authenticated', 'public.vehicle_change_requests', 'INSERT'), 'authenticated cannot INSERT');
SELECT t_ok(NOT has_table_privilege('authenticated', 'public.vehicle_change_requests', 'UPDATE'), 'authenticated cannot UPDATE');
SELECT t_ok(NOT has_table_privilege('anon', 'public.vehicle_change_requests', 'SELECT'), 'anon cannot SELECT');
SELECT t_ok(NOT has_function_privilege('anon', 'public.submit_driver_vehicle_change_request(text,text,integer,text,text,uuid)', 'EXECUTE'), 'anon cannot submit');
SELECT t_ok(NOT has_function_privilege('authenticated', 'public.vehicle_change_applicable_documents(uuid)', 'EXECUTE'), 'helper not callable by clients');

\echo === driver D1 submits
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-0000-0000-0000-000000000001', false);

-- Direct writes are blocked
DO $$ BEGIN
  INSERT INTO public.vehicle_change_requests (driver_id, vehicle_id, requested_make, requested_model, requested_year, requested_color, requested_license_plate, status)
  VALUES ('d1d1d1d1-0000-0000-0000-000000000001', 'e2e2e2e2-0000-0000-0000-000000000002', 'X','Y',2020,'Z','AA1','approved');
  RAISE EXCEPTION 'FAIL: direct insert allowed';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: direct insert denied';
END $$;
SELECT t_ok((SELECT count(*) FROM public.vehicle_change_requests) = 0, 'driver cannot read table directly (RLS, no driver policy)');

SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Corrolla',2022,'Blue','kx14  hld')->>'code') = 'NO_CHANGES', 'no-change submit rejected (plate normalised)');
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',2031,'Blue','KX14HLD')->>'field') = 'year', 'future year rejected');
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',1979,'Blue','KX14HLD')->>'field') = 'year', 'year < 1980 rejected');
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',2022,'Blue','KX-14HLD')->>'field') = 'licence_plate', 'plate punctuation rejected');
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',2022,'Blue','K  ')->>'field') = 'licence_plate', 'one-character plate rejected');
SELECT t_ok((submit_driver_vehicle_change_request('  ','Prius',2023,'Blue','KX14HLD')->>'field') = 'make', 'blank make rejected');
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',2023,'Grey','zz11zzz ')->>'code') = 'VEHICLE_OWNERSHIP_CONFLICT', 'plate conflict ignores spacing');
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Corrolla',2022,'Blue','KX14HLD')->>'code') = 'NO_CHANGES', 'no-change check ignores spacing');
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',2023,'Grey','zz11 zzz')->>'code') = 'VEHICLE_OWNERSHIP_CONFLICT', 'plate owned by another driver rejected');

SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',2023,'Grey','lm23  abc', 'b0000000-0000-0000-0000-000000000001')->'request'->>'status') = 'pending', 'submit creates pending');
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',2023,'Grey','lm23  abc', 'b0000000-0000-0000-0000-000000000001')->>'idempotent') = 'true', 'same idempotency key returns same request');
SELECT t_ok((submit_driver_vehicle_change_request('Honda','Jazz',2023,'Red','LM23 XYZ')->>'code') = 'PENDING_REQUEST_EXISTS', 'second pending rejected');
SELECT t_ok(jsonb_array_length(list_driver_vehicle_change_requests()->'requests') = 1, 'list shows own request');
SELECT t_ok((list_driver_vehicle_change_requests()->'requests'->0->'requested'->>'licence_plate') = 'LM23 ABC', 'plate stored normalised');
SELECT t_ok((list_driver_vehicle_change_requests()->'requests'->0->'previous'->>'licence_plate') = 'KX14 HLD', 'previous vehicle snapshot stored');
SELECT t_ok(NOT (list_driver_vehicle_change_requests()->'requests'->0 ? 'admin_notes'), 'admin_notes never returned to driver');
RESET ROLE;

\echo === vehicle unchanged and driver still eligible while pending
SELECT t_ok((SELECT license_plate FROM vehicles WHERE id='e1e1e1e1-0000-0000-0000-000000000001') = 'KX14 HLD', 'approved vehicle unchanged while pending');
SELECT t_ok((SELECT approval_status FROM vehicles WHERE id='e1e1e1e1-0000-0000-0000-000000000001') = 'approved', 'vehicle stays approved while pending');
SELECT t_ok((SELECT vehicle_edit_request_status FROM drivers WHERE id='d1d1d1d1-0000-0000-0000-000000000001') IS NULL, 'presence gate column not set to pending');
SELECT t_ok((SELECT count(*) FROM audit_logs WHERE event_type='vehicle_change_request_submitted') = 1, 'submit audited once');

\echo === unique index backs one-pending rule even for privileged writers
DO $$ BEGIN
  INSERT INTO public.vehicle_change_requests (driver_id, vehicle_id, requested_make, requested_model, requested_year, requested_color, requested_license_plate)
  VALUES ('d1d1d1d1-0000-0000-0000-000000000001', 'e1e1e1e1-0000-0000-0000-000000000001', 'A','B',2020,'C','QQ1');
  RAISE EXCEPTION 'FAIL: second pending row inserted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: one pending per driver (index)';
END $$;
DO $$ BEGIN
  INSERT INTO public.vehicle_change_requests (driver_id, vehicle_id, requested_make, requested_model, requested_year, requested_color, requested_license_plate, status)
  VALUES ('d2d2d2d2-0000-0000-0000-000000000002', 'e2e2e2e2-0000-0000-0000-000000000002', 'A','B',2020,'C','QQ1','weird');
  RAISE EXCEPTION 'FAIL: invalid status inserted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: status CHECK';
END $$;

\echo === other drivers
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '22222222-0000-0000-0000-000000000002', false);
SELECT t_ok(jsonb_array_length(list_driver_vehicle_change_requests()->'requests') = 0, 'D2 cannot see D1 requests');
SELECT t_ok((cancel_driver_vehicle_change_request((SELECT id FROM vehicle_change_requests LIMIT 1))->>'code') IS NOT NULL, 'D2 cannot see table rows to target');
SELECT t_ok((submit_driver_vehicle_change_request('Ford','Galaxy',2020,'Black','LM23 ABC')->>'code') = 'VEHICLE_OWNERSHIP_CONFLICT', 'plate pending for another driver rejected');
SELECT set_config('request.jwt.claim.sub', '33333333-0000-0000-0000-000000000003', false);
SELECT t_ok((submit_driver_vehicle_change_request('Kia','Niro',2021,'Black','AB12 CDE')->>'code') = 'VEHICLE_NOT_APPROVED', 'unapproved vehicle must be edited, not change-requested');
DO $$ BEGIN
  PERFORM admin_get_vehicle_change_review('00000000-0000-0000-0000-000000000000');
  RAISE EXCEPTION 'FAIL: driver called admin RPC';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: driver cannot call admin review';
END $$;
RESET ROLE;

\echo === admin review: reject needs reason; approve gates
SELECT set_config('request.jwt.claim.sub', 'a1a1a1a1-0000-0000-0000-000000000001', false);
SET ROLE authenticated;
SELECT t_ok((SELECT count(*) FROM vehicle_change_requests) = 1, 'admin can read requests');
DO $$ BEGIN
  UPDATE public.vehicle_change_requests SET status = 'approved';
  RAISE EXCEPTION 'FAIL: admin direct update allowed';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: admin direct update denied (RPC only)';
END $$;

SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests), NULL)->>'code') = 'INVALID_DECISION', 'null decision rejected');
SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests), 'reject', '  ')->>'code') = 'REJECTION_REASON_REQUIRED', 'reject needs reason');

SELECT t_ok(jsonb_array_length(admin_get_vehicle_change_review((SELECT id FROM vehicle_change_requests))->'vehicle_documents'->'documents') = 4, 'review lists the 4 required vehicle documents');
SELECT t_ok(NOT (admin_get_vehicle_change_review((SELECT id FROM vehicle_change_requests))::text LIKE '%c0000000-0000-0000-0000-000000000005%'), 'superseded document not offered for review');
SELECT t_ok((SELECT bool_and((c->>'enabled')::boolean = (c->>'slug' IN ('economy','comfort')))
               FROM jsonb_array_elements(admin_get_vehicle_change_review((SELECT id FROM vehicle_change_requests))->'categories') c), 'effective categories: GO default on, Comfort assigned, Pet off');
SELECT t_ok(NOT (admin_get_vehicle_change_review((SELECT id FROM vehicle_change_requests))::text LIKE '%retired%'), 'inactive category excluded');

SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests), 'approve', NULL, NULL,
   ARRAY['c0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002']::uuid[],
   ARRAY['f0000000-0000-0000-0000-000000000001']::uuid[])->>'code') = 'VEHICLE_DOCUMENTS_NOT_REVIEWED', 'partial document review blocks approval');
SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests), 'approve', NULL, NULL,
   ARRAY['c0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-000000000004']::uuid[],
   NULL)->>'code') = 'CATEGORY_RECHECK_REQUIRED', 'approval requires category recheck');
SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests), 'approve', NULL, NULL,
   ARRAY['c0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-000000000004']::uuid[],
   ARRAY[]::uuid[])->>'code') = 'NO_ELIGIBLE_CATEGORY', 'empty category set blocked');
SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests), 'approve', NULL, NULL,
   ARRAY['c0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-000000000004']::uuid[],
   ARRAY['f0000000-0000-0000-0000-000000000004']::uuid[])->>'code') = 'UNKNOWN_VEHICLE_CATEGORY', 'inactive category blocked');
RESET ROLE;

\echo === non-compliant documents block approval
UPDATE public.test_eligibility SET payload = jsonb_set(payload, '{expired_documents}', '["private_hire_insurance"]') WHERE driver_id='d1d1d1d1-0000-0000-0000-000000000001';
SET ROLE authenticated;
SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests), 'approve', NULL, NULL,
   ARRAY['c0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-000000000004']::uuid[],
   ARRAY['f0000000-0000-0000-0000-000000000001']::uuid[])->>'code') = 'VEHICLE_DOCUMENTS_NOT_COMPLIANT', 'expired insurance blocks approval');
RESET ROLE;
UPDATE public.test_eligibility SET payload = jsonb_set(payload, '{code}', '"SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED"') WHERE driver_id='d1d1d1d1-0000-0000-0000-000000000001';
SET ROLE authenticated;
SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests), 'approve', NULL, NULL,
   ARRAY[]::uuid[], ARRAY['f0000000-0000-0000-0000-000000000001']::uuid[])->>'code') = 'DOCUMENT_RULES_UNAVAILABLE', 'missing document rules fail closed');
RESET ROLE;
UPDATE public.test_eligibility SET payload = jsonb_set(jsonb_set(payload, '{code}', 'null'), '{expired_documents}', '[]') WHERE driver_id='d1d1d1d1-0000-0000-0000-000000000001';

\echo === every failed approval left state untouched
SELECT t_ok((SELECT status FROM vehicle_change_requests) = 'pending', 'request still pending after failed approvals');
SELECT t_ok((SELECT license_plate FROM vehicles WHERE id='e1e1e1e1-0000-0000-0000-000000000001') = 'KX14 HLD', 'vehicle untouched after failed approvals');
SELECT t_ok((SELECT count(*) FROM driver_vehicle_categories WHERE driver_id='d1d1d1d1-0000-0000-0000-000000000001') = 1, 'categories untouched after failed approvals');

\echo === atomic approval
SET ROLE authenticated;
SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests), 'approve', NULL, 'checked V5C',
   ARRAY['c0000000-0000-0000-0000-000000000004','c0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-000000000001']::uuid[],
   ARRAY['f0000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000003']::uuid[])->>'ok') = 'true', 'approve succeeds (order/duplicates in reviewed ids tolerated)');
SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests), 'reject', 'late')->>'code') = 'ALREADY_DECIDED', 'decided request is final');
RESET ROLE;
SELECT t_ok((SELECT make||' '||model||' '||year||' '||color||' '||license_plate||' '||approval_status FROM vehicles WHERE id='e1e1e1e1-0000-0000-0000-000000000001') = 'Toyota Prius 2023 Grey LM23 ABC approved', 'vehicle updated, stays approved');
SELECT t_ok((SELECT is_enabled FROM driver_vehicle_categories WHERE driver_id='d1d1d1d1-0000-0000-0000-000000000001' AND vehicle_type_id='f0000000-0000-0000-0000-000000000002') = false, 'Comfort disabled per recheck');
SELECT t_ok((SELECT is_enabled FROM driver_vehicle_categories WHERE driver_id='d1d1d1d1-0000-0000-0000-000000000001' AND vehicle_type_id='f0000000-0000-0000-0000-000000000003') = true, 'Pet-Friendly assigned per recheck');
SELECT t_ok(NOT EXISTS (SELECT 1 FROM driver_vehicle_categories WHERE driver_id='d1d1d1d1-0000-0000-0000-000000000001' AND vehicle_type_id='f0000000-0000-0000-0000-000000000001'), 'default category kept without a row');
SELECT t_ok((SELECT vehicle_edit_request_status FROM drivers WHERE id='d1d1d1d1-0000-0000-0000-000000000001') = 'approved', 'driver status approved');
SELECT t_ok((SELECT cardinality(reviewed_document_ids) FROM vehicle_change_requests) = 4, 'reviewed document ids recorded');
SELECT t_ok((SELECT count(*) FROM driver_inbox_messages WHERE type='vehicle_change') = 1, 'driver notified');
SELECT t_ok((SELECT count(*) FROM audit_logs WHERE event_type='vehicle_change_request_approved') = 1, 'approval audited');
DO $$ BEGIN
  UPDATE public.vehicle_change_requests SET status = 'pending';
  RAISE EXCEPTION 'FAIL: decided row reopened';
EXCEPTION WHEN object_not_in_prerequisite_state THEN RAISE NOTICE 'PASS: decided rows are final (guard trigger)';
END $$;

\echo === reject flow and cancel flow for D1
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-0000-0000-0000-000000000001', false);
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',2023,'White','LM23 ABC')->>'ok') = 'true', 'new pending after approval allowed');
SELECT set_config('request.jwt.claim.sub', 'a1a1a1a1-0000-0000-0000-000000000001', false);
SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests WHERE status='pending'), 'reject', 'Photo does not match colour', 'internal note')->>'ok') = 'true', 'reject succeeds');
SELECT set_config('request.jwt.claim.sub', '11111111-0000-0000-0000-000000000001', false);
SELECT t_ok((list_driver_vehicle_change_requests()->'requests'->0->>'rejection_reason') = 'Photo does not match colour', 'driver sees rejection reason');
SELECT t_ok(position('internal note' in list_driver_vehicle_change_requests()::text) = 0, 'internal admin note hidden from driver');
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',2023,'Silver','LM23 ABC')->>'ok') = 'true', 'resubmit after rejection allowed');
SELECT t_ok((cancel_driver_vehicle_change_request((list_driver_vehicle_change_requests()->'requests'->0->>'id')::uuid)->'request'->>'status') = 'cancelled', 'driver cancels pending');
SELECT t_ok((cancel_driver_vehicle_change_request((list_driver_vehicle_change_requests()->'requests'->0->>'id')::uuid)->>'code') = 'NOT_CANCELLABLE', 'cancel twice refused');
SELECT t_ok((cancel_driver_vehicle_change_request((list_driver_vehicle_change_requests()->'requests'->1->>'id')::uuid)->>'code') = 'NOT_CANCELLABLE', 'rejected request cannot be cancelled');
RESET ROLE;
SELECT t_ok((SELECT color FROM vehicles WHERE id='e1e1e1e1-0000-0000-0000-000000000001') = 'Grey', 'rejected and cancelled requests left vehicle unchanged');

\echo === stale request: vehicle changed by admin after submission
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-0000-0000-0000-000000000001', false);
SELECT t_ok((submit_driver_vehicle_change_request('Toyota','Prius',2023,'Black','LM23 ABC')->>'ok') = 'true', 'submit again');
SELECT set_config('request.jwt.claim.sub', 'a1a1a1a1-0000-0000-0000-000000000001', false);
UPDATE vehicles SET color = 'Green' WHERE id='e1e1e1e1-0000-0000-0000-000000000001';
SELECT t_ok((admin_decide_vehicle_change_request((SELECT id FROM vehicle_change_requests WHERE status='pending'), 'approve', NULL, NULL,
   ARRAY['c0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-000000000004']::uuid[],
   ARRAY['f0000000-0000-0000-0000-000000000001']::uuid[])->>'code') = 'VEHICLE_CHANGED_SINCE_REQUEST', 'stale request cannot overwrite newer vehicle data');
RESET ROLE;

\echo ALL_VEHICLE_CHANGE_TESTS_PASSED
