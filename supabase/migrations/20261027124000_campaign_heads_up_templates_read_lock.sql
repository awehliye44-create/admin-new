-- Campaign templates were still SELECT-open to every authenticated user via the
-- original "Staff read campaign templates" USING(true) policy. Manage was
-- tightened earlier; tighten read to match admin/staff.

DROP POLICY IF EXISTS "Staff read campaign templates" ON public.campaign_heads_up_templates;
CREATE POLICY "Admin or staff read campaign templates"
  ON public.campaign_heads_up_templates
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.staff_profiles sp
      WHERE sp.user_id = auth.uid() AND sp.is_active = true
    )
  );
