/**
 * CERTIFICATION_NON_PAYABLE — Review & repair classification SSOT.
 *
 * Decision A: store outcome on existing `trips.financial_outcome`
 * (= CERTIFICATION_NON_PAYABLE). Explicit zero settlement stamps for FR;
 * never invent commission_rate=0% (commission does not apply → leave rate NULL).
 *
 * Provider UNKNOWN is bypassed ONLY when every certification guard passes.
 */

export const CERTIFICATION_NON_PAYABLE_OUTCOME = "CERTIFICATION_NON_PAYABLE" as const;

/** Admin action label (exact). */
export const CERTIFICATION_NON_PAYABLE_ACTION_LABEL =
  "Mark verified certification trip as non-payable";

/**
 * Certified board-exclusivity client_action_id prefix.
 * Full form: `cert-board-exclusivity-{trip_uuid}`.
 */
export const CERTIFICATION_CLIENT_ACTION_PREFIX = "cert-board-exclusivity-";

export const CERTIFICATION_PASSENGER_MARKERS = [
  "cert exclusivity",
  "certification",
  "cert passenger",
] as const;

export const CERTIFICATION_ADDRESS_MARKERS = [
  "cert pickup",
  "cert dropoff",
  "certification pickup",
  "certification dropoff",
] as const;

export const CERTIFICATION_NON_PAYABLE_AUDIT_EVENT = {
  MARKED: "CERTIFICATION_NON_PAYABLE_MARKED",
  STALE_PAYMENT_SESSION_LINK_CLEARED: "STALE_PAYMENT_SESSION_LINK_CLEARED",
  RECONCILIATION_RECOMPUTED: "RECONCILIATION_RECOMPUTED",
} as const;

export const CERTIFICATION_NON_PAYABLE_BLOCK = {
  BOOKING_SOURCE: "CERT_BOOKING_SOURCE",
  CLIENT_ACTION_ID: "CERT_CLIENT_ACTION_ID",
  MARKERS: "CERT_MARKERS_MISSING",
  LIFECYCLE: "CERT_LIFECYCLE_INCOMPLETE",
  FARE_NONZERO: "CERT_FARE_NONZERO",
  MONEY_FIELDS: "CERT_MONEY_FIELDS_NONZERO",
  OWNED_PAYMENT_SESSION: "CERT_OWNED_PAYMENT_SESSION",
  PROVIDER_EVIDENCE: "CERT_PROVIDER_EVIDENCE",
  WALLET_OR_PAYOUT: "CERT_WALLET_OR_PAYOUT_EVIDENCE",
  RIDE_OFFER: "CERT_RIDE_OFFER_OR_ENTITLEMENT",
  STALE_LINK_OWNER: "CERT_STALE_SESSION_OWNER_UNPROVEN",
  CONFLICTING_EVIDENCE: "CERT_CONFLICTING_EVIDENCE",
} as const;

export type CertificationNonPayableBlockCode =
  typeof CERTIFICATION_NON_PAYABLE_BLOCK[keyof typeof CERTIFICATION_NON_PAYABLE_BLOCK];

/** Settlement stamps required by FR — rates intentionally omitted (N/A ≠ 0%). */
export const CERTIFICATION_NON_PAYABLE_ZERO_STAMP_COLUMNS: Readonly<
  Record<string, number | string | null>
> = {
  financial_outcome: CERTIFICATION_NON_PAYABLE_OUTCOME,
  driver_net_pence: 0,
  driver_net_before_tip_pence: 0,
  commission_pence: 0,
  tip_pence: 0,
  tip_amount_pence: 0,
  airport_charge_pence: 0,
  final_fare_pence: 0,
  gross_fare_pence: 0,
  commissionable_fare_pence: 0,
  // Explicit: commission does not apply — do NOT write commission_pct / accepted_* / tier = 0
  invoice_payment_classification: CERTIFICATION_NON_PAYABLE_OUTCOME,
  settlement_formula_version: "certification_non_payable_v1",
};

