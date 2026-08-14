/**
 * Canonical fee decision owner for terminal NON-COMPLETED trips.
 *
 * Precedence (exactly one winner):
 *   CUSTOMER_NO_SHOW
 *   > ARRIVAL_CANCELLATION_FEE
 *   > LATE_PASSENGER_CANCELLATION
 *   > OTHER_CANCELLATION_FEE  (existing grace-based cancellation_fee_pence)
 *   > NO_FEE_FULL_RELEASE
 *
 * Completed-trip settlement is out of scope — callers must skip completed trips.
 * Amounts and thresholds come only from fare_pricing_settings / trip evidence.
 * Nothing is hard-coded here.
 */

export type TerminalFeeDispositionReason =
  | "CUSTOMER_NO_SHOW"
  | "ARRIVAL_CANCELLATION_FEE"
  | "LATE_PASSENGER_CANCELLATION"
  | "OTHER_CANCELLATION_FEE"
  | "NO_FEE_FULL_RELEASE"
  | "SKIP_COMPLETED"
  | "SKIP_ACTIVE_OR_REMATCH"
  | "SKIP_STARTED_MISSING_INTERRUPTED_POLICY"
  | "INCOMPLETE_EVIDENCE_FULL_RELEASE";

export type FeeType =
  | "none"
  | "customer_no_show"
  | "arrival_cancellation"
  | "late_passenger_cancellation"
  | "cancellation";

/** Admin fare_pricing_settings columns used for disposition (no invented defaults). */
export type FarePricingFeeConfig = {
  cancellation_fee_pence: number | null;
  cancellation_grace_period_minutes: number | null;
  cancellation_apply_after_arrival_only: boolean | null;
  no_show_fee_pence: number | null;
  no_show_wait_time_minutes: number | null;
  no_show_apply_after_arrival_only: boolean | null;
  late_cancel_enabled: boolean | null;
  late_cancel_threshold_minutes: number | null;
  late_cancel_fee_pence: number | null;
  arrival_cancellation_enabled: boolean | null;
  arrival_cancellation_fee_pence: number | null;
  arrival_cancellation_apply_after_free_waiting_expired: boolean | null;
  arrival_cancellation_after_arrival_only: boolean | null;
  free_waiting_minutes: number | null;
};

export type TerminalTripEvidence = {
  trip_id: string;
  trip_status: string | null;
  started_at: string | null;
  arrived_at: string | null;
  free_wait_expires_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  scheduled_at: string | null;
  cancellation_grace_expires_at: string | null;
  driver_id: string | null;
  confirmed_driver_id: string | null;
  /** Backend-authoritative: trip.status === 'no_show' or writer-confirmed flag. */
  no_show_recorded: boolean;
  authorised_amount_pence: number;
  previously_captured_amount_pence: number;
  payment_session_id: string | null;
  provider: string;
  /** Decision clock — backend now / cancelled_at; never device clock. */
  decision_at?: string | null;
};

export type TerminalPaymentDecision = {
  disposition_reason: TerminalFeeDispositionReason;
  fee_policy_id: string | null;
  fee_type: FeeType;
  fee_amount_pence: number;
  authorised_amount_pence: number;
  previously_captured_amount_pence: number;
  capture_required_pence: number;
  release_required_pence: number;
  trip_status: string;
  terminal_reason: string;
  provider: string;
  decision_evidence: Record<string, unknown>;
  idempotency_key: string;
  /** Provider action implied by this decision. */
  provider_action: "void_full" | "partial_capture_fee" | "skip" | "reconcile_only";
};

const TERMINAL_NON_COMPLETED = new Set([
  "cancelled",
  "canceled",
  "customer_cancelled",
  "driver_cancelled",
  "expired",
  "expired_no_driver",
  "no_show",
  "failed",
  "declined",
]);

