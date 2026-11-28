-- Local E2E defect: Document Review hydrates vehicle_id via
-- admin_page_select('documents','vehicles',…) but _admin_page_table_allowed
-- only permitted vehicles|drivers|commission-wallet → whole list query failed
-- closed (empty UI). Also ensure upload audit columns exist when earlier
-- 20270226* migrations were not part of the local baseline.
-- Do not apply to hosted/production until authenticated non-prod E2E.
-- Lifecycle contracts remain verified:false.

-- ---------------------------------------------------------------------------
-- 1. Audit columns (idempotent — match 20270226120000)
-- ---------------------------------------------------------------------------
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS upload_source text,
  ADD COLUMN IF NOT EXISTS uploaded_by uuid,
  ADD COLUMN IF NOT EXISTS admin_staff_id uuid,
  ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_upload_source_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_upload_source_check
      CHECK (upload_source IS NULL OR upload_source IN ('admin', 'driver'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_admin_staff_id
  ON public.documents (admin_staff_id)
  WHERE admin_staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_upload_source
  ON public.documents (upload_source)
  WHERE upload_source IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Allow Document Review (+ document-management) to SELECT vehicles
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._admin_page_table_allowed(p_page_slug text, p_table text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE lower(p_table)
    WHEN 'trips' THEN lower(p_page_slug) = ANY (ARRAY[
      'dashboard','active-trips','trip-history','missed-cancelled','scheduled-rides',
      'manual-trip','fleet-tracking','dispatch','corporate-billing','corporate-reports',
      'rider-feedback','lost-property','payment-sessions','financial-reconciliation','riders',
      'service-area-pricing','driver-wallet-ledger','payout-ledger','commission-wallet','disputes'
    ])
    WHEN 'drivers' THEN lower(p_page_slug) = ANY (ARRAY[
      'drivers','fleet-tracking','active-trips','scheduled-rides','manual-trip','dashboard',
      'documents','document-management','services','regions','invoices','statement-runs',
      'annual-taxi-report','disputes','rider-feedback','lost-property','payout-ledger',
      'driver-wallet-ledger','live-chat','tickets','commission-wallet','vehicles',
      'service-area-pricing','dispatch','corporate-billing','corporate-reports','trip-history',
      'missed-cancelled'
    ])
    WHEN 'customers' THEN lower(p_page_slug) = ANY (ARRAY[
      'riders','pending-customer-signups','suspensions','live-chat','tickets','manual-trip',
      'rider-feedback','lost-property','dashboard','customer-receivables','trip-history',
      'active-trips','missed-cancelled','scheduled-rides','payment-sessions','dispatch',
      'service-area-pricing'
    ])
    WHEN 'documents' THEN lower(p_page_slug) = ANY (ARRAY[
      'documents','document-management','drivers'
    ])
    -- Document Review lists vehicle-scoped docs and hydrates make/plate/status.
    WHEN 'vehicles' THEN lower(p_page_slug) = ANY (ARRAY[
      'vehicles','drivers','commission-wallet','documents','document-management'
    ])
    WHEN 'driver_service_areas' THEN lower(p_page_slug) = ANY (ARRAY[
      'drivers','services','fleet-tracking','statement-runs','payout-ledger','commission-wallet'
    ])
    WHEN 'fare_pricing_settings' THEN lower(p_page_slug) = ANY (ARRAY[
      'service-area-pricing','fare-simulator','services'
    ])
    WHEN 'corporate_fare_rules' THEN lower(p_page_slug) = 'corporate-fares'
    WHEN 'document_types' THEN lower(p_page_slug) = ANY (ARRAY[
      'document-management','drivers','documents'
    ])
    WHEN 'service_area_document_rules' THEN lower(p_page_slug) = ANY (ARRAY[
      'document-management','drivers','documents'
    ])
    WHEN 'stop_waiting_settings' THEN lower(p_page_slug) = 'service-area-pricing'
    WHEN 'dispatch_settings' THEN lower(p_page_slug) = ANY (ARRAY[
      'service-area-pricing','auto-dispatch'
    ])
    WHEN 'service_area_cancellation_fees' THEN lower(p_page_slug) = ANY (ARRAY[
      'services','service-area-pricing'
    ])
    WHEN 'service_area_vehicle_pricing' THEN lower(p_page_slug) = ANY (ARRAY[
      'services','service-area-pricing','fare-simulator','manual-trip'
    ])
    ELSE false
  END;
$fn$;

COMMENT ON FUNCTION public._admin_page_table_allowed(text, text) IS
  'Page→table allowlist for admin_page_select/mutate. vehicles readable from documents/document-management for vehicle-scoped document review.';