export type CertificationTripEvidence = {
  trip_id: string;
  trip_code?: string | null;
  booking_source?: string | null;
  client_action_id?: string | null;
  passenger_name?: string | null;
  pickup_address?: string | null;
  dropoff_address?: string | null;
  trip_status?: string | null;
  completed_at?: string | null;
  /** Major-unit estimated fare (trips.estimated_fare). */
  estimated_fare?: number | null;
  /** Major-unit fare (trips.fare). */
  fare?: number | null;
  gross_fare_pence?: number | null;
  final_fare_pence?: number | null;
  quoted_fare_pence?: number | null;
  commissionable_fare_pence?: number | null;
  capture_amount_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  waiting_charge_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  airport_charge_pence?: number | null;
  platform_promotion_subsidy_pence?: number | null;
  offer_discount_pence?: number | null;
  voucher_discount_pence?: number | null;
  /** trips.payment_session_id (may wrongly point at another trip's session). */
  trips_payment_session_id?: string | null;
  /** Count of payment_sessions rows where trip_id = this trip. Must be 0. */
  owned_payment_session_count: number;
  /** Owner of trips.payment_session_id when set (payment_sessions.trip_id). */
  linked_session_owner_trip_id?: string | null;
  linked_session_owner_trip_code?: string | null;
  linked_session_provider_order_id?: string | null;
  linked_session_captured_amount_pence?: number | null;
  /** True when a provider order/payment/capture belongs to THIS trip. */
  provider_evidence_for_this_trip: boolean;
  /** TEN / tip / ADMIN wallet correction rows for this trip. */
  wallet_or_admin_correction_count: number;
  /** Payout allocation / item evidence for this trip. */
  payout_allocation_count: number;
  /** Accepted ride offer or other payable entitlement evidence. */
  accepted_ride_offer_count: number;
  existing_driver_net_pence?: number | null;
  existing_commission_pence?: number | null;
  financial_outcome?: string | null;
};

export type CertificationGuardResult = {
  ok: true;
  guards_passed: string[];
} | {
  ok: false;
  block_code: CertificationNonPayableBlockCode;
  block_reason: string;
  failed_guard: string;
  guards_passed: string[];
};

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

function isNullOrZero(v: unknown): boolean {
  if (v == null || v === "") return true;
  const n = Number(v);
  return Number.isFinite(n) && n === 0;
}

function hasMarker(haystack: unknown, markers: readonly string[]): boolean {
  const h = norm(haystack);
  if (!h) return false;
  return markers.some((m) => h.includes(m));
}

/** client_action_id has certified prefix and embeds this trip UUID. */
export function matchesCertificationClientActionId(args: {
  client_action_id?: string | null;
  trip_id: string;
}): boolean {
  const id = String(args.client_action_id ?? "").trim().toLowerCase();
  const tripId = String(args.trip_id ?? "").trim().toLowerCase();
  if (!id || !tripId) return false;
  const expected = `${CERTIFICATION_CLIENT_ACTION_PREFIX}${tripId}`;
  return id === expected;
}

export function hasCertificationPassengerOrAddressMarkers(args: {
  passenger_name?: string | null;
  pickup_address?: string | null;
  dropoff_address?: string | null;
}): boolean {
  const passengerOk = hasMarker(args.passenger_name, CERTIFICATION_PASSENGER_MARKERS);
  const pickupOk = hasMarker(args.pickup_address, CERTIFICATION_ADDRESS_MARKERS);
  const dropOk = hasMarker(args.dropoff_address, CERTIFICATION_ADDRESS_MARKERS);
  // Require passenger marker AND at least one address marker (MK-011 shape).
  return passengerOk && (pickupOk || dropOk);
}

/**
 * Hard Preview fingerprint — all 14 requirements must pass.
 * Conflicting evidence of any kind blocks Apply.
 */
