-- Close remaining taxi-branding gaps in Campaign / Celebration copy:
-- prior sweep (20261028140000) missed subtitle and only exact-match emoji.
-- Runtime + Admin already scrub via scrubCampaignTaxiBranding; this keeps DB clean.

UPDATE public.campaign_heads_up_templates
SET
  title = replace(title, '🚖', '✨'),
  subtitle = replace(subtitle, '🚖', '✨'),
  emoji = replace(coalesce(emoji, ''), '🚖', '✨'),
  updated_at = now()
WHERE title LIKE '%🚖%'
   OR subtitle LIKE '%🚖%'
   OR coalesce(emoji, '') LIKE '%🚖%';

UPDATE public.campaign_heads_up_campaigns
SET
  title = replace(title, '🚖', '✨'),
  subtitle = replace(subtitle, '🚖', '✨'),
  emoji = replace(coalesce(emoji, ''), '🚖', '✨'),
  updated_at = now()
WHERE title LIKE '%🚖%'
   OR subtitle LIKE '%🚖%'
   OR coalesce(emoji, '') LIKE '%🚖%';
