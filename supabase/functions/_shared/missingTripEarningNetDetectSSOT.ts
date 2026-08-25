/**
 * Detect-only: PLATFORM_COLLECTED captures missing TRIP_EARNING_NET.
 * Audit breadcrumbs on financial_ssot_mismatches only — never wallet / PS / provider / payout money.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  isChargedFeeOutcome,
  isNonCompletedTerminalTripStatus,
  readKnownProviderFeePence,
  resolveAssignedDriverId,
  resolveChargedTerminalFeeEntitlement,
  resolveUnambiguousEvidenceDriverId,
} from "./chargedTerminalFeeWalletSSOT.ts";

export const MISSING_TEN_DETECT_LOOKBACK_DAYS = 60;
export const MISSING_TEN_STAGE = "missing_trip_earning_net";
export const MISSING_TEN_FIELD = "TRIP_EARNING_NET";

export const MISSING_TEN_CLASS = {
  AUTHORITATIVE_ENTITLEMENT_MISSING_TEN: "AUTHORITATIVE_ENTITLEMENT_MISSING_TEN",
  /** Captured terminal fee + ACTUAL provider fee + known driver; TEN missing. */
  AUTHORITATIVE_MISSING_TERMINAL_FEE_TEN: "AUTHORITATIVE_MISSING_TERMINAL_FEE_TEN",
  PENDING_EVIDENCE_MISSING_TEN: "PENDING_EVIDENCE_MISSING_TEN",
  /** Captured terminal fee + ACTUAL provider fee but assignee unknown after cancel clear. */
  PENDING_EVIDENCE_MISSING_DRIVER: "PENDING_EVIDENCE_MISSING_DRIVER",
  PAYMENT_SESSION_MISSING: "PAYMENT_SESSION_MISSING",
  CAPTURE_AMBIGUOUS: "CAPTURE_AMBIGUOUS",
  /** Captured terminal fee but PS provider_processing_fee_pence unknown — fail closed. */
  PROVIDER_FEE_UNKNOWN: "PROVIDER_FEE_UNKNOWN",
  /** Captured − provider fee ≤ 0 — fail closed; do not invent TEN. */
  FEE_NET_NON_POSITIVE: "FEE_NET_NON_POSITIVE",
} as const;

export type MissingTenClass = typeof MISSING_TEN_CLASS[keyof typeof MISSING_TEN_CLASS];

export type MissingTenCandidate = {
  trip_id: string;
  trip_code: string | null;
  driver_id: string | null;
  financial_model: string;
  trip_status: string;
  classification: MissingTenClass;
  /** Saved stamp only — never inferred. Null when PENDING_EVIDENCE. */
  authoritative_amount_pence: number | null;
  ten_count: number;
  ride_booking_count: number;
  payment_session_id: string | null;
  provider_state: string | null;
  provider_order_id: string | null;
  provider_capture_id: string | null;
  captured_amount_pence: number | null;
  captured_at: string | null;
  reason: string;
  proposed_mismatch_key: {
    trip_id: string;
    stage: typeof MISSING_TEN_STAGE;
    field_name: typeof MISSING_TEN_FIELD;
  };
};

type TripScanRow = {
  id: string;
  trip_code: string | null;
  status: string;
  financial_model: string;
  driver_id: string | null;
  confirmed_driver_id?: string | null;
  accepted_ride_offer_id?: string | null;
  driver_net_pence: number | null;
  completed_at: string | null;
  financial_outcome?: string | null;
  no_show_charge_pence?: number | null;
  cancellation_fee_pence?: number | null;
  late_cancel_fee_pence?: number | null;
  cancelled_at?: string | null;
};

type PsRow = {
  id: string;
  status: string | null;
  provider_state: string | null;
  provider_order_id: string | null;
  provider_capture_id: string | null;
  captured_amount_pence: number | null;
  captured_at: string | null;
  financial_operation_state: string | null;
  released_amount_pence: number | null;
  refunded_amount_pence: number | null;
  provider_processing_fee_pence?: number | null;
  fee_status?: string | null;
};

export function isPlatformCollected(model: string | null | undefined): boolean {
  return String(model ?? "") === "PLATFORM_COLLECTED";
}

