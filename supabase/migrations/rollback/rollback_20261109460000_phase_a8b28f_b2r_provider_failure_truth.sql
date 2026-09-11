-- A8B28F-B2R Stage 1 rollback — restore prior audit CHECK; drop additive columns.
-- Do not re-tighten changed_by_user_id NOT NULL unless no NULL actors exist.

ALTER TABLE public.driver_payout_destination_audit
  DROP CONSTRAINT IF EXISTS driver_payout_destination_audit_action_check;

ALTER TABLE public.driver_payout_destination_audit
  ADD CONSTRAINT driver_payout_destination_audit_action_check
  CHECK (action = ANY (ARRAY[
    'created'::text,
    'updated'::text,
    'deactivated'::text,
    'provider_link_blocked'::text,
    'provider_link_synced'::text,
    'reject'::text,
    'disable'::text
  ]));

ALTER TABLE public.driver_payout_destinations
  DROP COLUMN IF EXISTS provider_http_status,
  DROP COLUMN IF EXISTS provider_link_failure_class;
