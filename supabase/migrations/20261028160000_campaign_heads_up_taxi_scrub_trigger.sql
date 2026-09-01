-- Hard lock: never persist taxi branding in Campaign / Celebration copy.
-- App/Admin/FCM already scrub; this covers direct SQL and any future write path.

CREATE OR REPLACE FUNCTION public.scrub_campaign_heads_up_taxi_branding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.title := replace(coalesce(NEW.title, ''), '🚖', '✨');
  NEW.subtitle := replace(coalesce(NEW.subtitle, ''), '🚖', '✨');
  IF NEW.emoji IS NOT NULL THEN
    NEW.emoji := nullif(replace(NEW.emoji, '🚖', '✨'), '');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_scrub_campaign_heads_up_templates_taxi
  ON public.campaign_heads_up_templates;
CREATE TRIGGER trg_scrub_campaign_heads_up_templates_taxi
  BEFORE INSERT OR UPDATE OF title, subtitle, emoji
  ON public.campaign_heads_up_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.scrub_campaign_heads_up_taxi_branding();

DROP TRIGGER IF EXISTS trg_scrub_campaign_heads_up_campaigns_taxi
  ON public.campaign_heads_up_campaigns;
CREATE TRIGGER trg_scrub_campaign_heads_up_campaigns_taxi
  BEFORE INSERT OR UPDATE OF title, subtitle, emoji
  ON public.campaign_heads_up_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION public.scrub_campaign_heads_up_taxi_branding();