export function isDriverCollected(model: string | null | undefined): boolean {
  const m = String(model ?? "");
  return m === "DRIVER_COLLECTED" || m === "DRIVER_COLLECTED_COMMISSION_WALLET";
}

/** Provider money looks captured (not fully released/refunded). Fail closed on ambiguity. */
export function sessionLooksCaptured(ps: PsRow): boolean {
  const refunded = Math.round(Number(ps.refunded_amount_pence) || 0);
  if (refunded > 0) return false;

  const capturedAmt = Math.round(Number(ps.captured_amount_pence) || 0);
  const released = Math.round(Number(ps.released_amount_pence) || 0);
  const status = String(ps.status ?? "");
  const providerState = String(ps.provider_state ?? "");
  const fos = String(ps.financial_operation_state ?? "");
  const isTerminalReleaseStatus =
    status === "released" || status === "cancelled" || status === "failed";

  // Partial fee capture: status/fos stay captured while remainder is released.
  if (capturedAmt > 0 && (status === "captured" || fos === "CAPTURED")) {
    // Full unwind of a prior capture (release ≥ capture on terminal release status).
    if (isTerminalReleaseStatus && released >= capturedAmt) return false;
    return true;
  }

  // Broken/legacy fee-capture rows (e.g. status still dispatching) with provider COMPLETED + fee amount.
  if (
    capturedAmt > 0 &&
    providerState === "COMPLETED" &&
    !isTerminalReleaseStatus
  ) {
    return true;
  }

  return false;
}

/**
 * Terminal non-capture: customer was not successfully charged on this RIDE_BOOKING.
 * These are not missing-TEN candidates (no platform collection to settle as TEN).
 * Do not use ordering/limit to pick among sessions — caller must already have exactly one.
 */
export function sessionIsTerminalNonCapture(ps: PsRow): boolean {
  if (sessionLooksCaptured(ps)) return false;
  const released = Math.round(Number(ps.released_amount_pence) || 0);
  const refunded = Math.round(Number(ps.refunded_amount_pence) || 0);
  if (released > 0 || refunded > 0) return true;
  const status = String(ps.status ?? "");
  if (status === "released" || status === "cancelled" || status === "failed") return true;
  const capturedAmt = Math.round(Number(ps.captured_amount_pence) || 0);
  const providerState = String(ps.provider_state ?? "").toUpperCase();
  if (
    capturedAmt <= 0 &&
    (providerState === "CANCELLED" || providerState === "FAILED" || providerState === "EXPIRED")
  ) {
    return true;
  }
  return false;
}