export function evaluateCertificationNonPayableGuards(
  evidence: CertificationTripEvidence,
): CertificationGuardResult {
  const passed: string[] = [];

  // 1. booking_source = admin
  if (norm(evidence.booking_source) !== "admin") {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.BOOKING_SOURCE,
      block_reason: "booking_source must be admin",
      failed_guard: "booking_source",
      guards_passed: passed,
    };
  }
  passed.push("booking_source");

  // 2. client_action_id certified prefix + trip UUID
  if (!matchesCertificationClientActionId({
    client_action_id: evidence.client_action_id,
    trip_id: evidence.trip_id,
  })) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.CLIENT_ACTION_ID,
      block_reason:
        "client_action_id must use certified test prefix and match the trip UUID",
      failed_guard: "client_action_id",
      guards_passed: passed,
    };
  }
  passed.push("client_action_id");

  // 3. certification passenger/address markers
  if (!hasCertificationPassengerOrAddressMarkers(evidence)) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.MARKERS,
      block_reason: "Certification passenger/address markers missing",
      failed_guard: "cert_markers",
      guards_passed: passed,
    };
  }
  passed.push("cert_markers");

  // 4. completed through normal lifecycle
  const status = norm(evidence.trip_status);
  if (status !== "completed" || !String(evidence.completed_at ?? "").trim()) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.LIFECYCLE,
      block_reason: "Trip must be completed through the normal lifecycle",
      failed_guard: "lifecycle",
      guards_passed: passed,
    };
  }
  passed.push("lifecycle");

  // 5. estimated fare and fare exactly 0
  if (!isNullOrZero(evidence.estimated_fare) || !isNullOrZero(evidence.fare)) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.FARE_NONZERO,
      block_reason: "estimated_fare and fare must be exactly 0",
      failed_guard: "fare_zero",
      guards_passed: passed,
    };
  }
  passed.push("fare_zero");

  // 6. gross/final/quoted/commissionable/capture null or zero
  const moneyNullOrZero = [
    evidence.gross_fare_pence,
    evidence.final_fare_pence,
    evidence.quoted_fare_pence,
    evidence.commissionable_fare_pence,
    evidence.capture_amount_pence,
  ].every(isNullOrZero);
  if (!moneyNullOrZero) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.MONEY_FIELDS,
      block_reason: "gross/final/quoted/commissionable/capture must be null or zero",
      failed_guard: "money_fields",
      guards_passed: passed,
    };
  }
  passed.push("money_fields");

  // 7. tip, waiting, airport, promotion zero
  const feesZero = [
    evidence.tip_pence,
    evidence.tip_amount_pence,
    evidence.waiting_charge_pence,
    evidence.total_waiting_charge_pence,
    evidence.pickup_waiting_charge_pence,
    evidence.stop_waiting_charge_pence,
    evidence.airport_charge_pence,
    evidence.platform_promotion_subsidy_pence,
    evidence.offer_discount_pence,
    evidence.voucher_discount_pence,
  ].every(isNullOrZero);
  if (!feesZero) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.MONEY_FIELDS,
      block_reason: "tip, waiting, airport fee and promotion amounts must be zero",
      failed_guard: "fees_zero",
      guards_passed: passed,
    };
  }
  passed.push("fees_zero");

  // 8. no payment_sessions owned by this trip
  if (Math.max(0, Math.round(Number(evidence.owned_payment_session_count) || 0)) !== 0) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.OWNED_PAYMENT_SESSION,
      block_reason: "payment_sessions.trip_id = target trip must be zero rows",
      failed_guard: "owned_payment_session",
      guards_passed: passed,
    };
  }
  passed.push("owned_payment_session");

  // 9. no provider order/payment/capture for this trip
  if (evidence.provider_evidence_for_this_trip === true) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.PROVIDER_EVIDENCE,
      block_reason: "Provider order/payment/capture belongs to this trip",
      failed_guard: "provider_evidence",
      guards_passed: passed,
    };
  }
  passed.push("provider_evidence");

  // 10. no TEN, tip, ADMIN wallet correction or payout allocation
  if (
    Math.max(0, Math.round(Number(evidence.wallet_or_admin_correction_count) || 0)) !== 0
    || Math.max(0, Math.round(Number(evidence.payout_allocation_count) || 0)) !== 0
  ) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.WALLET_OR_PAYOUT,
      block_reason: "TEN, tip, ADMIN wallet correction or payout allocation exists",
      failed_guard: "wallet_or_payout",
      guards_passed: passed,
    };
  }
  passed.push("wallet_or_payout");

  // 11. no accepted ride offer / payable entitlement
  if (Math.max(0, Math.round(Number(evidence.accepted_ride_offer_count) || 0)) !== 0) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.RIDE_OFFER,
      block_reason: "Accepted ride offer or payable entitlement evidence exists",
      failed_guard: "ride_offer",
      guards_passed: passed,
    };
  }
  passed.push("ride_offer");

  // 12. any trips.payment_session_id must belong to another trip
  const linked = String(evidence.trips_payment_session_id ?? "").trim();
  if (linked) {
    const owner = String(evidence.linked_session_owner_trip_id ?? "").trim();
    if (!owner || owner === String(evidence.trip_id)) {
      return {
        ok: false,
        block_code: CERTIFICATION_NON_PAYABLE_BLOCK.STALE_LINK_OWNER,
        block_reason:
          "trips.payment_session_id must be proven to belong to another trip",
        failed_guard: "stale_link_owner",
        guards_passed: passed,
      };
    }
  }
  passed.push("stale_link_owner");

  // 13 is the PROVIDER_UNKNOWN bypass policy (handled by caller when ok=true).
  passed.push("provider_unknown_bypass_eligible");

  // 14. conflicting evidence (non-zero existing entitlement stamps that contradict £0)
  const net = evidence.existing_driver_net_pence;
  const commission = evidence.existing_commission_pence;
  if ((net != null && Number(net) !== 0) || (commission != null && Number(commission) !== 0)) {
    return {
      ok: false,
      block_code: CERTIFICATION_NON_PAYABLE_BLOCK.CONFLICTING_EVIDENCE,
      block_reason: "Conflicting non-zero settlement stamps block Apply",
      failed_guard: "conflicting_stamps",
      guards_passed: passed,
    };
  }
  // Already marked CERTIFICATION_NON_PAYABLE with cleared link → allowed for idempotent preview
  passed.push("no_conflicting_evidence");

  return { ok: true, guards_passed: passed };
}

