-- Rollback for 20261214120000_driver_vehicle_change_request_flow.sql.
-- Restores the pre-migration table policies and grants. The added columns are
-- kept (dropping them would lose request history); every new function, trigger,
-- constraint and index is removed. Run manually only after approval.

BEGIN;

DROP FUNCTION IF EXISTS public.admin_decide_vehicle_change_request(uuid, text, text, text, uuid[], uuid[]);
DROP FUNCTION IF EXISTS public.admin_get_vehicle_change_review(uuid);
DROP FUNCTION IF EXISTS public.list_driver_vehicle_change_requests(integer);
DROP FUNCTION IF EXISTS public.cancel_driver_vehicle_change_request(uuid);
DROP FUNCTION IF EXISTS public.submit_driver_vehicle_change_request(text, text, integer, text, text, uuid);
DROP FUNCTION IF EXISTS public.vehicle_change_applicable_documents(uuid);
DROP FUNCTION IF EXISTS public.driver_effective_vehicle_categories(uuid);
DROP FUNCTION IF EXISTS public.vehicle_change_request_json(public.vehicle_change_requests);
DROP FUNCTION IF EXISTS public.vehicle_licence_plate_key(text);
DROP FUNCTION IF EXISTS public.normalize_vehicle_licence_plate(text);
DROP FUNCTION IF EXISTS public.vehicle_change_document_slugs();

DROP TRIGGER IF EXISTS vehicle_change_requests_guard ON public.vehicle_change_requests;
DROP FUNCTION IF EXISTS public.vehicle_change_requests_guard();

DROP INDEX IF EXISTS public.vehicle_change_requests_one_pending_per_driver;
DROP INDEX IF EXISTS public.vehicle_change_requests_driver_idempotency;
DROP INDEX IF EXISTS public.idx_vehicle_change_requests_driver_created;

ALTER TABLE public.vehicle_change_requests
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_status_check,
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_requested_year_check,
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_rejection_reason_check,
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_decision_check,
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_cancelled_check;

CREATE POLICY "Drivers can create change requests for their vehicles"
  ON public.vehicle_change_requests FOR INSERT
  WITH CHECK (driver_id IN (SELECT drivers.id FROM drivers WHERE drivers.user_id = auth.uid()));
CREATE POLICY "Drivers can view their own change requests"
  ON public.vehicle_change_requests FOR SELECT
  USING (driver_id IN (SELECT drivers.id FROM drivers WHERE drivers.user_id = auth.uid()));

GRANT ALL ON public.vehicle_change_requests TO anon, authenticated;

COMMIT;
