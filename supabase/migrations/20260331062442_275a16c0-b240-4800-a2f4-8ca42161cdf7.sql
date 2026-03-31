
-- Drop ALL conflicting functions first
DROP FUNCTION IF EXISTS public.ops_detect_payment_gaps();
DROP FUNCTION IF EXISTS public.ops_detect_commission_gaps();
DROP FUNCTION IF EXISTS public.ops_detect_earning_gaps();
DROP FUNCTION IF EXISTS public.ops_detect_payout_failures();
DROP FUNCTION IF EXISTS public.ops_detect_stuck_dispatch();
DROP FUNCTION IF EXISTS public.ops_detect_guest_booking_failures();
DROP FUNCTION IF EXISTS public.ops_detect_log_anomalies();
DROP FUNCTION IF EXISTS public.ops_detect_duplicate_payments();
DROP FUNCTION IF EXISTS public.ops_detect_duplicate_bookings();
DROP FUNCTION IF EXISTS public.ops_detect_duplicate_payouts();
DROP FUNCTION IF EXISTS public.ops_detect_duplicate_dispatch();
