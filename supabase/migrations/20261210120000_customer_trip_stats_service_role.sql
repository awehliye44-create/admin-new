-- Order 3: the Driver new-ride offer card shows the customer's real rating.
-- auto-dispatch (service_role) stamps passenger_rating / passenger_rating_count
-- into ride_offers.offer_snapshot from the existing SSOT get_customer_trip_stats.
-- Grant is service_role only: drivers/customers still cannot call it directly,
-- and no identity (name/phone) is exposed — only the aggregate.

GRANT EXECUTE ON FUNCTION public.get_customer_trip_stats(uuid) TO service_role;
