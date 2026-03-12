
-- Rename dispatch_weight to category_priority
ALTER TABLE public.driver_categories RENAME COLUMN dispatch_weight TO category_priority;

-- Update default values for existing tiers
UPDATE public.driver_categories SET category_priority = 10 WHERE LOWER(name) = 'bronze';
UPDATE public.driver_categories SET category_priority = 20 WHERE LOWER(name) = 'silver';
UPDATE public.driver_categories SET category_priority = 30 WHERE LOWER(name) = 'gold';
UPDATE public.driver_categories SET category_priority = 40 WHERE LOWER(name) = 'platinum';
UPDATE public.driver_categories SET category_priority = 50 WHERE LOWER(name) = 'diamond';

-- Update the dispatch_candidates_log to rename the column too
ALTER TABLE public.dispatch_candidates_log RENAME COLUMN dispatch_weight TO category_priority;
