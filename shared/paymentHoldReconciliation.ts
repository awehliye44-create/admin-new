/**
 * Admin Financial Reconciliation — payment holds requiring attention.
 */

export type PaymentHoldClassification = "GREEN" | "AMBER" | "RED";

export type PaymentHoldReconciliationRow = {
  id: string;
  payment_session_id: string;
  source: "payment_sessions" | "orphan_payments";
  payment_provider: string;
  provider_order_id: string;
  amount_pence: number;
  currency: string;
  created_at: string;
  authorised_at: string | null;
  released_at: string | null;
  captured_at: string | null;
  age_minutes: number;
  customer_user_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  trip_id: string | null;
  trip_code: string | null;
  trip_status: string | null;
  payment_hold_status: string | null;
  session_status: string | null;
  release_attempt_count: number;
  recovery_attempt_count: number;
  release_failure_reason: string | null;
  hold_terminal_reason: string | null;
  hold_release_state: string | null;
  provider_order_state: string | null;
  classification: PaymentHoldClassification;
  hold_classification:
    | "OK_ACTIVE_TRIP"
    | "OK_COMPLETED_CAPTURED"
    | "OK_CANCELLED_RELEASED"
    | "BLOCKED_HOLD_NO_TRIP"
    | "BLOCKED_CANCELLED_NOT_RELEASED"
    | "BLOCKED_EXPIRED_NOT_RELEASED"
    | "BLOCKED_RELEASE_FAILED"
    | "BLOCKED_UNKNOWN_STATE";
  can_release: boolean;
  can_retry_release: boolean;
  can_retry_recovery: boolean;
  can_open_trip: boolean;
};

export type AdminPaymentHoldsReconciliationResponse = {
  success: boolean;
  payment_holds_requiring_attention: PaymentHoldReconciliationRow[];
  summary: {
    total: number;
    green: number;
    amber: number;
    red: number;
    total_hold_pence: number;
  };
  error?: string;
};

export type AdminHoldActionRequest = {
  payment_session_id?: string;
  provider_order_id?: string;
  action: "release" | "retry_release" | "retry_recovery";
  dry_run?: boolean;
};

export const ADMIN_HOLD_ACTION_FN = "admin-hold-action";
export const ADMIN_PAYMENT_HOLDS_RECONCILIATION_FN = "admin-payment-holds-reconciliation";
