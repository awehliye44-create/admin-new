-- P0: Lock down weekly_payout_occurrence_runs — financial occurrence metadata must not be public.
-- Access path: service_role + SECURITY DEFINER claim/finish RPCs only (Edge orchestrator).

BEGIN;

ALTER TABLE public.weekly_payout_occurrence_runs ENABLE ROW LEVEL SECURITY;

-- No client policies: deny-by-default under RLS. service_role bypasses RLS in Supabase.
DROP POLICY IF EXISTS weekly_payout_occurrence_runs_service_role_all
  ON public.weekly_payout_occurrence_runs;
CREATE POLICY weekly_payout_occurrence_runs_service_role_all
  ON public.weekly_payout_occurrence_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.weekly_payout_occurrence_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.weekly_payout_occurrence_runs FROM anon;
REVOKE ALL ON TABLE public.weekly_payout_occurrence_runs FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_payout_occurrence_runs TO service_role;

-- Recreated claim() in dry-run migration re-granted EXECUTE via PUBLIC defaults; lock both RPCs.
REVOKE ALL ON FUNCTION public.claim_weekly_payout_occurrence(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_weekly_payout_occurrence(TEXT, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.claim_weekly_payout_occurrence(TEXT, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_weekly_payout_occurrence(TEXT, BOOLEAN) TO service_role;

REVOKE ALL ON FUNCTION public.finish_weekly_payout_occurrence(UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, TEXT, BOOLEAN, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_weekly_payout_occurrence(UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, TEXT, BOOLEAN, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.finish_weekly_payout_occurrence(UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, TEXT, BOOLEAN, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finish_weekly_payout_occurrence(UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, TEXT, BOOLEAN, JSONB) TO service_role;

COMMENT ON TABLE public.weekly_payout_occurrence_runs IS
  'Atomic claim/reconcile for weekly payout orchestrator. RLS on; no anon/authenticated direct access; service_role + claim/finish RPCs only.';

COMMIT;
