-- Replace taxi-emoji branding in Campaign / Celebration heads-up copy.
-- Left-side identity is the unified ONE/CAB brand mark on apps + Admin preview;
-- templates must not use 🚖 as the mark or title accent.

UPDATE public.campaign_heads_up_templates
SET
  title = replace(title, '🚖', '✨'),
  emoji = CASE WHEN emoji = '🚖' THEN '✨' ELSE emoji END,
  updated_at = now()
WHERE title LIKE '%🚖%' OR emoji = '🚖';

UPDATE public.campaign_heads_up_campaigns
SET
  title = replace(title, '🚖', '✨'),
  emoji = CASE WHEN emoji = '🚖' THEN '✨' ELSE emoji END,
  updated_at = now()
WHERE title LIKE '%🚖%' OR emoji = '🚖';
