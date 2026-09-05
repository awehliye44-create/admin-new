-- Align live location_search_rollout with Customer nearby autocomplete SSOT.
-- Short local queries (e.g. "mk", "st", "bp") must reach Google Places, not
-- silently return empty results that the app mislabels as "No matching places".

UPDATE public.location_search_rollout
SET
  min_query_length = 2,
  updated_at = now()
WHERE id = true
  AND min_query_length <> 2;

ALTER TABLE public.location_search_rollout
  ALTER COLUMN min_query_length SET DEFAULT 2;

COMMENT ON COLUMN public.location_search_rollout.min_query_length IS
  'Minimum characters before search-onecab-locations calls Google. SSOT = 2 (Customer + Admin).';