export function classifyMissingTen(args: {
  financialModel: string | null | undefined;
  tripStatus: string | null | undefined;
  driverId: string | null | undefined;
  driverNetPence: number | null | undefined;
  tenCount: number;
  rideBookingSessions: PsRow[];
  /** NO_SHOW | LATE_PASSENGER_CANCELLATION | AIRPORT_PROTECTION_CANCELLATION | CANCELLED_WITH_FEE | … */
  financialOutcome?: string | null;
  noShowChargePence?: number | null;
  cancellationFeePence?: number | null;
  lateCancelFeePence?: number | null;
}): { classification: MissingTenClass; authoritative_amount_pence: number | null; reason: string } | null {
  if (isDriverCollected(args.financialModel)) return null;
  if (!isPlatformCollected(args.financialModel)) return null;
  if (args.tenCount > 0) return null;

  const status = String(args.tripStatus ?? "");
  const outcome = String(args.financialOutcome ?? "");
  const isCompletedRide = status === "completed";
  const feeStamp =
    Math.max(
      Math.round(Number(args.noShowChargePence) || 0),
      Math.round(Number(args.cancellationFeePence) || 0),
      Math.round(Number(args.lateCancelFeePence) || 0),
    );
  // Any non-completed terminal with a charged outcome / fee stamp / cancelled|no_show status
  // may carry a provider-captured terminal fee (TEN = fee − provider fee, commission 0).
  const isChargedFeeTerminal =
    !isCompletedRide &&
    (isChargedFeeOutcome(outcome) ||
      isNonCompletedTerminalTripStatus(status) ||
      feeStamp > 0);

  // Zero-fee / non-completed non-fee terminals are not missing-TEN candidates.
  if (!isCompletedRide && !isChargedFeeTerminal) return null;

  const sessions = args.rideBookingSessions;
  const driverId = typeof args.driverId === "string" && args.driverId.trim()
    ? args.driverId.trim()
    : null;

  // ── Charged terminal fee: provider-fee class BEFORE requiring persisted driver ──
  // Cancel triggers may null trips.driver_id; wallet fail-closed still used in-memory driver.
  if (isChargedFeeTerminal && !isCompletedRide) {
    if (sessions.length === 0) {
      return {
        classification: MISSING_TEN_CLASS.PAYMENT_SESSION_MISSING,
        authoritative_amount_pence: null,
        reason: "PLATFORM_COLLECTED terminal-fee trip has zero RIDE_BOOKING Payment Sessions",
      };
    }
    if (sessions.length !== 1) {
      return {
        classification: MISSING_TEN_CLASS.CAPTURE_AMBIGUOUS,
        authoritative_amount_pence: null,
        reason: `Ambiguous RIDE_BOOKING count=${sessions.length}; fail closed`,
      };
    }
    const ps = sessions[0];
    if (!sessionLooksCaptured(ps)) {
      if (sessionIsTerminalNonCapture(ps)) return null;
      return {
        classification: MISSING_TEN_CLASS.CAPTURE_AMBIGUOUS,
        authoritative_amount_pence: null,
        reason: "Single RIDE_BOOKING present but capture/provider evidence not verified; fail closed",
      };
    }

    const captured = Math.round(Number(ps.captured_amount_pence) || 0);
    const feeGross = captured > 0 ? captured : feeStamp;
    if (feeGross <= 0) {
      return {
        classification: MISSING_TEN_CLASS.PENDING_EVIDENCE_MISSING_TEN,
        authoritative_amount_pence: null,
        reason: "Terminal fee trip captured evidence missing fee amount stamp",
      };
    }

    const providerFee = readKnownProviderFeePence(ps.provider_processing_fee_pence);
    const entitlement = resolveChargedTerminalFeeEntitlement({
      outcome: isChargedFeeOutcome(outcome) ? outcome : "CANCELLED_WITH_FEE",
      feePence: feeGross,
      providerFeePence: providerFee,
      feeStatus: ps.fee_status,
    });

    // Unknown provider fee → PROVIDER_FEE_UNKNOWN even when cancel cleared driver_id.
    if (!entitlement.ok && entitlement.reason === "provider_fee_unknown") {
      return {
        classification: MISSING_TEN_CLASS.PROVIDER_FEE_UNKNOWN,
        authoritative_amount_pence: null,
        reason:
          "Captured terminal fee with unknown provider fee (pence null or fee_status not ACTUAL); fail closed — do not invent TEN",
      };
    }
    if (!entitlement.ok) {
      if (entitlement.reason === "driver_ten_non_positive") {
        return {
          classification: MISSING_TEN_CLASS.FEE_NET_NON_POSITIVE,
          authoritative_amount_pence: null,
          reason:
            `Captured ${feeGross}p − provider fee ${providerFee}p ≤ 0; fail closed — do not post TEN`,
        };
      }
      return {
        classification: MISSING_TEN_CLASS.PENDING_EVIDENCE_MISSING_TEN,
        authoritative_amount_pence: null,
        reason: `Terminal fee entitlement rejected: ${entitlement.reason}`,
      };
    }

    // Provider fee ACTUAL + positive fee-net — driver required for authoritative TEN FR.
    if (!driverId) {
      return {
        classification: MISSING_TEN_CLASS.PENDING_EVIDENCE_MISSING_DRIVER,
        authoritative_amount_pence: null,
        reason:
          "Captured terminal fee with ACTUAL provider fee but assignee unknown (trip driver cleared; no unambiguous offer/audit evidence) — FR visible; do not invent TEN assignee",
      };
    }

    return {
      classification: MISSING_TEN_CLASS.AUTHORITATIVE_MISSING_TERMINAL_FEE_TEN,
      authoritative_amount_pence: entitlement.driver_net_pence,
      reason:
        `Captured terminal fee with no TRIP_EARNING_NET; entitlement = captured ${entitlement.captured_fee_pence}p − provider fee ${entitlement.provider_fee_pence}p (commission 0)`,
    };
  }

  // ── Completed ride: require assignee + saved driver_net_pence stamp ──
  if (!driverId) return null;

  if (sessions.length === 0) {
    return {
      classification: MISSING_TEN_CLASS.PAYMENT_SESSION_MISSING,
      authoritative_amount_pence: null,
      reason: "PLATFORM_COLLECTED trip has zero RIDE_BOOKING Payment Sessions",
    };
  }
  if (sessions.length !== 1) {
    return {
      classification: MISSING_TEN_CLASS.CAPTURE_AMBIGUOUS,
      authoritative_amount_pence: null,
      reason: `Ambiguous RIDE_BOOKING count=${sessions.length}; fail closed`,
    };
  }
  const ps = sessions[0];
  if (!sessionLooksCaptured(ps)) {
    // Single cancelled/released/failed RIDE_BOOKING → not a missing-TEN liability.
    if (sessionIsTerminalNonCapture(ps)) return null;
    return {
      classification: MISSING_TEN_CLASS.CAPTURE_AMBIGUOUS,
      authoritative_amount_pence: null,
      reason: "Single RIDE_BOOKING present but capture/provider evidence not verified; fail closed",
    };
  }

  const netRaw = args.driverNetPence;
  const net = netRaw == null ? null : Math.round(Number(netRaw));
  if (net == null || !Number.isFinite(net) || net <= 0) {
    return {
      classification: MISSING_TEN_CLASS.PENDING_EVIDENCE_MISSING_TEN,
      authoritative_amount_pence: null,
      reason: "Captured PLATFORM_COLLECTED trip missing saved driver_net_pence stamp; do not invent entitlement",
    };
  }

  return {
    classification: MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN,
    authoritative_amount_pence: net,
    reason: "Saved driver_net_pence present; TRIP_EARNING_NET absent; single verified captured RIDE_BOOKING",
  };
}

