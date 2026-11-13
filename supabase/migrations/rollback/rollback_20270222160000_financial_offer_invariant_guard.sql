-- Rollback for 20270222160000_financial_offer_invariant_guard.sql (drops the guard only).
DROP TRIGGER IF EXISTS zz_ride_offer_financial_invariant_guard ON public.ride_offers;
DROP FUNCTION IF EXISTS public.tr_ride_offer_financial_invariant_guard_fn();
