/**
 * Admin Payment Sessions (SSOT) — provider-neutral list contract.
 * Single edge: admin-payment-sessions. UI must not merge APIs client-side.
 */

import type { PaymentSessionActionPolicy, PaymentSessionPurpose } from "./paymentSessionPhase1SSOT.ts";
import type { PaymentHoldAttentionClass, PaymentHoldClassification } from "./paymentHoldReconciliation.ts";
import type { PaymentTripMatchStatus } from "./paymentSessionsTripMatchSSOT.ts";
import {
  paymentSessionsNavUrl,
  resolveLegacyPaymentSessionsTabMapping,
  type PaymentSessionsNavTab,
} from "./paymentSessionsNavigationSSOT.ts";

export const ADMIN_PAYMENT_SESSIONS_FN = "admin-payment-sessions";

export type AdminPaymentSessionsTab =
  | "overview"
  | "active_holds"
  | "captured"
  | "released"
  | "refunded"
  | "failed_recovery"
  | "history"
  | "provider_payments"
  | "completed_trips_paid"
  | "payment_matching";

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
  /** Financial-model scope (PLATFORM_COLLECTED service areas only). Backend-set, never client-set. */
  allowed_service_area_ids?: string[] | null;
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
  /** Widget drill: fee_status PENDING / PENDING_PROVIDER_FEE evidence. */
  provider_fees_pending?: boolean | null;
  /** Widget drill: capture failed / capture evidence missing without confirmed amount. */
  capture_failed?: boolean | null;
  /** Widget drill: active holds that are not GREEN (Money At Risk). */
  money_at_risk?: boolean | null;
  /** Widget drill: payment matching status filter. */
  match_status?: PaymentTripMatchStatus | null;
  customer_id?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  limit?: number;
  /** History pagination offset (0-based into filtered tab rows). */
  offset?: number;
  payment_session_id?: string | null;
  provider_order_id?: string | null;
  trip_id?: string | null;
  /** When true, return only rows with driver credit exception health. */
  driver_credit_exceptions_only?: boolean | null;
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
  /**
   * Trip Fare canonical final payable (adapter) when trip-linked;
   * otherwise session estimate seed only — never invent £0.
   */
  customer_payable_pence: number | null;
  /** Pre-authorisation buffer above customer payable. */
  buffer_pence: number | null;
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
  /** Slice 1 — residual release evidence after partial capture. */
  release_evidence_status: string | null;
  release_evidence_source: string | null;
  release_verified_at: string | null;
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
  /** Release / cancel reason for Released tab (hold_terminal_reason or release_failure_reason). */
  release_reason: string | null;
  hold_terminal_reason: string | null;
  release_failure_reason: string | null;
  evidence_warnings?: string[];
  webhook_timeline?: Array<{
    event_type: string;
    processed_at: string | null;
    applied_status: string | null;
  }>;
  admin_refresh_timeline?: Array<{
    verified_at: string;
    verified_by: string;
    provider_state: string | null;
  }>;
  age_minutes: number;
  /**
   * FR-owned reconciliation conclusion when persisted.
   * Null on Payment Sessions until FR provides it — UI shows Open FR.
   */
  reconciliation_status: string | null;
  /** Action-policy capture taxonomy only — not FR SSOT. */
  capture_classification: string | null;
  capture_classification_label: string | null;
  /** FR-owned variance when persisted; otherwise null (never local captured−payable). */
  difference_pence: number | null;
  outstanding_pence: number | null;
  /** Provider-truth action classification (AUTHORISED_ACTIVE, NO_ACTIVE_HOLD, …). */
  action_classification?: string | null;
  action_classification_label?: string | null;
  releasable_pence?: number | null;
  allowed_actions?: string[] | null;
  hold_release_state?: string | null;
  provider_release_reference?: string | null;
  recovery_attempt_count?: number | null;
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
  /** Read-only driver credit monitoring (PLATFORM_COLLECTED captured / terminal-fee sessions). */
  driver_credit_display?: string | null;
  driver_credit_health?: string | null;
  expected_driver_credit_pence?: number | null;
  actual_driver_credit_pence?: number | null;
  credit_difference_pence?: number | null;
  credit_eligibility_at?: string | null;
};