function proposedKey(tripId: string) {
  return {
    trip_id: tripId,
    stage: MISSING_TEN_STAGE,
    field_name: MISSING_TEN_FIELD,
  } as const;
}

async function loadRideBookingSessions(
  supabase: SupabaseClient,
  tripId: string,
): Promise<PsRow[]> {
  const { data, error } = await supabase
    .from("payment_sessions")
    .select(
      "id, status, provider_state, provider_order_id, provider_capture_id, captured_amount_pence, captured_at, financial_operation_state, released_amount_pence, refunded_amount_pence, provider_processing_fee_pence, fee_status",
    )
    .eq("trip_id", tripId)
    .eq("purpose", "RIDE_BOOKING")
    .order("created_at", { ascending: true });
  if (error) {
    console.warn("[missingTripEarningNetDetect] PS query failed", tripId, error.message);
    return [];
  }
  return (data ?? []) as PsRow[];
}

async function tenCountForTrip(supabase: SupabaseClient, tripId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from("driver_wallet_ledger")
    .select("id", { count: "exact", head: true })
    .eq("related_trip_id", tripId)
    .eq("type", "TRIP_EARNING_NET");
  if (error) {
    console.warn("[missingTripEarningNetDetect] TEN count failed", tripId, error.message);
    return null;
  }
  return count ?? 0;
}

/**
 * FR-detect only: recover assignee after cancel clears trips.driver_id.
 * Uses linked/accepted offers + unambiguous assignment dispatch events.
 * Never posts wallet money.
 */
