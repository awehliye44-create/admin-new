-- Already applied in production on 2026-10-09 outside the repo (schema_migrations
-- name 3f070f2e-5355-483f-9063-e936a0dff5ee). Tracked here so the repo matches
-- production; the body is the recorded statement verbatim.

REVOKE ALL ON public.corporate_policies FROM anon;
REVOKE ALL ON public.corporate_policies FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.corporate_policies TO authenticated;
GRANT ALL ON public.corporate_policies TO service_role;
CREATE POLICY "Company admins can add policies" ON public.corporate_policies FOR INSERT TO authenticated WITH CHECK (public.can_write_corporate(auth.uid(), corporate_account_id));
CREATE POLICY "Company admins can edit policies" ON public.corporate_policies FOR UPDATE TO authenticated USING (public.can_write_corporate(auth.uid(), corporate_account_id)) WITH CHECK (public.can_write_corporate(auth.uid(), corporate_account_id));
CREATE POLICY "Company admins can delete policies" ON public.corporate_policies FOR DELETE TO authenticated USING (public.can_write_corporate(auth.uid(), corporate_account_id));
