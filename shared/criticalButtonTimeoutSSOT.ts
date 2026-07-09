/**
 * P0 — Critical button timeout SSOT (customer, driver, admin).
 *
 * Hard rule: no spinner/loading label may run beyond 3 seconds.
 * After timeout: stop loading, verify backend, show safe message + retry.
 */

/** Max spinner / loading label duration for any critical button. */
export const CRITICAL_BUTTON_MAX_SPINNER_MS = 3_000;

/** Target: visual tap feedback (ripple / pressed state). */
export const CRITICAL_BUTTON_VISUAL_FEEDBACK_MS = 100;

/** Target: normal backend actions (list, save, refresh). */
export const CRITICAL_BUTTON_NORMAL_BACKEND_MS = 1_500;

/** Target: payment / dispatch actions (p95 goal — spinner still capped at 3s). */
export const CRITICAL_BUTTON_PAYMENT_DISPATCH_MS = 3_000;

export const CRITICAL_BUTTON_TIMEOUT_MESSAGE =
  "This is taking longer than expected. Please try again.";

export const CRITICAL_BUTTON_TIMEOUT_LOG_EVENT = "CRITICAL_BUTTON_TIMEOUT";

export type CriticalButtonAction =
  | "customer_book_pay"
  | "customer_add_card"
  | "customer_select_payment"
  | "customer_cancel_booking"
  | "driver_accept"
  | "driver_decline"
  | "driver_arrive"
  | "driver_start"
  | "driver_drive_next"
  | "driver_complete"
  | "driver_save_payout"
  | "driver_go_online"
  | "admin_save_provider"
  | "admin_refresh_finance"
  | "admin_pay_driver"
  | "admin_run_payouts"
  | "admin_assign_trip"
  | "admin_cancel_trip";

/** Loading labels that must never spin past CRITICAL_BUTTON_MAX_SPINNER_MS. */
export const FORBIDDEN_INFINITE_SPINNER_LABELS = [
  "Preparing",
  "Opening",
  "Accepting",
  "Finding",
  "Saving",
  "Confirming",
  "Creating",
] as const;
