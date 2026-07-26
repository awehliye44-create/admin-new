-- SQL smoke tests for towards destination allowance + priority bonus.
-- Run after migrations with a service-role / linked session.
-- Not executed automatically by CI in this repo.

-- Bonus: compatible within 3km
SELECT public.towards_destination_priority_bonus(
  52.04, -0.76, 52.041, -0.761,
  true, NULL, true, 3000, 12
) AS compatible_bonus; -- expect 12

-- Bonus: far dropoff
SELECT public.towards_destination_priority_bonus(
  52.04, -0.76, 53.5, -1.5,
  true, NULL, true, 3000, 12
) AS far_bonus; -- expect 0

-- Bonus: expired
SELECT public.towards_destination_priority_bonus(
  52.04, -0.76, 52.041, -0.761,
  true, now() - interval '1 minute', true, 3000, 12
) AS expired_bonus; -- expect 0

-- Bonus: disabled
SELECT public.towards_destination_priority_bonus(
  52.04, -0.76, 52.041, -0.761,
  true, NULL, false, 3000, 12
) AS disabled_bonus; -- expect 0

-- Config resolve
SELECT public.towards_destination_resolve_config(NULL) AS global_cfg;
