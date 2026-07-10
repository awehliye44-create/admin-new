/**
 * Admin Payment Sessions (SSOT) — provider-neutral list contract.
 * Single edge: admin-payment-sessions. UI must not merge APIs client-side.
 */

import type { PaymentSessionActionPolicy, PaymentSessionPurpose } from "./paymentSessionPhase1SSOT.ts";
import type { PaymentHoldAttentionClass, PaymentHoldClassification } from "./paymentHoldReconciliation.ts";

export const ADMIN_PAYMENT_SESSIONS_FN = "admin-payment-sessions";

export type AdminPaymentSessionsTab =
  | "overview"
  | "active_holds"
  | "captured"
  | "released"
  | "refunded"
  | "failed_recovery"
  | "history";

export type AdminPaymentSessionsPageStatus =
  | "LIVE"
  | "PARTIAL"
  | "DEGRADED"
  | "READ_ONLY"
  | "PROVIDER_UNAVAILABLE";

export type AdminPaymentSessionsListRequest = {
  tab?: AdminPaymentSessionsTab;
  refresh_provider_state?: boolean;
  service_area_id?: string | null;
  provider?: string | null;
  payment_method?: string | null;
  purpose?: PaymentSessionPurpose | null;
  session_status?: string | null;
  provider_state?: string | null;
  has_trip?: boolean | null;
  active_hold?: boolean | null;
  release_failed?: boolean | null;
  recovery_pending?: boolean | null;
  legacy_evidence?: boolean | null;
  date_from?: string | null;
  date_to?: string | null;
  limit?: number;
  payment_session_id?: string | null;
  provider_order_id?: string | null;
  trip_id?: string | null;
};

export type AdminPaymentSessionsListRow = {
  id: string;
  source: "payment_sessions" | "orphan_payments";
  payment_session_id: string | null;
  orphan_payment_id: string | null;
  client_action_id: string | null;
  created_at: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  trip_id: string | null;
  trip_code: string | null;
  trip_status: string | null;
  driver_id: string | null;
  service_area_id: string | null;
  service_area_name: string | null;
  payment_provider: string;
  payment_method: string | null;
  purpose: PaymentSessionPurpose | string | null;
  authorised_amount_pence: number | null;
  captured_amount_pence: number | null;
  released_amount_pence: number | null;
  refunded_amount_pence: number | null;
  provider_processing_fee_pence: number | null;
  fee_status: string | null;
  fee_display_label: string | null;
  fee_display_badge: "ACTUAL" | "ESTIMATED" | "PENDING" | "UNAVAILABLE" | null;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  provider_capture_id: string | null;
  provider_state: string | null;
  provider_state_label: string | null;
  provider_state_verified_at: string | null;
  provider_verification_status: "VERIFIED" | "STALE" | "UNKNOWN" | "UNAVAILABLE";
  session_status: string | null;
  session_status_display: string | null;
  session_status_label: string | null;
  technical_status: string | null;
  evidence_status: string | null;
  evidence_label: string | null;
  captured_at: string | null;
  released_at: string | null;
  refunded_at: string | null;
  evidence_warnings: string[];
  webhook_timeline: Array<{
    event_type: string;
    processed_at: string | null;
    applied_status: string | null;
  }>;
  admin_refresh_timeline: Array<{
    verified_at: string;
    verified_by: string;
    provider_state: string | null;
  }>;
  age_minutes: number;
  reconciliation_status: string | null;
  attention_class: PaymentHoldAttentionClass | null;
  classification: PaymentHoldClassification | null;
  in_active_queue: boolean;
  amount_display: "AMOUNT_UNCONFIRMED" | null;
  action_policy: PaymentSessionActionPolicy & {
    can_retry_release?: boolean;
    can_open_trip?: boolean;
    can_open_reconciliation?: boolean;
  };
  page_status_hint?: AdminPaymentSessionsPageStatus | null;
};

export type AdminPaymentSessionsListResponse = {
  success: boolean;
  page_status: AdminPaymentSessionsPageStatus;
  tab: AdminPaymentSessionsTab;
  rows: AdminPaymentSessionsListRow[];
  summary: {
    total: number;
    active_hold_count: number;
    active_hold_amount_pence: number | null;
    captured_count: number;
    released_count: number;
    refunded_count: number;
    failed_recovery_count: number;
    red: number;
    amber: number;
    green: number;
    unknown_count: number;
    money_at_risk_pence: number | null;
  };
  error?: string;
  provider_verification_message?: string | null;
};

export function paymentSessionsUrl(args?: {
  tab?: AdminPaymentSessionsTab;
  paymentSessionId?: string | null;
  providerOrderId?: string | null;
  tripId?: string | null;
}): string {
  const params = new URLSearchParams();
  if (args?.tab) params.set("tab", args.tab);
  if (args?.paymentSessionId) params.set("paymentSessionId", args.paymentSessionId);
  if (args?.providerOrderId) params.set("providerOrderId", args.providerOrderId);
  if (args?.tripId) params.set("tripId", args.tripId);
  const qs = params.toString();
  return qs ? `/payment-sessions?${qs}` : "/payment-sessions";
}
