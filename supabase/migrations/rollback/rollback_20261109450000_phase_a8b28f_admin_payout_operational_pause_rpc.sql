-- ============================================================
-- ROLLBACK — A8B28F Stage B1 Admin operational-pause RPC
-- rollback_20261109450000_phase_a8b28f_admin_payout_operational_pause_rpc.sql
--
-- Drops the Admin RPC only. Does NOT drop Stage A column/helpers.
-- Does NOT restore any driver pause flags.
-- After rollback, Admin UI must use legacy direct payouts_enabled writes
-- (old bundle) or refuse pause until RPC is re-applied.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.admin_set_driver_payout_operational_pause(uuid, boolean, text);

COMMIT;
