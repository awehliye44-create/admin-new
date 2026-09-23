-- Rollback 20261127150000_customer_receivables_ssot
-- Drops RPCs, triggers, and tables introduced by the forward migration.
-- Do NOT apply unless rolling back an applied receivable SSOT migration.

BEGIN;

DROP FUNCTION IF EXISTS public.admin_list_customer_receivables(uuid, text, integer);
DROP FUNCTION IF EXISTS public.customer_list_my_receivables();
DROP FUNCTION IF EXISTS public.customer_receivable_settle_from_provider_capture(uuid, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.customer_receivable_release_reservations(uuid, text);
DROP FUNCTION IF EXISTS public.customer_receivable_reserve_for_preauth(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.customer_receivable_record_declined_increment(
  uuid, uuid, uuid, text, text, text, integer, text, text, jsonb
);

DROP TRIGGER IF EXISTS trg_require_guc_receivable_event_insert ON public.customer_receivable_events;
DROP TRIGGER IF EXISTS trg_require_guc_allocation_insert ON public.payment_session_receivable_allocations;
DROP TRIGGER IF EXISTS trg_require_guc_customer_receivable_insert ON public.customer_receivables;
DROP TRIGGER IF EXISTS trg_deny_receivable_allocation_delete ON public.payment_session_receivable_allocations;
DROP TRIGGER IF EXISTS trg_deny_receivable_allocation_update ON public.payment_session_receivable_allocations;
DROP TRIGGER IF EXISTS trg_deny_customer_receivable_event_delete ON public.customer_receivable_events;
DROP TRIGGER IF EXISTS trg_deny_customer_receivable_event_update ON public.customer_receivable_events;
DROP TRIGGER IF EXISTS trg_deny_customer_receivable_delete ON public.customer_receivables;
DROP TRIGGER IF EXISTS trg_deny_customer_receivable_update ON public.customer_receivables;

DROP FUNCTION IF EXISTS public.require_customer_receivable_write_guc();
DROP FUNCTION IF EXISTS public.deny_direct_receivable_allocation_mutation();
DROP FUNCTION IF EXISTS public.deny_customer_receivable_event_mutation();
DROP FUNCTION IF EXISTS public.deny_direct_customer_receivable_mutation();

DROP TABLE IF EXISTS public.payment_session_receivable_allocations;
DROP TABLE IF EXISTS public.customer_receivable_events;
DROP TABLE IF EXISTS public.customer_receivables;

COMMIT;