/** Completed Trips Paid — one row = one completed trip (fare from trip SSOT, not React). */
export type AdminPaymentSessionsCompletedTripRow = {
  id: string;
  trip_id: string;
  trip_code: string | null;
  completed_at: string | null;
  customer_id: string | null;
  customer_name: string | null;
  driver_id: string | null;
  driver_name: string | null;
  service_area_id: string | null;
  service_area_name: string | null;
  /** Ride-only stamp (excludes waiting) — not the complete final payable. */
  final_customer_fare_pence: number | null;
  ride_fare_pence: number | null;
  /** Trip Fare final payable (incl. waiting) — stamped. */
  final_fare_pence?: number | null;
  original_locked_fare_pence?: number | null;
  accepted_preset_offer_fare_pence?: number | null;
  airport_charge_pence: number | null;
  tips_pence: number | null;
  /** Waiting + other legitimate components (stamped Trip Fare fields). */
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  waiting_charges_pence?: number | null;
  other_payment_components_pence?: number | null;
  no_show_charge_pence?: number | null;
  /** Audit-only mod delta — never re-added into expected capture. */
  modification_audit_pence?: number | null;
  /** Settlement SSOT stamps. */
  commissionable_fare_pence?: number | null;
  commission_pence?: number | null;
  driver_net_pence?: number | null;
  /** Canonical expected capture from Trip Fare stamps (not PS money). */
  expected_capture_pence: number | null;
  payment_session_id: string | null;
  payment_provider: string | null;
  provider_captured_pence: number | null;
  provider_released_pence: number | null;
  provider_refunded_pence?: number | null;
  shortfall_overcapture_pence: number | null;
  variance_pence?: number | null;
  variance_reason?: string | null;
  capture_classification?: string | null;
  match_status: PaymentTripMatchStatus | null;
  /**
   * FR does not persist per-session match here.
   * Amount shortfall/overcapture are not classified on this row — use variance_pence only.
   * match_status is presence/lifecycle only; amount conclusions use AMOUNTS_ON_FR (never null).
   */
  match_classification_source?: "stamp_vs_provider_interim" | "ps_presence_lifecycle";
  fr_match_status_persisted?: false;
  /** Legacy write-path DTO — read path leaves null; UI uses stamp fields. */
  capture_breakdown?: import("./paymentSessionsCaptureBreakdownSSOT.ts").PaymentSessionCaptureBreakdown | null;
  driver_credit_health?: string | null;
  expected_driver_credit_pence?: number | null;
  actual_driver_credit_pence?: number | null;
  credit_difference_pence?: number | null;
  credit_eligibility_at?: string | null;
};

/** Payment Matching — comparison-only rows. */
export type AdminPaymentSessionsMatchingRow = {
  id: string;
  trip_id: string | null;
  trip_code: string | null;
  payment_session_id: string | null;
  customer_name: string | null;
  expected_capture_pence: number | null;
  actual_capture_pence: number | null;
  authorised_amount_pence: number | null;
  released_amount_pence: number | null;
  variance_pence: number | null;
  shortfall_pence: number | null;
  overcapture_pence: number | null;
  /** Provider-confirmed refunds on the session (pence). Null = unknown / none recorded. */
  refunded_amount_pence?: number | null;
  /** Gross unexplained overcapture still above payable after refunds. */
  outstanding_overcharge_pence?: number | null;
  /** Portion of gross overcapture covered by refunds. */
  resolved_overcapture_pence?: number | null;
  /**
   * Refund above gross overcapture (e.g. £6 refund on £3 excess).
   * Historical reconciliation signal — not silently netted.
   */
  refund_beyond_gross_overcapture_pence?: number | null;
  variance_reason?: string | null;
  capture_classification?: string | null;
  match_status: PaymentTripMatchStatus | null;
  provider_state: string | null;
  provider_verification_status: "VERIFIED" | "STALE" | "UNKNOWN" | "UNAVAILABLE" | null;
  provider_order_id: string | null;
};

