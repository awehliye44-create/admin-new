-- Rollback atomic capture-composition acquire RPC.
-- Safe when no Edge has been deployed that depends on this RPC.
-- After live Edges call this RPC: roll Edge back first, then drop function.

DROP FUNCTION IF EXISTS public.payment_session_acquire_capture_composition(
  uuid, text, integer, integer, integer, integer, text, text
);
