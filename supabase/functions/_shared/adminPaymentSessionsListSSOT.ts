/**
 * Admin Payment Sessions list — maps hold SSOT + session columns into one list.
 * No client-side merge; no financial formula invention.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type {
  AdminPaymentSessionsListRequest,
  AdminPaymentSessionsListResponse,
  AdminPaymentSessionsListRow,
  AdminPaymentSessionsPageStatus,
  AdminPaymentSessionsSummary,
  AdminPaymentSessionsTab,
} from "../../../shared/adminPaymentSessionsSSOT.ts";
import {
  paymentSessionActionPolicy,
  type PaymentSessionPurpose,
} from "../../../shared/paymentSessionPhase1SSOT.ts";
import {
  buildPaymentSessionsDisplay,
  confirmedCapturedRevenuePence,
  rowBelongsInActiveHoldsTab,
  rowBelongsInCapturedTab,
  rowBelongsInRefundedTab,
  rowBelongsInReleasedTab,
} from "../../../shared/paymentSessionsDisplaySSOT.ts";
import {
  classifyCaptureConfirmation,
} from "../../../shared/paymentSessionsCaptureConfirmationSSOT.ts";
import { derivePaymentSessionAllowedActions, isOpenTripPaymentRecoverySession } from "../../../shared/paymentSessionsAllowedActionsSSOT.ts";
import { isValidConfirmedCapturePence } from "../../../shared/paymentCaptureEvidenceSSOT.ts";
import {
  buildCanonicalTripEconomicsRead,
} from "../../../shared/paymentSessionsCanonicalReadAdapterSSOT.ts";
import { classifyTripForPlatformCollectedAdminPage } from "../../../shared/financialModelScopeSSOT.ts";
import { listPaymentHoldsRequiringAttention } from "./paymentHoldReconciliationSSOT.ts";
import { buildPaymentSessionsTripCompare, buildPsOnlyCompareSummary } from "./adminPaymentSessionsTripCompareSSOT.ts";
import type { PaymentHoldReconciliationRow } from "../../../shared/paymentHoldReconciliation.ts";
import {
  classifyPaymentHoldOperationalBucket,
  mapRevolutProviderHoldState,
  moneyAtRiskInclude,
  type PaymentHoldAttentionClass,
} from "../../../shared/paymentHoldClassificationSSOT.ts";

function asPurpose(raw: unknown): PaymentSessionPurpose {
  const v = String(raw ?? "").toUpperCase();
  if (v === "SAVE_CARD") return "SAVE_CARD";
  if (v === "PAYMENT_RECOVERY") return "PAYMENT_RECOVERY";
  if (v === "LEGACY_EVIDENCE") return "LEGACY_EVIDENCE";
  return "RIDE_BOOKING";
}

function providerVerificationStatus(args: {
  providerState: string | null;
  verifiedAt: string | null;
  refreshFailed: boolean;
}): AdminPaymentSessionsListRow["provider_verification_status"] {
  if (args.refreshFailed && !args.providerState) return "UNAVAILABLE";
  if (!args.providerState) return "UNKNOWN";
  if (!args.verifiedAt) return "STALE";
  const age = Date.now() - Date.parse(args.verifiedAt);
  if (!Number.isFinite(age) || age > 15 * 60 * 1000) return "STALE";
  return "VERIFIED";
}

function rowMatchesTab(row: AdminPaymentSessionsListRow, tab: AdminPaymentSessionsTab): boolean {
  if (tab === "overview" || tab === "history" || tab === "provider_payments") return true;
  if (tab === "completed_trips_paid" || tab === "payment_matching") return false;
  if (tab === "active_holds") {
    return rowBelongsInActiveHoldsTab(row);
  }
  if (tab === "captured") {
    return rowBelongsInCapturedTab(row);
  }
  if (tab === "released") {
    return rowBelongsInReleasedTab(row);
  }
  if (tab === "refunded") {
    return rowBelongsInRefundedTab(row);
  }
  if (tab === "failed_recovery") {
    // Operator intervention only — recovery pending / release failed.
    return Boolean(
      row.attention_class === "RELEASE_FAILED"
      || row.attention_class === "RECOVERY_PENDING"
    );
  }
  return true;
}

type SessionExtra = {
  client_action_id: string | null;
  service_area_id: string | null;
  service_area_name: string | null;
  payment_method: string | null;
  purpose: PaymentSessionPurpose | string | null;
  customer_payable_pence: number | null;
  buffer_pence: number | null;
  authorised_amount_pence: number | null;
  captured_amount_pence: number | null;
  released_amount_pence: number | null;
  refunded_amount_pence: number | null;
  provider_processing_fee_pence: number | null;
  fee_status: string | null;
  provider_capture_id: string | null;
  provider_payment_id: string | null;
  captured_at: string | null;
  released_at: string | null;
  refunded_at: string | null;
  release_evidence_status: string | null;
  release_evidence_source: string | null;
  release_verified_at: string | null;
  payment_resolution_type: string | null;
  payment_resolution_status: string | null;
  recovery_required: boolean | null;
  hold_release_state: string | null;
  provider_release_reference: string | null;
  recovery_attempt_count: number;
  evidence_warnings: string[];
  webhook_timeline: AdminPaymentSessionsListRow["webhook_timeline"];
  admin_refresh_timeline: AdminPaymentSessionsListRow["admin_refresh_timeline"];
  refreshFailed: boolean;
};

function mapHoldToSessionRow(
  hold: PaymentHoldReconciliationRow,
  extra: SessionExtra,
): AdminPaymentSessionsListRow {
  const purpose = asPurpose(extra.purpose ?? (hold.attention_class === "LEGACY_EVIDENCE" ? "LEGACY_EVIDENCE" : "RIDE_BOOKING"));
  const basePolicy = paymentSessionActionPolicy({
    purpose,
    status: String(hold.session_status ?? ""),
    providerVerification: hold.provider_state_verified_at && hold.provider_order_state
      ? {
        verified_at: hold.provider_state_verified_at,
        verified_by: "admin_refresh",
        provider_state: hold.provider_order_state,
        matches_session_provider_order_id: true,
      }
      : null,
  });

  const action_policy = {
    ...basePolicy,
    can_release: hold.can_release,
    can_retry_recovery: hold.can_retry_recovery,
    can_retry_release: hold.can_retry_release,
    can_refund: hold.can_refund === true,
    can_inspect_provider: true,
    can_open_trip: hold.can_open_trip,
    can_open_reconciliation: Boolean(hold.trip_id),
    can_create_trip: false,
  };

  const verification = providerVerificationStatus({
    providerState: hold.provider_order_state,
    verifiedAt: hold.provider_state_verified_at ?? null,
    refreshFailed: extra.refreshFailed,
  });

  if (verification === "UNAVAILABLE" || verification === "UNKNOWN") {
    action_policy.can_release = false;
    action_policy.can_retry_release = false;
    action_policy.can_refund = false;
    if (verification === "UNAVAILABLE") {
      action_policy.can_retry_recovery = false;
    }
  }

  const capturedAt = extra.captured_at ?? hold.captured_at ?? null;
  const releasedAt = extra.released_at ?? hold.released_at ?? null;
  const capturedAmount = extra.captured_amount_pence;
  const releasedAmount = extra.released_amount_pence ?? hold.released_amount_pence ?? null;
  const feeStatus = extra.fee_status;
  const feePence = extra.provider_processing_fee_pence;

  const payableGuess = extra.customer_payable_pence;
  const outstandingGuess = payableGuess != null && isValidConfirmedCapturePence(capturedAmount)
    ? Math.max(0, payableGuess - Number(capturedAmount))
    : (payableGuess != null && !isValidConfirmedCapturePence(capturedAmount) ? payableGuess : 0);
  const unresolvedFinalCharge = outstandingGuess > 0
    && !isValidConfirmedCapturePence(capturedAmount)
    && Boolean(hold.trip_id);

  const allowed = derivePaymentSessionAllowedActions({
    providerOrderId: hold.provider_order_id,
    providerState: hold.provider_order_state,
    providerRetrieved: verification === "VERIFIED",
    providerRetrieveFailed: verification === "UNAVAILABLE" || extra.refreshFailed,
    providerOrderNotFound: !hold.provider_order_id,
    providerVerifiedAt: hold.provider_state_verified_at ?? null,
    providerVerificationStatus: verification,
    authorisedPence: extra.authorised_amount_pence ?? hold.amount_pence,
    capturedPence: capturedAmount,
    releasedPence: releasedAmount,
    releasedAt,
    capturedAt,
    canonicalPayablePence: extra.customer_payable_pence,
    localHoldReleaseState: extra.hold_release_state ?? hold.hold_release_state,
    localAttentionClass: hold.attention_class,
    providerReleaseRequestSubmitted: Boolean(extra.provider_release_reference),
    providerReleaseRequestId: extra.provider_release_reference,
    recoveryAttemptCount: extra.recovery_attempt_count ?? hold.recovery_attempt_count ?? 0,
    // Never treat local RECOVERY_PENDING attention as retryable by itself.
    recoveryAttemptRetryableFailed: Boolean(hold.release_failure_reason)
      || String(hold.hold_release_state ?? "").toLowerCase() === "release_failed",
    recoveryCurrentlyPendingOrCaptured: isOpenTripPaymentRecoverySession({
      purpose,
      sessionStatus: hold.session_status,
      technicalStatus: hold.session_status,
    })
      || (extra.recovery_required === true && (extra.recovery_attempt_count ?? 0) > 0
        && !isValidConfirmedCapturePence(capturedAmount)),
    unresolvedFinalCharge,
    purpose,
    hasTrip: Boolean(hold.trip_id),
  });

  // Provider-truth overrides — never enable from local attention flags alone.
  action_policy.can_release = allowed.can_release;
  action_policy.can_retry_release = allowed.can_retry_release;
  action_policy.can_retry_recovery = allowed.can_retry_recovery;
  action_policy.can_refund = allowed.can_refund;

  const display = buildPaymentSessionsDisplay({
    raw_session_status: hold.session_status,
    provider_state: hold.provider_order_state,
    provider_verification_status: verification,
    authorised_amount_pence: extra.authorised_amount_pence ?? hold.amount_pence,
    captured_amount_pence: capturedAmount,
    released_amount_pence: releasedAmount,
    refunded_amount_pence: extra.refunded_amount_pence,
    provider_processing_fee_pence: feePence,
    fee_status: feeStatus,
    captured_at: capturedAt,
    released_at: releasedAt,
    refunded_at: extra.refunded_at,
    hold_classification: hold.hold_classification,
    classification: hold.classification,
    payment_resolution_type: extra.payment_resolution_type,
    payment_resolution_status: extra.payment_resolution_status,
    recovery_required: extra.recovery_required,
  });

  const attention = hold.attention_class ?? null;
  // Session lifecycle only — never overlay action-policy labels into Session Status.
  const operatorLabel = operatorFacingSessionStatus({
    canonicalLabel: display.session_status_label,
    attentionClass: attention,
    sessionStatusDisplay: display.session_status_display,
  });
  const releaseReason = hold.hold_terminal_reason
    ?? hold.release_failure_reason
    ?? null;

  // classifyCaptureConfirmation is for action policy / outstanding only — NOT FR SSOT.
  const captureClass = classifyCaptureConfirmation({
    providerState: hold.provider_order_state,
    providerCapturedPence: capturedAmount,
    localCapturedPence: capturedAmount,
    canonicalPayablePence: extra.customer_payable_pence,
    authorisedPence: extra.authorised_amount_pence ?? hold.amount_pence,
    releasedAmountPence: releasedAmount,
    refundedAmountPence: extra.refunded_amount_pence,
    purpose,
    hasTripOwnership: Boolean(hold.trip_id) || purpose === "SAVE_CARD",
  });

  return {
    id: hold.id,
    source: hold.source,
    payment_session_id: hold.source === "payment_sessions" ? hold.payment_session_id : null,
    orphan_payment_id: hold.orphan_evidence_id ?? (hold.source === "orphan_payments" ? hold.payment_session_id : null),
    client_action_id: extra.client_action_id,
    created_at: hold.created_at,
    customer_id: hold.customer_id,
    customer_name: hold.customer_name,
    customer_email: hold.customer_email,
    trip_id: hold.trip_id,
    trip_code: hold.trip_code,
    trip_status: hold.trip_status,
    driver_id: hold.driver_id ?? null,
    service_area_id: extra.service_area_id,
    service_area_name: extra.service_area_name,
    payment_provider: hold.payment_provider,
    payment_method: extra.payment_method,
    purpose,
    customer_payable_pence: extra.customer_payable_pence,
    buffer_pence: extra.buffer_pence,
    authorised_amount_pence: extra.authorised_amount_pence ?? hold.amount_pence,
    captured_amount_pence: capturedAmount,
    released_amount_pence: releasedAmount,
    refunded_amount_pence: extra.refunded_amount_pence,
    provider_processing_fee_pence: feePence,
    fee_status: feeStatus,
    fee_display_label: display.fee_display.label,
    fee_display_badge: display.fee_display.badge,
    provider_order_id: hold.provider_order_id,
    provider_payment_id: extra.provider_payment_id,
    provider_capture_id: extra.provider_capture_id,
    provider_state: hold.provider_order_state,
    provider_state_label: display.provider_state_label,
    provider_state_verified_at: hold.provider_state_verified_at ?? null,
    release_evidence_status: extra.release_evidence_status ?? null,
    release_evidence_source: extra.release_evidence_source ?? null,
    release_verified_at: extra.release_verified_at ?? null,
    provider_verification_status: verification,
    session_status: operatorLabel,
    session_status_display: display.session_status_display,
    session_status_label: operatorLabel,
    technical_status: display.technical_status,
    evidence_status: display.evidence_status === "INCOMPLETE"
      ? "LOCAL_BACKFILL_REQUIRED"
      : display.evidence_status,
    evidence_label: /incomplete/i.test(String(display.evidence_label ?? ""))
      ? "LOCAL BACKFILL REQUIRED"
      : display.evidence_label,
    captured_at: capturedAt,
    released_at: releasedAt,
    refunded_at: extra.refunded_at,
    release_reason: releaseReason,
    hold_terminal_reason: hold.hold_terminal_reason ?? null,
    release_failure_reason: hold.release_failure_reason ?? null,
    age_minutes: hold.age_minutes,
    // FR owns Difference / Reconciliation — null until FR persists per-session conclusions.
    reconciliation_status: null,
    capture_classification: captureClass.classification,
    capture_classification_label: captureClass.label,
    difference_pence: null,
    outstanding_pence: captureClass.outstanding_pence ?? allowed.outstanding_pence,
    action_classification: allowed.classification,
    action_classification_label: allowed.classification_label,
    releasable_pence: allowed.releasable_pence,
    allowed_actions: allowed.allowed_actions,
    hold_release_state: extra.hold_release_state ?? hold.hold_release_state ?? null,
    provider_release_reference: extra.provider_release_reference ?? null,
    recovery_attempt_count: extra.recovery_attempt_count ?? hold.recovery_attempt_count ?? 0,
    attention_class: attention,
    classification: display.classification ?? hold.classification,
    in_active_queue: hold.in_active_queue !== false,
    amount_display: hold.amount_display
      ?? (capturedAt && capturedAmount == null ? "AMOUNT_UNCONFIRMED" : null),
    action_policy,
    page_status_hint: verification === "UNAVAILABLE" ? "PROVIDER_UNAVAILABLE" : null,
    evidence_warnings: extra.evidence_warnings ?? [],
    webhook_timeline: extra.webhook_timeline ?? [],
    admin_refresh_timeline: extra.admin_refresh_timeline ?? [],
  };
}

/** Spec vocabulary overlay — Recovery/Capture/Release Failed·Pending as first-class labels. */
function operatorFacingSessionStatus(args: {
  canonicalLabel: string;
  attentionClass: string | null;
  sessionStatusDisplay: string | null;
}): string {
  const display = String(args.sessionStatusDisplay ?? "").toUpperCase();
  if (display === "CAPTURE_FAILED") return "CAPTURE FAILED";
  if (display === "CANCELLED") return "CANCELLED";
  const ac = String(args.attentionClass ?? "").toUpperCase();
  // Never show RELEASE/RECOVERY PENDING or INCOMPLETE from local attention alone.
  if (ac === "RELEASE_PENDING") return args.canonicalLabel;
  if (ac === "RECOVERY_PENDING") return args.canonicalLabel;
  if (ac === "RELEASE_FAILED") return "RELEASE FAILED";
  if (ac.includes("CAPTURE_FAILED")) return "CAPTURE FAILED";
  if (ac === "CAPTURED" && args.sessionStatusDisplay === "CAPTURED_EVIDENCE_PENDING") {
    return "CAPTURE PENDING";
  }
  if (display === "CAPTURE_PENDING") return "CAPTURE PENDING";
  const canonical = String(args.canonicalLabel).toUpperCase();
  if (canonical === "INCOMPLETE" || canonical.includes("INCOMPLETE")) {
    return "LOCAL BACKFILL REQUIRED";
  }
  return args.canonicalLabel;
}