const KEEP_AUTH = new Set([
  "searching",
  "searching_new_driver",
  "broadcasting",
  "offered",
  "offering",
  "negotiating",
  "pending",
  "payment_pending",
  "driver_assigned",
  "assigned",
  "accepted",
  "confirmed",
  "queued",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "enroute_to_pickup",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "waiting_at_pickup",
  "driver_arrived",
  "in_progress",
  "started",
  "on_trip",
  "ongoing",
  "trip_started",
  "completing",
  "passenger_onboard",
  "scheduled",
  "scheduled_committed",
]);

const DISPOSITION_VERSION = "v1";

function normalizeStatus(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase().replace(/-/g, "_");
}

function pence(n: number | null | undefined): number {
  const v = Math.round(Number(n ?? 0));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function isCustomerInitiatedCancel(cancelledBy: string | null | undefined): boolean {
  const by = String(cancelledBy ?? "").toLowerCase();
  return by === "rider" || by === "customer" || by === "passenger" || by === "admin";
}

function isDriverInitiatedNonNoShow(
  cancelledBy: string | null | undefined,
  noShowRecorded: boolean,
): boolean {
  const by = String(cancelledBy ?? "").toLowerCase();
  return by === "driver" && !noShowRecorded;
}

/**
 * Resolve free-waiting expiry from trip stamp or arrived_at + configured minutes.
 * Returns null when evidence is incomplete (do not invent).
 */
export function resolveFreeWaitingExpiresAtMs(args: {
  arrived_at: string | null;
  free_wait_expires_at: string | null;
  free_waiting_minutes: number | null;
}): number | null {
  const stamped = parseMs(args.free_wait_expires_at);
  if (stamped != null) return stamped;
  const arrived = parseMs(args.arrived_at);
  if (arrived == null) return null;
  if (args.free_waiting_minutes == null) return null;
  const minutes = Number(args.free_waiting_minutes);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return arrived + minutes * 60_000;
}

function buildDecision(args: {
  reason: TerminalFeeDispositionReason;
  feeType: FeeType;
  feeAmount: number;
  evidence: TerminalTripEvidence;
  terminalReason: string;
  providerAction: TerminalPaymentDecision["provider_action"];
  feePolicyId?: string | null;
  extraEvidence?: Record<string, unknown>;
}): TerminalPaymentDecision {
  const auth = Math.max(0, Math.round(args.evidence.authorised_amount_pence));
  const prior = Math.max(0, Math.round(args.evidence.previously_captured_amount_pence));
  const remaining = Math.max(0, auth - prior);
  const fee = Math.min(Math.max(0, Math.round(args.feeAmount)), remaining);
  const capture = args.providerAction === "partial_capture_fee" ? fee : 0;
  const release = args.providerAction === "skip" ? 0 : Math.max(0, remaining - capture);
  const status = normalizeStatus(args.evidence.trip_status) || "unknown";
  const sessionPart = args.evidence.payment_session_id ?? "no-session";
  return {
    disposition_reason: args.reason,
    fee_policy_id: args.feePolicyId ?? null,
    fee_type: args.feeType,
    fee_amount_pence: fee,
    authorised_amount_pence: auth,
    previously_captured_amount_pence: prior,
    capture_required_pence: capture,
    release_required_pence: release,
    trip_status: status,
    terminal_reason: args.terminalReason,
    provider: args.evidence.provider,
    decision_evidence: {
      disposition_version: DISPOSITION_VERSION,
      ...args.extraEvidence,
    },
    idempotency_key: `${DISPOSITION_VERSION}:${args.evidence.trip_id}:${sessionPart}:${args.reason}`,
    provider_action: args.providerAction,
  };
}

/**
 * Pure canonical fee resolver. Callers must supply fare_pricing_settings + trip evidence.
 */
export function resolveTerminalPaymentDecision(args: {
  evidence: TerminalTripEvidence;
  config: FarePricingFeeConfig | null;
  feePolicyId?: string | null;
}): TerminalPaymentDecision {
  const { evidence, config } = args;
  const status = normalizeStatus(evidence.trip_status);
  const decisionAtMs = parseMs(evidence.decision_at) ?? parseMs(evidence.cancelled_at) ?? Date.now();

  if (status === "completed") {
    return buildDecision({
      reason: "SKIP_COMPLETED",
      feeType: "none",
      feeAmount: 0,
      evidence,
      terminalReason: "completed_trip",
      providerAction: "skip",
      feePolicyId: args.feePolicyId,
    });
  }

  if (KEEP_AUTH.has(status) && !TERMINAL_NON_COMPLETED.has(status)) {
    return buildDecision({
      reason: "SKIP_ACTIVE_OR_REMATCH",
      feeType: "none",
      feeAmount: 0,
      evidence,
      terminalReason: `status=${status}`,
      providerAction: "skip",
      feePolicyId: args.feePolicyId,
    });
  }

  if (!TERMINAL_NON_COMPLETED.has(status)) {
    return buildDecision({
      reason: "SKIP_ACTIVE_OR_REMATCH",
      feeType: "none",
      feeAmount: 0,
      evidence,
      terminalReason: `non_terminal=${status}`,
      providerAction: "skip",
      feePolicyId: args.feePolicyId,
    });
  }

  // Start Trip occurred but trip is not completed — do not invent interrupted-trip policy.
  if (evidence.started_at) {
    return buildDecision({
      reason: "SKIP_STARTED_MISSING_INTERRUPTED_POLICY",
      feeType: "none",
      feeAmount: 0,
      evidence,
      terminalReason: "started_at_set_missing_interrupted_trip_policy",
      providerAction: "skip",
      feePolicyId: args.feePolicyId,
      extraEvidence: { started_at: evidence.started_at },
    });
  }

  if (!config) {
    return buildDecision({
      reason: "INCOMPLETE_EVIDENCE_FULL_RELEASE",
      feeType: "none",
      feeAmount: 0,
      evidence,
      terminalReason: "missing_fare_pricing_settings",
      providerAction: "void_full",
      feePolicyId: args.feePolicyId,
    });
  }

  const noShowRecorded = evidence.no_show_recorded || status === "no_show";

  // ── 1. CUSTOMER_NO_SHOW ──────────────────────────────────────────
  if (noShowRecorded) {
    const fee = pence(config.no_show_fee_pence);
    return buildDecision({
      reason: "CUSTOMER_NO_SHOW",
      feeType: fee > 0 ? "customer_no_show" : "none",
      feeAmount: fee,
      evidence,
      terminalReason: "customer_no_show",
      providerAction: fee > 0 ? "partial_capture_fee" : "void_full",
      feePolicyId: args.feePolicyId,
      extraEvidence: {
        no_show_fee_pence: config.no_show_fee_pence,
        no_show_wait_time_minutes: config.no_show_wait_time_minutes,
        arrived_at: evidence.arrived_at,
      },
    });
  }

  // Driver-initiated terminal cancel (not no-show): never charge customer cancel fees.
  if (isDriverInitiatedNonNoShow(evidence.cancelled_by, noShowRecorded)) {
    return buildDecision({
      reason: "NO_FEE_FULL_RELEASE",
      feeType: "none",
      feeAmount: 0,
      evidence,
      terminalReason: "driver_cancel_terminal",
      providerAction: "void_full",
      feePolicyId: args.feePolicyId,
    });
  }

  const customerCancel = isCustomerInitiatedCancel(evidence.cancelled_by);
  const cancelledAtMs = parseMs(evidence.cancelled_at) ?? decisionAtMs;
  const arrivedAtMs = parseMs(evidence.arrived_at);
  const driverWasAssigned = !!(evidence.driver_id || evidence.confirmed_driver_id);

  // ── 2. ARRIVAL_CANCELLATION_FEE ───────────────────────────────────
  if (
    customerCancel &&
    config.arrival_cancellation_enabled === true &&
    status !== "expired" &&
    status !== "expired_no_driver" &&
    status !== "failed" &&
    status !== "declined"
  ) {
    const requireArrival = config.arrival_cancellation_after_arrival_only !== false;
    const requireFreeWaitExpired =
      config.arrival_cancellation_apply_after_free_waiting_expired !== false;

    if (requireArrival && arrivedAtMs == null) {
      // Missing arrival evidence → do not apply arrival fee; fall through.
    } else if (!requireArrival || arrivedAtMs != null) {
      const freeExpiresMs = resolveFreeWaitingExpiresAtMs({
        arrived_at: evidence.arrived_at,
        free_wait_expires_at: evidence.free_wait_expires_at,
        free_waiting_minutes: config.free_waiting_minutes,
      });

      if (requireFreeWaitExpired && freeExpiresMs == null) {
        return buildDecision({
          reason: "INCOMPLETE_EVIDENCE_FULL_RELEASE",
          feeType: "none",
          feeAmount: 0,
          evidence,
          terminalReason: "arrival_fee_incomplete_free_wait_evidence",
          providerAction: "void_full",
          feePolicyId: args.feePolicyId,
          extraEvidence: {
            arrived_at: evidence.arrived_at,
            free_wait_expires_at: evidence.free_wait_expires_at,
            free_waiting_minutes: config.free_waiting_minutes,
          },
        });
      }

      const freeWaitExpired =
        !requireFreeWaitExpired ||
        (freeExpiresMs != null && cancelledAtMs >= freeExpiresMs);

      // Boundary: cancelled_at >= free_waiting_expires_at qualifies.
      if (freeWaitExpired && arrivedAtMs != null && cancelledAtMs >= arrivedAtMs) {
        const fee = pence(config.arrival_cancellation_fee_pence);
        if (fee > 0) {
          return buildDecision({
            reason: "ARRIVAL_CANCELLATION_FEE",
            feeType: "arrival_cancellation",
            feeAmount: fee,
            evidence,
            terminalReason: "arrival_cancellation_fee",
            providerAction: "partial_capture_fee",
            feePolicyId: args.feePolicyId,
            extraEvidence: {
              arrived_at: evidence.arrived_at,
              free_wait_expires_at_ms: freeExpiresMs,
              cancelled_at_ms: cancelledAtMs,
              arrival_cancellation_fee_pence: config.arrival_cancellation_fee_pence,
            },
          });
        }
      }
    }
  }

  // ── 3. LATE_PASSENGER_CANCELLATION ────────────────────────────────
  if (
    customerCancel &&
    config.late_cancel_enabled === true &&
    evidence.scheduled_at
  ) {
    const scheduledMs = parseMs(evidence.scheduled_at);
    const thresholdMin = Number(config.late_cancel_threshold_minutes);
    if (
      scheduledMs != null &&
      Number.isFinite(thresholdMin) &&
      thresholdMin >= 0
    ) {
      const minutesToPickup = (scheduledMs - cancelledAtMs) / 60_000;
      if (minutesToPickup <= thresholdMin) {
        const fee = pence(config.late_cancel_fee_pence);
        return buildDecision({
          reason: "LATE_PASSENGER_CANCELLATION",
          feeType: fee > 0 ? "late_passenger_cancellation" : "none",
          feeAmount: fee,
          evidence,
          terminalReason: "late_passenger_cancellation",
          providerAction: fee > 0 ? "partial_capture_fee" : "void_full",
          feePolicyId: args.feePolicyId,
          extraEvidence: {
            scheduled_at: evidence.scheduled_at,
            minutes_to_pickup: minutesToPickup,
            late_cancel_threshold_minutes: thresholdMin,
            late_cancel_fee_pence: config.late_cancel_fee_pence,
          },
        });
      }
    }
  }

  // ── 4. OTHER_CANCELLATION_FEE (existing grace-based cancellation) ─
  if (customerCancel && (status === "cancelled" || status === "canceled" || status === "customer_cancelled")) {
    const cancelFee = pence(config.cancellation_fee_pence);
    const applyAfterArrivalOnly = config.cancellation_apply_after_arrival_only === true;

    if (!driverWasAssigned) {
      // searching / no driver — free
    } else if (applyAfterArrivalOnly && arrivedAtMs == null) {
      // pre-arrival free when policy says after-arrival-only
    } else if (arrivedAtMs == null) {
      // Pre-arrival — mirrors cancel-trip: within grace → 0; else cancellation_fee_pence.
      const graceMs = parseMs(evidence.cancellation_grace_expires_at);
      const withinGrace = graceMs != null && cancelledAtMs <= graceMs;
      if (!withinGrace && cancelFee > 0) {
        return buildDecision({
          reason: "OTHER_CANCELLATION_FEE",
          feeType: "cancellation",
          feeAmount: cancelFee,
          evidence,
          terminalReason: withinGrace ? "post_booking_grace" : "cancelled_after_grace",
          providerAction: "partial_capture_fee",
          feePolicyId: args.feePolicyId,
          extraEvidence: {
            cancellation_grace_expires_at: evidence.cancellation_grace_expires_at,
            cancellation_fee_pence: config.cancellation_fee_pence,
          },
        });
      }
    } else {
      // Post-arrival but arrival-cancellation did not win (disabled / still in free wait).
      // Existing policy: within cancellation_grace_expires_at → 0; else cancellation_fee_pence.
      const graceMs = parseMs(evidence.cancellation_grace_expires_at);
      const withinGrace = graceMs != null && cancelledAtMs <= graceMs;
      if (!withinGrace && cancelFee > 0) {
        return buildDecision({
          reason: "OTHER_CANCELLATION_FEE",
          feeType: "cancellation",
          feeAmount: cancelFee,
          evidence,
          terminalReason: "cancelled_after_arrival_grace",
          providerAction: "partial_capture_fee",
          feePolicyId: args.feePolicyId,
          extraEvidence: {
            cancellation_grace_expires_at: evidence.cancellation_grace_expires_at,
            cancellation_fee_pence: config.cancellation_fee_pence,
            arrived_at: evidence.arrived_at,
          },
        });
      }
    }
  }

  // ── 5. NO_FEE_FULL_RELEASE ────────────────────────────────────────
  return buildDecision({
    reason: "NO_FEE_FULL_RELEASE",
    feeType: "none",
    feeAmount: 0,
    evidence,
    terminalReason: status.startsWith("expired")
      ? "search_or_rematch_expired"
      : "terminal_no_approved_fee",
    providerAction: "void_full",
    feePolicyId: args.feePolicyId,
  });
}

/** Validate no-show writer eligibility using existing fare_pricing_settings rules. */
export function validateCustomerNoShowEligibility(args: {
  arrived_at: string | null;
  no_show_apply_after_arrival_only: boolean | null;
  no_show_wait_time_minutes: number | null;
  nowMs?: number;
}): { ok: true } | { ok: false; message: string } {
  const applyAfterArrival = args.no_show_apply_after_arrival_only !== false;
  if (applyAfterArrival && !args.arrived_at) {
    return { ok: false, message: "No-show can only be triggered after driver arrival" };
  }
  const waitMin = Number(args.no_show_wait_time_minutes);
  if (args.arrived_at && Number.isFinite(waitMin) && waitMin > 0) {
    const arrivedMs = parseMs(args.arrived_at);
    if (arrivedMs == null) {
      return { ok: false, message: "Invalid arrived_at for no-show eligibility" };
    }
    const nowMs = args.nowMs ?? Date.now();
    const waitedMinutes = (nowMs - arrivedMs) / 60_000;
    if (waitedMinutes < waitMin) {
      return {
        ok: false,
        message: `Must wait ${waitMin} minutes before no-show. Waited: ${Math.floor(waitedMinutes)} min`,
      };
    }
  }
  return { ok: true };
}
