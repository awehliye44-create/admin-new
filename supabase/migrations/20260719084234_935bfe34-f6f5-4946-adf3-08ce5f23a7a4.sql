ALTER TABLE public.weekly_payout_occurrence_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.weekly_payout_occurrence_runs FROM anon;
GRANT SELECT ON public.weekly_payout_occurrence_runs TO authenticated;
GRANT ALL ON public.weekly_payout_occurrence_runs TO service_role;

DROP POLICY IF EXISTS "weekly_payout_occurrence_runs_admin_read" ON public.weekly_payout_occurrence_runs;
CREATE POLICY "weekly_payout_occurrence_runs_admin_read"
  ON public.weekly_payout_occurrence_runs
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "weekly_payout_occurrence_runs_service_role_all" ON public.weekly_payout_occurrence_runs;
CREATE POLICY "weekly_payout_occurrence_runs_service_role_all"
  ON public.weekly_payout_occurrence_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);