async function loadFrDetectAssignmentEvidenceIds(
  supabase: SupabaseClient,
  trip: TripScanRow,
): Promise<string[]> {
  const evidence: string[] = [];

  const linkedOfferId = typeof trip.accepted_ride_offer_id === "string" &&
      trip.accepted_ride_offer_id.trim()
    ? trip.accepted_ride_offer_id.trim()
    : null;
  if (linkedOfferId) {
    const { data: linked, error } = await supabase
      .from("ride_offers")
      .select("driver_id")
      .eq("id", linkedOfferId)
      .eq("trip_id", trip.id)
      .maybeSingle();
    if (!error && linked?.driver_id) evidence.push(String(linked.driver_id));
  }

  const { data: acceptedOffers, error: acceptErr } = await supabase
    .from("ride_offers")
    .select("driver_id")
    .eq("trip_id", trip.id)
    .eq("status", "accepted");
  if (!acceptErr) {
    for (const row of acceptedOffers ?? []) {
      if (row?.driver_id) evidence.push(String(row.driver_id));
    }
  }

  const { data: auditRows, error: auditErr } = await supabase
    .from("dispatch_audit_log")
    .select("driver_id, event_type")
    .eq("trip_id", trip.id)
    .not("driver_id", "is", null)
    .in("event_type", [
      "offer_accepted",
      "ride_accepted",
      "driver_assigned",
      "assigned",
      "assignment",
      "trip_assigned",
    ])
    .limit(20);
  if (!auditErr) {
    for (const row of auditRows ?? []) {
      if (row?.driver_id) evidence.push(String(row.driver_id));
    }
  }

  return evidence;
}

async function evaluateTrip(
  supabase: SupabaseClient,
  trip: TripScanRow,
): Promise<MissingTenCandidate | null> {
  const tenCount = await tenCountForTrip(supabase, trip.id);
  if (tenCount == null) return null;
  const sessions = await loadRideBookingSessions(supabase, trip.id);

  const evidenceIds = await loadFrDetectAssignmentEvidenceIds(supabase, trip);
  const evidenceDriverId = resolveUnambiguousEvidenceDriverId(evidenceIds);
  const assignedDriverId = resolveAssignedDriverId({
    driver_id: trip.driver_id,
    confirmed_driver_id: trip.confirmed_driver_id,
    accepted_offer_driver_id: evidenceDriverId,
    assignment_evidence_driver_id: evidenceDriverId,
  });

  const classified = classifyMissingTen({
    financialModel: trip.financial_model,
    tripStatus: trip.status,
    driverId: assignedDriverId,
    driverNetPence: trip.driver_net_pence,
    tenCount,
    rideBookingSessions: sessions,
    financialOutcome: trip.financial_outcome ?? null,
    noShowChargePence: trip.no_show_charge_pence ?? null,
    cancellationFeePence: trip.cancellation_fee_pence ?? null,
    lateCancelFeePence: trip.late_cancel_fee_pence ?? null,
  });
  if (!classified) return null;

  const ps = sessions.length === 1 ? sessions[0] : null;
  return {
    trip_id: trip.id,
    trip_code: trip.trip_code,
    driver_id: assignedDriverId,
    financial_model: trip.financial_model,
    trip_status: trip.status,
    classification: classified.classification,
    authoritative_amount_pence: classified.authoritative_amount_pence,
    ten_count: tenCount,
    ride_booking_count: sessions.length,
    payment_session_id: ps?.id ?? null,
    provider_state: ps?.provider_state ?? null,
    provider_order_id: ps?.provider_order_id ?? null,
    provider_capture_id: ps?.provider_capture_id ?? null,
    captured_amount_pence: ps?.captured_amount_pence ?? null,
    captured_at: ps?.captured_at ?? null,
    reason: classified.reason,
    proposed_mismatch_key: proposedKey(trip.id),
  };
}

export type DetectMissingTenResult = {
  scanned: number;
  candidates: MissingTenCandidate[];
  upserted: number;
  resolved: number;
  dry_run: boolean;
  informational_authoritative_total_pence: number;
};

/**
 * Scan PLATFORM_COLLECTED completed trips in lookback PLUS any historically
 * unresolved missing-TEN mismatch rows (so old unresolved trips are not dropped).
 */
