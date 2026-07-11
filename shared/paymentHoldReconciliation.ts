/**
 * Admin Financial Reconciliation — payment holds requiring attention.
 */

export type PaymentHoldClassification = "GREEN" | "AMBER" | "RED";

export type PaymentHoldAttentionClass =
  | "ACTIVE_AUTHORISED_HOLD"
  | "RECOVERY_PENDING"
  | "RELEASE_PENDING"
  | "RELEASE_FAILED"
  | "RESOLVED_PROVIDER_CANCELLED"
  | "RESOLVED_PROVIDER_REVERTED"
  | "RESOLVED_COMPANION_SESSION"
  | "CAPTURED"
  | "REFUNDED"
  | "LEGACY_EVIDENCE"
  | "UNKNOWN_PROVIDER_STATE"
  | "OK_ACTIVE_TRIP";

export type PaymentHoldReconciliationRow = {
  id: string;
  payment_session_id: string;
  source: "payment_sessions" | "orphan_payments";
  payment_provider: string;
  provider_order_id: string;
  amount_pence: number | null;
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
  driver_id?: string | null;
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
  attention_class?: PaymentHoldAttentionClass;
  in_active_queue?: boolean;
  can_release: boolean;
  can_retry_release: boolean;
  can_retry_recovery: boolean;
  can_refund?: boolean;
  can_open_trip: boolean;
  released_amount_pence?: number | null;
  amount_display?: "AMOUNT_UNCONFIRMED" | null;
  resolution_source?: string | null;
  provider_state_verified_at?: string | null;
  orphan_evidence_id?: string | null;
};

export type AdminPaymentHoldsReconciliationResponse = {
  success: boolean;
  payment_holds_requiring_attention: PaymentHoldReconciliationRow[];
  payment_holds_history?: PaymentHoldReconciliationRow[];
  summary: {
    total: number;
    green: number;
    amber: number;
    red: number;
    resolved?: number;
    total_hold_pence: number;
    active_hold_count?: number;
    active_hold_amount_pence?: number;
    resolved_count?: number;
    resolved_amount_pence?: number;
    unknown_count?: number;
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