/** provider-like KPI strip — all values owned by Payment Sessions edge (never client-summed). */
export type AdminPaymentSessionsSummary = {
  total: number;
  active_hold_count: number;
  active_hold_amount_pence: number | null;
  captured_count: number;
  released_count: number;
  refunded_count: number;
  failed_recovery_count: number;
  recovery_pending_count: number;
  provider_fees_pending_count: number;
  /** SUM(confirmed captured_amount_pence) only — never authorisations or trip fares. */
  total_customer_revenue_captured_pence: number | null;
  total_authorised_pence: number | null;
  /** captured_count / (captured_count + capture_failed_count) × 100, or null if no attempts. */
  capture_success_rate_pct: number | null;
  money_at_risk_pence: number | null;
  /** Human-action RED only (never auto-recovering / cancelled / test). */
  red: number;
  amber: number;
  green: number;
  unknown_count: number;
  active_action_required_count?: number;
  automatically_recovering_count?: number;
  automatically_recovered_count?: number;
  cancelled_by_customer_count?: number;
  test_sandbox_count?: number;
  historical_evidence_count?: number;
  /** Provider vs completed-trip comparison widgets (backend-owned). */
  provider_captured_total_pence: number | null;
  completed_trip_fare_total_pence: number | null;
  /**
   * FR-owned match chips. Null when FR does not persist per-session match
   * (Payment Sessions must not invent a second matching engine for chips).
   */
  matched_trips_count: number | null;
  capture_shortfall_pence: number | null;
  /**
   * Historical gross unexplained overcapture (actual − expected).
   * Does not mean customers are still owed this amount.
   * Null when FR chip path unavailable.
   */
  overcaptured_amount_pence: number | null;
  /** Alias of overcaptured_amount_pence — explicit “gross / historical” label. */
  gross_overcapture_pence?: number | null;
  /** Portion of gross overcapture already covered by provider-confirmed refunds. */
  resolved_overcapture_pence?: number | null;
  /**
   * Remaining customer overcharge after refunds:
   * max(0, (captured − refunded) − expected) on unexplained-overcapture rows.
   */
  outstanding_customer_overcharge_pence?: number | null;
  /** Refund total above gross overcapture (over-refund history; FR-visible). */
  refund_beyond_gross_overcapture_pence?: number | null;
  /** False until FR exposes a canonical per-session match read path. */
  fr_match_chips_available?: boolean;
  fr_match_chips_message?: string | null;
  /** COUNT completed trips with no Payment Sessions row (PS presence, not FR). */
  missing_payment_sessions_count: number;
  released_buffer_total_pence: number | null;
  refunded_total_pence: number | null;
  provider_fees_total_pence: number | null;
  /** SUM trip gross ONECAB commission (settlement) — backend only. */
  gross_onecab_commission_pence: number | null;
  /** Gross − provider fees — backend only; fees are never ONECAB revenue. */
  net_onecab_commission_pence: number | null;
  /** SUM trip driver_net_pence — backend only. */
  driver_net_total_pence: number | null;
  /** Read-only driver credit exceptions across visible session scope. */
  driver_credit_exception_trip_count?: number | null;
  driver_credit_exception_difference_pence?: number | null;
};

export type AdminPaymentSessionsListResponse = {
  success: boolean;
  page_status: AdminPaymentSessionsPageStatus;
  tab: AdminPaymentSessionsTab;
  rows: AdminPaymentSessionsListRow[];
  completed_trip_rows?: AdminPaymentSessionsCompletedTripRow[];
  matching_rows?: AdminPaymentSessionsMatchingRow[];
  summary: AdminPaymentSessionsSummary;
  /** Total filtered rows for the active tab before limit/offset slice. */
  filtered_total?: number;
  /** True when more filtered rows exist beyond this page. */
  has_more?: boolean;
  offset?: number;
  error?: string;
  provider_verification_message?: string | null;
  trip_evidence_message?: string | null;
};

export function paymentSessionsUrl(args?: {
  tab?: AdminPaymentSessionsTab | PaymentSessionsNavTab;
  paymentSessionId?: string | null;
  providerOrderId?: string | null;
  tripId?: string | null;
  customerId?: string | null;
  providerFeesPending?: boolean;
  captureFailed?: boolean;
  recoveryPending?: boolean;
  releaseFailed?: boolean;
  moneyAtRisk?: boolean;
  matchStatus?: PaymentTripMatchStatus;
}): string {
  if (!args) return '/payment-sessions?tab=captured';

  const mapped = args.tab != null
    ? resolveLegacyPaymentSessionsTabMapping(String(args.tab))
    : { navTab: 'captured' as PaymentSessionsNavTab };
  let navTab: PaymentSessionsNavTab = mapped.navTab;
  let opFilter: import('./paymentSessionsNavigationSSOT.ts').PaymentSessionsOpChip | undefined = mapped.opChip;

  if (args.captureFailed) opFilter = 'refund_failed';
  if (args.releaseFailed) opFilter = 'release_failed';
  if (args.recoveryPending) {
    navTab = 'recovery';
    opFilter = 'recovery_required';
  }
  if (args.moneyAtRisk) opFilter = 'release_failed';
  if (args.providerFeesPending) {
    navTab = 'captured';
  }

  return paymentSessionsNavUrl({
    tab: navTab,
    opFilter,
    paymentSessionId: args.paymentSessionId ?? undefined,
    providerOrderId: args.providerOrderId ?? undefined,
    tripId: args.tripId ?? undefined,
    customerId: args.customerId ?? undefined,
  });
}