export async function listAdminPaymentSessions(
  supabase: SupabaseClient,
  request: AdminPaymentSessionsListRequest = {},
): Promise<AdminPaymentSessionsListResponse> {
  const tab: AdminPaymentSessionsTab = request.tab ?? "overview";
  const refresh = request.refresh_provider_state === true;

  let refreshFailed = false;
  let holds;
  // Keep hold fetch close to page size — overview used to force 500 and felt stuck.
  const pageLimit = Math.min(1000, Math.max(1, request.limit ?? 100));
  const fetchLimit = Math.min(
    1000,
    tab === "history"
      ? Math.max(pageLimit, 300)
      : tab === "active_holds" || tab === "failed_recovery"
      ? Math.max(pageLimit, 150)
      : pageLimit,
  );
  try {
    holds = await listPaymentHoldsRequiringAttention(supabase, {
      refreshProviderState: refresh,
      view: "all",
      limit: fetchLimit,
      allowed_service_area_ids: request.allowed_service_area_ids ?? null,
      filters: {
        dateFrom: request.date_from,
        dateTo: request.date_to,
        customerId: request.customer_id,
        tripId: request.trip_id,
        provider: request.provider,
        paymentSessionId: request.payment_session_id,
        providerOrderId: request.provider_order_id,
      },
    });
    if (refresh && holds.provider_refresh_partial) {
      refreshFailed = true;
    }
  } catch (err) {
    refreshFailed = true;
    holds = await listPaymentHoldsRequiringAttention(supabase, {
      refreshProviderState: false,
      view: "all",
      limit: fetchLimit,
      allowed_service_area_ids: request.allowed_service_area_ids ?? null,
      filters: {
        dateFrom: request.date_from,
        dateTo: request.date_to,
        customerId: request.customer_id,
        tripId: request.trip_id,
        provider: request.provider,
        paymentSessionId: request.payment_session_id,
        providerOrderId: request.provider_order_id,
      },
    });
    console.error("[admin-payment-sessions] provider refresh failed; using DB state", err);
  }

  const sessionIds = [
    ...new Set(
      [...holds.rows, ...(holds.history_rows ?? [])]
        .filter((r) => r.source === "payment_sessions")
        .map((r) => r.payment_session_id)
        .filter(Boolean),
    ),
  ] as string[];

  const extraBySessionId = new Map<string, {
    client_action_id: string | null;
    service_area_id: string | null;
    payment_method: string | null;
    purpose: string | null;
    customer_payable_pence: number | null;
    buffer_pence: number | null;
    authorised_amount_pence: number | null;
    captured_amount_pence: number | null;
    released_amount_pence: number | null;
    refunded_amount_pence: number | null;
    provider_processing_fee_pence: number | null;
    fee_status: string | null;
    provider_capture_id: string | null;
    provider_payment_id: string | null;
    captured_at: string | null;
    released_at: string | null;
    refunded_at: string | null;
    release_evidence_status: string | null;
    release_evidence_source: string | null;
    release_verified_at: string | null;
    payment_resolution_type: string | null;
    payment_resolution_status: string | null;
    recovery_required: boolean | null;
    hold_release_state: string | null;
    provider_release_reference: string | null;
    recovery_attempt_count: number;
    evidence_warnings: string[];
    webhook_timeline: AdminPaymentSessionsListRow["webhook_timeline"];
    admin_refresh_timeline: AdminPaymentSessionsListRow["admin_refresh_timeline"];
  }>();

  if (sessionIds.length > 0) {
    const { data: sessions } = await supabase
      .from("payment_sessions")
      .select(
        "id, client_action_id, service_area_id, payment_method, purpose, estimated_total_pence, buffer_pence, authorised_amount_pence, total_authorised_amount_pence, captured_amount_pence, released_amount_pence, refunded_amount_pence, provider_processing_fee_pence, fee_status, provider_capture_id, provider_payment_id, provider_order_id, provider_state, provider_state_verified_at, provider_state_verified_by, status, captured_at, released_at, refunded_at, release_evidence_status, release_evidence_source, release_verified_at, payment_resolution_type, payment_resolution_status, recovery_required, metadata, hold_release_state, provider_release_reference, recovery_attempt_count",
      )
      .in("id", sessionIds);

    const refundSumBySession = new Map<string, number>();
    try {
      const { data: refundRows } = await supabase
        .from("payment_session_refunds")
        .select("payment_session_id, amount_pence")
        .in("payment_session_id", sessionIds);
      for (const r of refundRows ?? []) {
        const sid = String(r.payment_session_id);
        const amt = Number(r.amount_pence);
        if (!Number.isFinite(amt) || amt <= 0) continue;
        refundSumBySession.set(sid, (refundSumBySession.get(sid) ?? 0) + Math.round(amt));
      }
    } catch (err) {
      console.warn("[admin-payment-sessions] payment_session_refunds read skipped", err);
    }

    const orderIds = [...new Set(
      (sessions ?? []).map((s) => s.provider_order_id).filter(Boolean).map(String),
    )];
    const webhookByOrder = new Map<string, AdminPaymentSessionsListRow["webhook_timeline"]>();
    // Webhook timelines are heavy — only for drill/history/provider tabs.
    const loadWebhooks = Boolean(request.payment_session_id)
      || tab === "history"
      || tab === "provider_payments";
    if (loadWebhooks && orderIds.length > 0) {
      try {
        const { data: events } = await supabase
          .from("processed_revolut_events")
          .select("order_id, event_type, processed_at, applied_status")
          .in("order_id", orderIds)
          .order("processed_at", { ascending: true });
        for (const ev of events ?? []) {
          const oid = String(ev.order_id ?? "");
          if (!oid) continue;
          const list = webhookByOrder.get(oid) ?? [];
          list.push({
            event_type: String(ev.event_type ?? ""),
            processed_at: (ev.processed_at as string | null) ?? null,
            applied_status: (ev.applied_status as string | null) ?? null,
          });
          webhookByOrder.set(oid, list);
        }
      } catch (err) {
        console.warn("[admin-payment-sessions] webhook timeline read skipped", err);
      }
    }

    for (const s of sessions ?? []) {
      const meta = s.metadata && typeof s.metadata === "object"
        ? s.metadata as Record<string, unknown>
        : {};
      const sid = String(s.id);
      const childRefundSum = refundSumBySession.get(sid) ?? null;
      const sessionRefund = s.refunded_amount_pence == null ? null : Number(s.refunded_amount_pence);
      const refundedAmount = childRefundSum != null ? childRefundSum : sessionRefund;
      const warnings: string[] = [];
      if (s.captured_at && s.captured_amount_pence == null) {
        warnings.push("Captured amount not yet recorded");
      }
      if (s.released_at && s.released_amount_pence == null) {
        warnings.push("Released amount unconfirmed");
      }
      if (
        (s.provider_state === "CAPTURED" || s.captured_at)
        && (s.fee_status == null || String(s.fee_status).toUpperCase() === "PENDING")
        && s.provider_processing_fee_pence == null
      ) {
        warnings.push("Provider fee pending");
      }
      if (String(s.status ?? "") === "completed_pending_capture" && s.provider_state === "CAPTURED") {
        warnings.push("Session technical status still completed_pending_capture after provider CAPTURED");
      }

      const adminRefresh: AdminPaymentSessionsListRow["admin_refresh_timeline"] = [];
      const verifiedAt = (s.provider_state_verified_at as string | null)
        ?? (typeof meta.provider_state_verified_at === "string" ? meta.provider_state_verified_at : null);
      const verifiedBy = (s.provider_state_verified_by as string | null)
        ?? (typeof meta.provider_state_verified_by === "string" ? meta.provider_state_verified_by : null);
      if (verifiedAt) {
        adminRefresh.push({
          verified_at: verifiedAt,
          verified_by: verifiedBy ?? "unknown",
          provider_state: (s.provider_state as string | null) ?? null,
        });
      }

      extraBySessionId.set(sid, {
        client_action_id: (s.client_action_id as string | null) ?? null,
        service_area_id: (s.service_area_id as string | null) ?? null,
        payment_method: (s.payment_method as string | null)
          ?? (typeof meta.payment_method_type === "string" ? meta.payment_method_type : null),
        purpose: (s.purpose as string | null)
          ?? (typeof meta.purpose === "string" ? meta.purpose : null),
        customer_payable_pence: s.estimated_total_pence == null ? null : Number(s.estimated_total_pence),
        buffer_pence: s.buffer_pence == null ? null : Number(s.buffer_pence),
        authorised_amount_pence: s.total_authorised_amount_pence != null
          ? Number(s.total_authorised_amount_pence)
          : s.authorised_amount_pence != null
          ? Number(s.authorised_amount_pence)
          : null,
        captured_amount_pence: s.captured_amount_pence == null ? null : Number(s.captured_amount_pence),
        released_amount_pence: s.released_amount_pence == null ? null : Number(s.released_amount_pence),
        refunded_amount_pence: refundedAmount,
        provider_processing_fee_pence: s.provider_processing_fee_pence == null
          ? null
          : Number(s.provider_processing_fee_pence),
        fee_status: (s.fee_status as string | null) ?? null,
        provider_capture_id: (s.provider_capture_id as string | null) ?? null,
        provider_payment_id: (s.provider_payment_id as string | null)
          ?? (typeof meta.provider_payment_id === "string" ? meta.provider_payment_id : null),
        captured_at: (s.captured_at as string | null) ?? null,
        released_at: (s.released_at as string | null) ?? null,
        refunded_at: (s.refunded_at as string | null) ?? null,
        release_evidence_status: (s.release_evidence_status as string | null) ?? null,
        release_evidence_source: (s.release_evidence_source as string | null) ?? null,
        release_verified_at: (s.release_verified_at as string | null) ?? null,
        payment_resolution_type: (s.payment_resolution_type as string | null) ?? null,
        payment_resolution_status: (s.payment_resolution_status as string | null) ?? null,
        recovery_required: s.recovery_required == null ? null : Boolean(s.recovery_required),
        hold_release_state: (s.hold_release_state as string | null) ?? null,
        provider_release_reference: (s.provider_release_reference as string | null)
          ?? (typeof meta.provider_release_reference === "string"
            ? meta.provider_release_reference
            : typeof meta.release_provider_request_id === "string"
            ? meta.release_provider_request_id
            : null),
        recovery_attempt_count: Number(s.recovery_attempt_count ?? 0),
        evidence_warnings: warnings,
        webhook_timeline: webhookByOrder.get(String(s.provider_order_id ?? "")) ?? [],
        admin_refresh_timeline: adminRefresh,
      });
    }
  }

  const serviceAreaIds = [...new Set(
    [...extraBySessionId.values()].map((e) => e.service_area_id).filter(Boolean),
  )] as string[];
  const serviceAreaNameById = new Map<string, string>();
  if (serviceAreaIds.length > 0) {
    const { data: areas } = await supabase
      .from("service_areas")
      .select("id, name")
      .in("id", serviceAreaIds);
    for (const a of areas ?? []) {
      serviceAreaNameById.set(String(a.id), String(a.name ?? ""));
    }
  }

  // Always build the full filter universe so KPI widgets stay consistent across tabs.
  const sourceRows = [...holds.rows, ...(holds.history_rows ?? [])];

  const seen = new Set<string>();
  const mapped: AdminPaymentSessionsListRow[] = [];
  for (const hold of sourceRows) {
    const key = `${hold.payment_provider}:${hold.provider_order_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const extra = hold.source === "payment_sessions"
      ? extraBySessionId.get(hold.payment_session_id)
      : null;

    const row = mapHoldToSessionRow(hold, {
      client_action_id: extra?.client_action_id ?? null,
      service_area_id: extra?.service_area_id ?? null,
      service_area_name: extra?.service_area_id
        ? (serviceAreaNameById.get(extra.service_area_id) ?? null)
        : null,
      payment_method: extra?.payment_method ?? null,
      purpose: extra?.purpose ?? null,
      customer_payable_pence: extra?.customer_payable_pence ?? null,
      buffer_pence: extra?.buffer_pence ?? null,
      authorised_amount_pence: extra?.authorised_amount_pence ?? null,
      captured_amount_pence: extra?.captured_amount_pence ?? null,
      released_amount_pence: extra?.released_amount_pence ?? null,
      refunded_amount_pence: extra?.refunded_amount_pence ?? null,
      provider_processing_fee_pence: extra?.provider_processing_fee_pence ?? null,
      fee_status: extra?.fee_status ?? null,
      provider_capture_id: extra?.provider_capture_id ?? null,
      provider_payment_id: extra?.provider_payment_id ?? null,
      captured_at: extra?.captured_at ?? hold.captured_at ?? null,
      released_at: extra?.released_at ?? hold.released_at ?? null,
      refunded_at: extra?.refunded_at ?? null,
      release_evidence_status: extra?.release_evidence_status ?? null,
      release_evidence_source: extra?.release_evidence_source ?? null,
      release_verified_at: extra?.release_verified_at ?? null,
      payment_resolution_type: extra?.payment_resolution_type ?? null,
      payment_resolution_status: extra?.payment_resolution_status ?? null,
      recovery_required: extra?.recovery_required ?? null,
      hold_release_state: extra?.hold_release_state ?? hold.hold_release_state ?? null,
      provider_release_reference: extra?.provider_release_reference ?? null,
      recovery_attempt_count: extra?.recovery_attempt_count
        ?? Number(hold.recovery_attempt_count ?? 0),
      evidence_warnings: extra?.evidence_warnings ?? [],
      webhook_timeline: extra?.webhook_timeline ?? [],
      admin_refresh_timeline: extra?.admin_refresh_timeline ?? [],
      refreshFailed,
    });

    if (request.payment_session_id && row.payment_session_id !== request.payment_session_id) continue;
    if (request.provider_order_id && row.provider_order_id !== request.provider_order_id) continue;
    if (request.trip_id && row.trip_id !== request.trip_id) continue;
    if (request.provider && row.payment_provider !== request.provider) continue;
    if (request.purpose && String(row.purpose).toUpperCase() !== String(request.purpose).toUpperCase()) continue;
    if (request.session_status && row.technical_status !== request.session_status
      && row.session_status !== request.session_status) continue;
    if (request.has_trip === true && !row.trip_id) continue;
    if (request.has_trip === false && row.trip_id) continue;
    if (request.active_hold === true && !rowBelongsInActiveHoldsTab(row)) continue;
    if (request.release_failed === true && row.attention_class !== "RELEASE_FAILED") continue;
    if (request.recovery_pending === true && row.attention_class !== "RECOVERY_PENDING") continue;
    if (request.legacy_evidence === true && row.purpose !== "LEGACY_EVIDENCE") continue;
    if (request.customer_id && row.customer_id !== request.customer_id) continue;
    if (request.provider_fees_pending === true) {
      const feePending = row.fee_display_badge === "PENDING"
        || String(row.fee_status ?? "").toUpperCase() === "PENDING"
        || row.evidence_status === "PENDING_PROVIDER_FEE";
      if (!feePending) continue;
    }
    if (request.capture_failed === true) {
      const captureFailed = String(row.session_status_display ?? "").toUpperCase() === "CAPTURE_FAILED"
        || String(row.session_status_label ?? "").includes("CAPTURE FAILED")
        || String(row.attention_class ?? "").includes("CAPTURE_FAILED")
        || (row.evidence_status === "CAPTURE_AMOUNT_MISSING")
        || String(row.session_status_display ?? "") === "FAILED";
      if (!captureFailed) continue;
    }
    if (request.money_at_risk === true) {
      if (!rowBelongsInActiveHoldsTab(row)) continue;
      if (row.classification === "GREEN") continue;
    }
    if (request.service_area_id && row.service_area_id !== request.service_area_id) continue;
    // Financial-model isolation: never surface wrong-model SA rows OR null-SA rows
    // without PLATFORM ownership (null SA is not silently mixed into PLATFORM pages).
    if (request.allowed_service_area_ids) {
      if (!row.service_area_id) continue;
      if (!request.allowed_service_area_ids.includes(row.service_area_id)) continue;
    }
    if (request.payment_method && row.payment_method !== request.payment_method) continue;
    if (request.provider_state && row.provider_state !== request.provider_state) continue;
    if (request.date_from && row.created_at < request.date_from) continue;
    if (request.date_to) {
      const toBound = request.date_to.length <= 10
        ? `${request.date_to}T23:59:59.999Z`
        : request.date_to;
      if (row.created_at > toBound) continue;
    }

    // Collect filter-matched universe first; tab applied after KPI summary.
    mapped.push(row);
  }

  // Override customer_payable with Trip Fare canonical final payable (adapter).
  // Never prefer final_customer_fare alone; never backfill refunds from trips.
  const payableTripIds = [...new Set(mapped.map((r) => r.trip_id).filter(Boolean))] as string[];
  if (payableTripIds.length > 0) {
    const { data: tripPayables } = await supabase
      .from("trips")
      .select(
        "id, financial_model, commission_wallet_enabled, final_customer_fare_pence, final_fare_pence, no_show_charge_pence, cancellation_fee_pence, outstanding_balance_pence, estimated_total_pence, waiting_charge_pence, total_waiting_charge_pence, pickup_waiting_charge_pence, stop_waiting_charge_pence, stop_charge_total_pence, tip_pence, tip_amount_pence, locked_base_fare_pence, customer_modification_charge_pence, destination_change_adjustment_pence, accepted_preset_offer_fare_pence, accepted_driver_offer_fare_pence, commissionable_fare_pence, commission_pence, driver_net_pence",
      )
      .in("id", payableTripIds);
    const payableByTrip = new Map<string, number | null>();
    const cwExcludedTripIds = new Set<string>();
    for (const t of tripPayables ?? []) {
      if (!classifyTripForPlatformCollectedAdminPage(t as {
        financial_model?: unknown;
        commission_wallet_enabled?: unknown;
      }).includeOnPlatformPage) {
        cwExcludedTripIds.add(String(t.id));
        continue;
      }
      const eco = buildCanonicalTripEconomicsRead(t as Record<string, unknown>);
      payableByTrip.set(String(t.id), eco.final_fare_pence);
    }
    // Drop sessions whose linked trip is CW / unknown-CW (SA allowlist alone is not enough).
    if (cwExcludedTripIds.size > 0) {
      for (let i = mapped.length - 1; i >= 0; i--) {
        const tripId = mapped[i]?.trip_id;
        if (tripId && cwExcludedTripIds.has(tripId)) mapped.splice(i, 1);
      }
    }
    const openRecoveryByTripId = new Set<string>();
    for (const r of mapped) {
      if (!r.trip_id) continue;
      if (isOpenTripPaymentRecoverySession({
        purpose: r.purpose,
        sessionStatus: r.session_status,
        technicalStatus: r.technical_status,
      })) {
        openRecoveryByTripId.add(r.trip_id);
      }
    }
    for (const row of mapped) {
      if (!row.trip_id) continue;
      const canonical = payableByTrip.get(row.trip_id);
      if (canonical != null) {
        row.customer_payable_pence = canonical;
      }
      // Recompute action classification against canonical trip payable (policy only).
      // Difference / Reconciliation stay null — FR owns those conclusions.
      const captureClass = classifyCaptureConfirmation({
        providerState: row.provider_state,
        providerCapturedPence: row.captured_amount_pence,
        localCapturedPence: row.captured_amount_pence,
        canonicalPayablePence: row.customer_payable_pence,
        authorisedPence: row.authorised_amount_pence,
        releasedAmountPence: row.released_amount_pence,
        refundedAmountPence: row.refunded_amount_pence,
        purpose: row.purpose,
        hasTripOwnership: Boolean(row.trip_id),
      });
      row.capture_classification = captureClass.classification;
      row.capture_classification_label = captureClass.label;
      row.difference_pence = null;
      row.outstanding_pence = captureClass.outstanding_pence;
      row.reconciliation_status = null;

      const unresolvedFinalCharge = (row.outstanding_pence ?? 0) > 0
        && !isValidConfirmedCapturePence(row.captured_amount_pence)
        && Boolean(row.trip_id);

      const allowed = derivePaymentSessionAllowedActions({
        providerOrderId: row.provider_order_id,
        providerState: row.provider_state,
        providerRetrieved: row.provider_verification_status === "VERIFIED",
        providerRetrieveFailed: row.provider_verification_status === "UNAVAILABLE",
        providerOrderNotFound: !row.provider_order_id,
        providerVerifiedAt: row.provider_state_verified_at,
        providerVerificationStatus: row.provider_verification_status,
        authorisedPence: row.authorised_amount_pence,
        capturedPence: row.captured_amount_pence,
        releasedPence: row.released_amount_pence,
        releasedAt: row.released_at,
        capturedAt: row.captured_at,
        canonicalPayablePence: row.customer_payable_pence,
        refundedAmountPence: row.refunded_amount_pence,
        localHoldReleaseState: row.hold_release_state ?? null,
        localAttentionClass: row.attention_class,
        providerReleaseRequestSubmitted: Boolean(row.provider_release_reference),
        providerReleaseRequestId: row.provider_release_reference ?? null,
        recoveryAttemptCount: row.recovery_attempt_count ?? 0,
        recoveryAttemptRetryableFailed: Boolean(row.release_failure_reason)
          || String(row.hold_release_state ?? "").toLowerCase() === "release_failed",
        recoveryCurrentlyPendingOrCaptured: openRecoveryByTripId.has(row.trip_id)
          || isOpenTripPaymentRecoverySession({
            purpose: row.purpose,
            sessionStatus: row.session_status,
            technicalStatus: row.technical_status,
          }),
        unresolvedFinalCharge,
        purpose: row.purpose,
        hasTrip: Boolean(row.trip_id),
      });
      row.action_classification = allowed.classification;
      row.action_classification_label = allowed.classification_label;
      row.releasable_pence = allowed.releasable_pence;
      row.allowed_actions = allowed.allowed_actions;
      row.outstanding_pence = allowed.outstanding_pence > 0
        ? allowed.outstanding_pence
        : row.outstanding_pence;
      if (row.action_policy) {
        row.action_policy.can_release = allowed.can_release;
        row.action_policy.can_retry_release = allowed.can_retry_release;
        row.action_policy.can_retry_recovery = allowed.can_retry_recovery;
        row.action_policy.can_refund = allowed.can_refund;
      }
      // Do not overwrite session_status with action classification labels.
    }
  }

  const summary = buildPaymentSessionsSummary(mapped, holds.summary);

  // Trip compare is expensive (trips + names + sessions). Only for Overview KPIs
  // and Completed/Matching tabs — other tabs use Payment Sessions money summary only.
  const needsTripCompare = tab === "overview"
    || tab === "completed_trips_paid"
    || tab === "payment_matching";
  const compare = needsTripCompare
    ? await buildPaymentSessionsTripCompare(supabase, request, mapped)
    : {
      completed_trip_rows: [],
      matching_rows: [],
      trip_evidence_available: true,
      trip_evidence_message: null as string | null,
      compare_summary: buildPsOnlyCompareSummary(mapped),
    };
  const mergedSummary: AdminPaymentSessionsSummary = {
    ...summary,
    ...compare.compare_summary,
    // Prefer confirmed provider capture total for the new widget alias.
    provider_captured_total_pence:
      compare.compare_summary.provider_captured_total_pence
      ?? summary.total_customer_revenue_captured_pence,
  };

  const limit = request.limit ?? 100;
  const offset = Math.max(0, request.offset ?? 0);

  let page_status: AdminPaymentSessionsPageStatus = refreshFailed
    ? "PROVIDER_UNAVAILABLE"
    : mapped.some((r) => r.provider_verification_status === "STALE")
    ? "PARTIAL"
    : "LIVE";
  if (!compare.trip_evidence_available && (tab === "completed_trips_paid" || tab === "payment_matching")) {
    page_status = page_status === "PROVIDER_UNAVAILABLE" ? "DEGRADED" : "PARTIAL";
  }

  if (tab === "completed_trips_paid") {
    const all = compare.completed_trip_rows;
    const page = all.slice(offset, offset + limit);
    return {
      success: true,
      page_status,
      tab,
      rows: [],
      completed_trip_rows: page,
      matching_rows: [],
      summary: mergedSummary,
      filtered_total: all.length,
      has_more: offset + page.length < all.length,
      offset,
      provider_verification_message: refreshFailed
        ? "Provider Sync Pending — showing last verified database state. Verified values were not overwritten."
        : null,
      trip_evidence_message: compare.trip_evidence_message,
    };
  }

  if (tab === "payment_matching") {
    const all = compare.matching_rows;
    const page = all.slice(offset, offset + limit);
    return {
      success: true,
      page_status,
      tab,
      rows: [],
      completed_trip_rows: [],
      matching_rows: page,
      summary: mergedSummary,
      filtered_total: all.length,
      has_more: offset + page.length < all.length,
      offset,
      provider_verification_message: refreshFailed
        ? "Provider Sync Pending — showing last verified database state. Verified values were not overwritten."
        : null,
      trip_evidence_message: compare.trip_evidence_message,
    };
  }

  const tabRows = mapped.filter((r) => rowMatchesTab(r, tab));
  const pageRows = tabRows.slice(offset, offset + limit);

  return {
    success: true,
    page_status,
    tab,
    rows: pageRows,
    completed_trip_rows: [],
    matching_rows: [],
    summary: mergedSummary,
    filtered_total: tabRows.length,
    has_more: offset + pageRows.length < tabRows.length,
    offset,
    provider_verification_message: refreshFailed
      ? "Provider Sync Pending — showing last verified database state. Verified values were not overwritten."
      : null,
    trip_evidence_message: compare.trip_evidence_message,
  };
}

function buildPaymentSessionsSummary(
  rows: AdminPaymentSessionsListRow[],
  holdSummary: {
    active_hold_count: number;
    active_hold_amount_pence: number;
    unknown_count: number;
  },
): AdminPaymentSessionsSummary {
  const capturedRows = rows.filter((r) => rowBelongsInCapturedTab(r));
  const releasedRows = rows.filter((r) => rowBelongsInReleasedTab(r));
  const refundedRows = rows.filter((r) => rowBelongsInRefundedTab(r));
  const activeHoldRows = rows.filter((r) => rowBelongsInActiveHoldsTab(r));
  const recoveryPending = rows.filter((r) => r.attention_class === "RECOVERY_PENDING");
  const failedRecovery = rows.filter((r) =>
    r.attention_class === "RELEASE_FAILED"
    || r.attention_class === "RECOVERY_PENDING"
  );
  const feesPending = rows.filter((r) =>
    r.fee_display_badge === "PENDING"
    || String(r.fee_status ?? "").toUpperCase() === "PENDING"
    || r.evidence_status === "PENDING_PROVIDER_FEE"
  );
  const captureFailed = rows.filter((r) =>
    String(r.session_status_display ?? "").toUpperCase() === "CAPTURE_FAILED"
    || String(r.session_status_display ?? "").toUpperCase() === "FAILED"
    || String(r.attention_class ?? "").includes("CAPTURE_FAILED")
    || /capture.?fail/i.test(String(r.session_status_label ?? ""))
  );

  let revenue: number | null = null;
  for (const r of capturedRows) {
    const amt = confirmedCapturedRevenuePence(r);
    if (amt == null) continue;
    revenue = (revenue ?? 0) + amt;
  }

  let authorised: number | null = null;
  for (const r of activeHoldRows) {
    if (r.authorised_amount_pence == null) continue;
    const n = Number(r.authorised_amount_pence);
    if (!Number.isFinite(n)) continue;
    authorised = (authorised ?? 0) + Math.round(n);
  }

  // At Risk / RED = unresolved human-action exposure only (not auto-recovering).
  let moneyAtRisk: number | null = null;
  let activeActionRequired = 0;
  let automaticallyRecovering = 0;
  let automaticallyRecovered = 0;
  let cancelledByCustomer = 0;
  let testSandbox = 0;
  let historicalEvidence = 0;

  for (const r of rows) {
    const tripStatus = (r as { trip_status?: string | null }).trip_status ?? null;
    const purpose = String((r as { purpose?: string | null }).purpose ?? "").toLowerCase();
    const bucket = classifyPaymentHoldOperationalBucket({
      attentionClass: (r.attention_class ?? "UNKNOWN_PROVIDER_STATE") as PaymentHoldAttentionClass,
      classification: (r.classification ?? "GREEN") as "GREEN" | "AMBER" | "RED",
      tripStatus,
      purposeLegacy: purpose === "legacy_evidence",
      purposeSaveCard: purpose === "save_card",
    });
    switch (bucket) {
      case "ACTIVE_ACTION_REQUIRED":
        activeActionRequired += 1;
        break;
      case "AUTOMATICALLY_RECOVERING":
        automaticallyRecovering += 1;
        break;
      case "AUTOMATICALLY_RECOVERED":
        automaticallyRecovered += 1;
        break;
      case "CANCELLED_BY_CUSTOMER":
        cancelledByCustomer += 1;
        break;
      case "TEST_SANDBOX":
        testSandbox += 1;
        break;
      default:
        historicalEvidence += 1;
        break;
    }
  }

  for (const r of activeHoldRows) {
    if (r.classification !== "RED") continue;
    if (!moneyAtRiskInclude({
      attentionClass: (r.attention_class ?? "UNKNOWN_PROVIDER_STATE") as PaymentHoldAttentionClass,
      providerState: mapRevolutProviderHoldState(
        (r as { provider_order_state?: string | null }).provider_order_state
          ?? (r as { provider_state?: string | null }).provider_state,
      ),
      amountPence: r.authorised_amount_pence == null ? null : Number(r.authorised_amount_pence),
      classification: "RED",
    })) {
      continue;
    }
    const n = Number(r.authorised_amount_pence);
    if (!Number.isFinite(n)) continue;
    moneyAtRisk = (moneyAtRisk ?? 0) + Math.round(n);
  }

  const captureAttempts = capturedRows.length + captureFailed.length;
  const captureSuccessRate = captureAttempts > 0
    ? Math.round((capturedRows.length / captureAttempts) * 1000) / 10
    : null;

  return {
    total: rows.length,
    active_hold_count: activeHoldRows.length,
    active_hold_amount_pence: authorised,
    captured_count: capturedRows.length,
    released_count: releasedRows.length,
    refunded_count: refundedRows.length,
    failed_recovery_count: failedRecovery.length,
    recovery_pending_count: recoveryPending.length,
    provider_fees_pending_count: feesPending.length,
    total_customer_revenue_captured_pence: revenue,
    total_authorised_pence: authorised,
    capture_success_rate_pct: captureSuccessRate,
    money_at_risk_pence: moneyAtRisk,
    // RED KPI = human action required only
    red: activeActionRequired,
    amber: automaticallyRecovering,
    green: rows.filter((r) => r.classification === "GREEN").length,
    unknown_count: rows.filter((r) =>
      String(r.attention_class ?? "").includes("UNKNOWN")
      || String(r.classification ?? "") === "UNKNOWN"
    ).length,
    active_action_required_count: activeActionRequired,
    automatically_recovering_count: automaticallyRecovering,
    automatically_recovered_count: automaticallyRecovered,
    cancelled_by_customer_count: cancelledByCustomer,
    test_sandbox_count: testSandbox,
    historical_evidence_count: historicalEvidence,
    provider_captured_total_pence: revenue,
    completed_trip_fare_total_pence: null,
    matched_trips_count: null,
    capture_shortfall_pence: null,
    overcaptured_amount_pence: null,
    gross_overcapture_pence: null,
    resolved_overcapture_pence: null,
    outstanding_customer_overcharge_pence: null,
    refund_beyond_gross_overcapture_pence: null,
    fr_match_chips_available: false,
    fr_match_chips_message:
      "FR does not persist per-session match for Payment Sessions. Open Financial Reconciliation for audit conclusions.",
    missing_payment_sessions_count: 0,
    released_buffer_total_pence: null,
    refunded_total_pence: null,
    provider_fees_total_pence: null,
    gross_onecab_commission_pence: null,
    net_onecab_commission_pence: null,
    driver_net_total_pence: null,
  };
}
