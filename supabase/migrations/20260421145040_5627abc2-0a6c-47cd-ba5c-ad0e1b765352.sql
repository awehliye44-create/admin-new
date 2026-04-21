WITH completed_counts AS (
  SELECT driver_id, COUNT(*)::int AS completed
  FROM public.trips
  WHERE status = 'completed' AND driver_id IS NOT NULL
  GROUP BY driver_id
),
active_tiers AS (
  SELECT id, name, level_order, trip_target
  FROM public.driver_categories
  WHERE is_active = true
),
tier_thresholds AS (
  SELECT
    id,
    name,
    level_order,
    COALESCE(LAG(trip_target) OVER (ORDER BY level_order), 0) AS entry_threshold
  FROM active_tiers
),
driver_targets AS (
  SELECT
    d.id           AS driver_id,
    d.category_id  AS current_tier_id,
    cur.level_order AS current_level,
    (
      SELECT tt.id FROM tier_thresholds tt
      WHERE tt.entry_threshold <= COALESCE(cc.completed, 0)
      ORDER BY tt.level_order DESC
      LIMIT 1
    ) AS target_tier_id,
    (
      SELECT tt.level_order FROM tier_thresholds tt
      WHERE tt.entry_threshold <= COALESCE(cc.completed, 0)
      ORDER BY tt.level_order DESC
      LIMIT 1
    ) AS target_level
  FROM public.drivers d
  LEFT JOIN completed_counts cc ON cc.driver_id = d.id
  LEFT JOIN public.driver_categories cur ON cur.id = d.category_id
)
UPDATE public.drivers d
SET category_id = dt.target_tier_id
FROM driver_targets dt
WHERE d.id = dt.driver_id
  AND dt.target_tier_id IS NOT NULL
  AND dt.target_level > COALESCE(dt.current_level, 0);
