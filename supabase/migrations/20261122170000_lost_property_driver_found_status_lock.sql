-- Lost Property: allow driver-found OPEN/CANCELLED statuses used by
-- cancel_driver_own_lost_property_report + driver_lost_property_display_status.
-- Also allow chat_lock_reason set by driver cancel.

ALTER TABLE public.lost_property_cases
  DROP CONSTRAINT IF EXISTS lost_property_cases_status_check;

ALTER TABLE public.lost_property_cases
  ADD CONSTRAINT lost_property_cases_status_check CHECK (status IN (
    'NEW',
    'OPEN',
    'SENT_TO_DRIVER',
    'DRIVER_CONFIRMED_FOUND',
    'DRIVER_NOT_FOUND',
    'AWAITING_CUSTOMER_CONFIRMATION',
    'AWAITING_RETURN_METHOD',
    'AWAITING_COLLECTION',
    'RETURN_RIDE_REQUESTED',
    'RETURN_RIDE_BOOKED',
    'RETURN_RIDE_DECLINED',
    'COLLECTED',
    'ESCALATED',
    'CLOSED',
    'CANCELLED',
    'sent_to_driver',
    'driver_confirmed',
    'driver_not_found',
    'awaiting_collection',
    'return_ride_booked',
    'closed',
    'cancelled',
    'open'
  ));

ALTER TABLE public.lost_property_cases
  DROP CONSTRAINT IF EXISTS valid_chat_lock_reason;

ALTER TABLE public.lost_property_cases
  ADD CONSTRAINT valid_chat_lock_reason CHECK (
    chat_lock_reason IS NULL OR chat_lock_reason IN (
      'ADMIN_CLOSED_CASE',
      'ADMIN_LOCKED_CHAT',
      'CHAT_EXPIRED',
      'CASE_CLOSED',
      'driver_cancelled'
    )
  );