export async function detectMissingTripEarningNet(
  supabase: SupabaseClient,
  options: {
    lookbackDays?: number;
    maxCandidates?: number;
    dryRun?: boolean;
  } = {},
): Promise<DetectMissingTenResult> {
  const lookbackDays = options.lookbackDays ?? MISSING_TEN_DETECT_LOOKBACK_DAYS;
  const maxCandidates = options.maxCandidates ?? 500;
  const dryRun = options.dryRun === true;
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const tripById = new Map<string, TripScanRow>();

  const tripSelect =
    "id, trip_code, status, financial_model, driver_id, confirmed_driver_id, accepted_ride_offer_id, driver_net_pence, completed_at, financial_outcome, no_show_charge_pence, cancellation_fee_pence, late_cancel_fee_pence, cancelled_at, updated_at";

  const { data: recent, error: recentErr } = await supabase
    .from("trips")
    .select(tripSelect)
    .eq("financial_model", "PLATFORM_COLLECTED")
    .eq("status", "completed")
    .not("driver_id", "is", null)
    .gte("completed_at", since)
    .limit(maxCandidates);
  if (recentErr) {
    console.error("[missingTripEarningNetDetect] recent trip query failed:", recentErr.message);
  } else {
    for (const t of (recent ?? []) as TripScanRow[]) tripById.set(String(t.id), t);
  }

  // Charged no-show / late-cancel fee terminals (status != completed) — FR must not be blind.
  // Use updated_at (not only cancelled_at): pickup-no-show clears cancelled_at.
  const { data: feeTerminals, error: feeErr } = await supabase
    .from("trips")
    .select(tripSelect)
    .eq("financial_model", "PLATFORM_COLLECTED")
    .in("status", ["no_show", "cancelled", "canceled", "customer_cancelled"])
    .or(
      "financial_outcome.in.(NO_SHOW,LATE_PASSENGER_CANCELLATION,AIRPORT_PROTECTION_CANCELLATION,CANCELLED_WITH_FEE),no_show_charge_pence.gt.0,cancellation_fee_pence.gt.0,late_cancel_fee_pence.gt.0",
    )
    .gte("updated_at", since)
    .limit(maxCandidates);
  if (feeErr) {
    console.error("[missingTripEarningNetDetect] fee-terminal query failed:", feeErr.message);
  } else {
    for (const t of (feeTerminals ?? []) as TripScanRow[]) tripById.set(String(t.id), t);
  }

  // Retain historical unresolved mismatches beyond lookback.
  const { data: openRows } = await supabase
    .from("financial_ssot_mismatches")
    .select("trip_id")
    .eq("stage", MISSING_TEN_STAGE)
    .eq("field_name", MISSING_TEN_FIELD)
    .is("resolved_at", null)
    .limit(maxCandidates);
  const openIds = [...new Set((openRows ?? []).map((r) => String(r.trip_id)).filter(Boolean))];
  const missingOpen = openIds.filter((id) => !tripById.has(id));
  if (missingOpen.length > 0) {
    const { data: historical } = await supabase
      .from("trips")
      .select(tripSelect)
      .in("id", missingOpen);
    for (const t of (historical ?? []) as TripScanRow[]) tripById.set(String(t.id), t);
  }

  const candidates: MissingTenCandidate[] = [];
  for (const trip of tripById.values()) {
    const c = await evaluateTrip(supabase, trip);
    if (c) candidates.push(c);
  }
  candidates.sort((a, b) => String(a.trip_code ?? a.trip_id).localeCompare(String(b.trip_code ?? b.trip_id)));

  const informationalTotal = candidates
    .filter((c) =>
      c.classification === MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN ||
      c.classification === MISSING_TEN_CLASS.AUTHORITATIVE_MISSING_TERMINAL_FEE_TEN
    )
    .reduce((s, c) => s + (c.authoritative_amount_pence ?? 0), 0);

  if (dryRun) {
    return {
      scanned: tripById.size,
      candidates,
      upserted: 0,
      resolved: 0,
      dry_run: true,
      informational_authoritative_total_pence: informationalTotal,
    };
  }

  let upserted = 0;
  const openCandidateIds = new Set(candidates.map((c) => c.trip_id));
  for (const c of candidates) {
    const expected = c.authoritative_amount_pence ?? 0;
    const { error } = await supabase.from("financial_ssot_mismatches").upsert(
      {
        trip_id: c.trip_id,
        trip_code: c.trip_code,
        stage: MISSING_TEN_STAGE,
        field_name: MISSING_TEN_FIELD,
        expected_pence: expected,
        actual_pence: 0,
        details: {
          classification: c.classification,
          authoritative_amount_pence: c.authoritative_amount_pence,
          driver_id: c.driver_id,
          payment_session_id: c.payment_session_id,
          provider_state: c.provider_state,
          provider_order_id: c.provider_order_id,
          provider_capture_id: c.provider_capture_id,
          captured_amount_pence: c.captured_amount_pence,
          captured_at: c.captured_at,
          ten_count: c.ten_count,
          ride_booking_count: c.ride_booking_count,
          reason: c.reason,
          operational: true,
          detect_only: true,
          never_credit: true,
        },
        detected_at: new Date().toISOString(),
        resolved_at: null,
      },
      { onConflict: "trip_id,stage,field_name" },
    );
    if (!error) upserted++;
    else console.error("[missingTripEarningNetDetect] upsert failed", c.trip_id, error.message);
  }

  // Resolve open mismatches whose condition no longer exists (TEN present / model changed).
  let resolved = 0;
  for (const id of openIds) {
    if (openCandidateIds.has(id)) continue;
    const ten = await tenCountForTrip(supabase, id);
    if (ten == null) continue;
    if (ten >= 1) {
      const { error } = await supabase
        .from("financial_ssot_mismatches")
        .update({ resolved_at: new Date().toISOString() })
        .eq("trip_id", id)
        .eq("stage", MISSING_TEN_STAGE)
        .eq("field_name", MISSING_TEN_FIELD)
        .is("resolved_at", null);
      if (!error) resolved++;
    }
  }

  return {
    scanned: tripById.size,
    candidates,
    upserted,
    resolved,
    dry_run: false,
    informational_authoritative_total_pence: informationalTotal,
  };
}