export function buildCertificationNonPayableProposedColumns(args: {
  clear_payment_session_id: boolean;
}): Record<string, number | string | null> {
  const columns: Record<string, number | string | null> = {
    ...CERTIFICATION_NON_PAYABLE_ZERO_STAMP_COLUMNS,
  };
  if (args.clear_payment_session_id) {
    columns.payment_session_id = null;
  }
  return columns;
}

/** UI / preview evidence bundle. */
export function buildCertificationEvidenceForPreview(
  evidence: CertificationTripEvidence,
): Record<string, unknown> {
  return {
    classification: CERTIFICATION_NON_PAYABLE_OUTCOME,
    action_label: CERTIFICATION_NON_PAYABLE_ACTION_LABEL,
    booking_source: evidence.booking_source ?? null,
    client_action_id: evidence.client_action_id ?? null,
    passenger_name: evidence.passenger_name ?? null,
    pickup_address: evidence.pickup_address ?? null,
    dropoff_address: evidence.dropoff_address ?? null,
    estimated_fare: evidence.estimated_fare ?? null,
    fare: evidence.fare ?? null,
    incorrect_linked_session_id: evidence.trips_payment_session_id ?? null,
    linked_session_real_owner_trip_id: evidence.linked_session_owner_trip_id ?? null,
    linked_session_real_owner_trip_code: evidence.linked_session_owner_trip_code ?? null,
    expected_driver_entitlement_pence: 0,
    expected_commission_pence: 0,
    wallet_delta_pence: 0,
    provider_action: "none",
    payout_action: "none",
    commission_applies: false,
    commission_rate_note:
      "Commission does not apply (rate left NULL — not a 0% commission rate)",
    no_provider_payment_will_be_changed: true,
  };
}

/** MK-011 fixture shape for lock tests (IDs mirror production read-only audit). */
export function mk011CertificationFixture(
  overrides: Partial<CertificationTripEvidence> = {},
): CertificationTripEvidence {
  const tripId = "a4305381-2e45-4a44-b64e-8fb5cbe4805d";
  return {
    trip_id: tripId,
    trip_code: "MK-260923-011",
    booking_source: "admin",
    client_action_id: `${CERTIFICATION_CLIENT_ACTION_PREFIX}${tripId}`,
    passenger_name: "Cert Exclusivity",
    pickup_address: "Cert Pickup MK",
    dropoff_address: "Cert Dropoff MK",
    trip_status: "completed",
    completed_at: "2026-09-23T13:32:02.876298+00:00",
    estimated_fare: 0,
    fare: 0,
    gross_fare_pence: null,
    final_fare_pence: null,
    quoted_fare_pence: null,
    commissionable_fare_pence: null,
    capture_amount_pence: null,
    tip_pence: 0,
    tip_amount_pence: 0,
    waiting_charge_pence: 0,
    total_waiting_charge_pence: 0,
    pickup_waiting_charge_pence: 0,
    stop_waiting_charge_pence: 0,
    airport_charge_pence: 0,
    platform_promotion_subsidy_pence: 0,
    offer_discount_pence: null,
    voucher_discount_pence: null,
    trips_payment_session_id: "bfab32d2-a52d-4f4f-b1a6-596a32b61a95",
    owned_payment_session_count: 0,
    linked_session_owner_trip_id: "6154bb76-8429-4536-ae02-5193397bce77",
    linked_session_owner_trip_code: "MK-260923-010",
    linked_session_provider_order_id: "6ab3cc06-864b-ad86-bf92-2d0f41c6e35c",
    linked_session_captured_amount_pence: 586,
    provider_evidence_for_this_trip: false,
    wallet_or_admin_correction_count: 0,
    payout_allocation_count: 0,
    accepted_ride_offer_count: 0,
    existing_driver_net_pence: null,
    existing_commission_pence: null,
    financial_outcome: null,
    ...overrides,
  };
}
