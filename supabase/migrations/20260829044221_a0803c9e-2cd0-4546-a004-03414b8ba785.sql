ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS platform_promotion_subsidy_pence integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.trips.platform_promotion_subsidy_pence IS
  'Platform-funded customer promotion subsidy (marketing cost). Reconciliation identity: captured = driver_net + commission + airport + tip - platform_promotion_subsidy_pence. Never reduces driver earnings or commission.';

CREATE OR REPLACE FUNCTION public.stamp_platform_promotion_subsidy()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_locked integer := 0;
  v_gap integer := 0;
BEGIN
  -- Commission Wallet (driver-collected) trips never carry a platform subsidy leg.
  IF COALESCE(NEW.financial_model, 'PLATFORM_COLLECTED') <> 'PLATFORM_COLLECTED' THEN
    NEW.platform_promotion_subsidy_pence := 0;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.discount_source, '') <> 'global_offer' THEN
    NEW.platform_promotion_subsidy_pence := 0;
    RETURN NEW;
  END IF;

  v_locked := GREATEST(0, COALESCE(NEW.offer_discount_pence, 0));
  IF v_locked = 0 OR NEW.driver_net_pence IS NULL OR NEW.commission_pence IS NULL THEN
    NEW.platform_promotion_subsidy_pence := 0;
    RETURN NEW;
  END IF;

  -- Subsidy exists only when settlement stamped driver+commission on the PRE-promotion fare.
  v_gap := COALESCE(NEW.driver_net_pence, 0)
         + COALESCE(NEW.commission_pence, 0)
         - GREATEST(0, COALESCE(NEW.final_fare_pence, 0));

  NEW.platform_promotion_subsidy_pence := GREATEST(0, LEAST(v_locked, v_gap));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_platform_promotion_subsidy ON public.trips;
CREATE TRIGGER trg_stamp_platform_promotion_subsidy
  BEFORE INSERT OR UPDATE OF driver_net_pence, commission_pence, final_fare_pence,
    offer_discount_pence, discount_source, financial_model
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_platform_promotion_subsidy();

-- Backfill historical promoted PLATFORM_COLLECTED trips (no money mutation).
UPDATE public.trips t
SET platform_promotion_subsidy_pence = GREATEST(
      0,
      LEAST(
        GREATEST(0, COALESCE(t.offer_discount_pence, 0)),
        COALESCE(t.driver_net_pence, 0)
          + COALESCE(t.commission_pence, 0)
          - GREATEST(0, COALESCE(t.final_fare_pence, 0))
      )
    )
WHERE COALESCE(t.financial_model, 'PLATFORM_COLLECTED') = 'PLATFORM_COLLECTED'
  AND t.discount_source = 'global_offer'
  AND COALESCE(t.offer_discount_pence, 0) > 0
  AND t.driver_net_pence IS NOT NULL
  AND t.commission_pence IS NOT NULL;

-- Trips whose final_fare already equals the post-promo capture but whose settlement
-- base was pre-promo (commissionable_fare_pence > final_fare) also carry the subsidy.
UPDATE public.trips t
SET platform_promotion_subsidy_pence = GREATEST(
      0,
      LEAST(
        GREATEST(0, COALESCE(t.offer_discount_pence, 0)),
        COALESCE(t.driver_net_pence, 0)
          + COALESCE(t.commission_pence, 0)
          - GREATEST(0, COALESCE(t.capture_amount_pence, 0))
      )
    )
WHERE COALESCE(t.financial_model, 'PLATFORM_COLLECTED') = 'PLATFORM_COLLECTED'
  AND t.discount_source = 'global_offer'
  AND COALESCE(t.offer_discount_pence, 0) > 0
  AND t.driver_net_pence IS NOT NULL
  AND t.commission_pence IS NOT NULL
  AND COALESCE(t.platform_promotion_subsidy_pence, 0) = 0
  AND COALESCE(t.capture_amount_pence, 0) > 0
  AND COALESCE(t.driver_net_pence, 0) + COALESCE(t.commission_pence, 0) > COALESCE(t.capture_amount_pence, 0);