/**
 * Step 9.2B2 evidence-backed dry-run contract (trip codes).
 * Includes MK-260810-011 (744p). Excludes cancelled/released singles (not missing-TEN).
 */
export const EXPECTED_DRY_RUN_TRIP_CODES = [
  "MK-260805-016",
  "MK-260808-053",
  "MK-260808-054",
  "MK-260810-011",
  "MK-260817-008",
  "MK-260818-001",
] as const;

export function dryRunMatchesExpectedContract(candidates: MissingTenCandidate[]): {
  ok: boolean;
  reason?: string;
} {
  const byCode = new Map(candidates.map((c) => [c.trip_code, c]));
  if (candidates.length !== EXPECTED_DRY_RUN_TRIP_CODES.length) {
    return { ok: false, reason: `expected ${EXPECTED_DRY_RUN_TRIP_CODES.length} candidates, got ${candidates.length}` };
  }
  for (const code of EXPECTED_DRY_RUN_TRIP_CODES) {
    if (!byCode.has(code)) return { ok: false, reason: `missing candidate ${code}` };
  }
  const expectAuth: Record<string, number> = {
    "MK-260805-016": 425,
    "MK-260808-053": 382,
    "MK-260808-054": 670,
    "MK-260810-011": 744,
    "MK-260818-001": 408,
  };
  for (const [code, amt] of Object.entries(expectAuth)) {
    const c = byCode.get(code)!;
    if (c.classification !== MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN) {
      return { ok: false, reason: `${code} expected AUTHORITATIVE, got ${c.classification}` };
    }
    if (c.authoritative_amount_pence !== amt) {
      return { ok: false, reason: `${code} expected ${amt}p, got ${c.authoritative_amount_pence}` };
    }
  }
  const mk008 = byCode.get("MK-260817-008")!;
  if (mk008.classification !== MISSING_TEN_CLASS.PENDING_EVIDENCE_MISSING_TEN) {
    return { ok: false, reason: `MK-008 expected PENDING_EVIDENCE, got ${mk008.classification}` };
  }
  if (mk008.authoritative_amount_pence != null) {
    return { ok: false, reason: "MK-008 must keep null authoritative amount" };
  }
  return { ok: true };
}
