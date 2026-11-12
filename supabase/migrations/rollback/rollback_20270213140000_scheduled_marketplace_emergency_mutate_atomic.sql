-- Rollback atomic emergency mutate RPC only. Preserves Phase 1/2 and prior Phase 3 migrations.

BEGIN;
DROP FUNCTION IF EXISTS public.admin_scheduled_emergency_mutate(text, uuid, uuid, text, jsonb, jsonb);
COMMIT;
