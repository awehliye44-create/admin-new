/**
 * Step 9.3A — MK-260817-008 authoritative evidence disposition (read-only).
 *
 * Authority precedence for reconstructing a driver entitlement without inventing:
 * 1. Immutable accepted-offer financial snapshot linked to trip + driver
 * 2. Saved trip financial stamps from canonical acceptance/settlement
 * 3. Immutable booking/quote + explicitly persisted accepted commission contract
 *
 * Forbidden: orphan/unaccepted offers, timestamp-nearest heuristics, captured×%,
 * current service-area commission, other trips' rates, approximate 85%.
 *
 * FR detect remains stamp-only (null driver_net_pence → PENDING_EVIDENCE) and
 * must never credit from this module.
 */

export const MK008_TRIP_ID = "3b48b86c-9ebf-407e-bb8b-a51ad2e75edc";
export const MK008_TRIP_CODE = "MK-260817-008";
export const MK008_DRIVER_ID = "cd8bae4c-3827-4b90-98c6-10be70eb0e52";
export const MK008_ACCEPTED_OFFER_ID = "f28e4e06-b1f8-487a-9ae9-3e70178b2133";

export const DISPOSITION = {
  AUTHORITATIVE_UNPAID_DRIVER_LIABILITY: "AUTHORITATIVE_UNPAID_DRIVER_LIABILITY",
  ALREADY_COMPENSATED_OR_NOT_OWED: "ALREADY_COMPENSATED_OR_NOT_OWED",
  PENDING_EVIDENCE: "PENDING_EVIDENCE",
  SOURCE_WORKFLOW_DEFECT_CONFIRMED: "SOURCE_WORKFLOW_DEFECT_CONFIRMED",
} as const;

export type DispositionClass = typeof DISPOSITION[keyof typeof DISPOSITION];

export type OfferEvidence = {
  id: string;
  trip_id: string;
  driver_id: string;
  status: string;
  offered_driver_net_pence: number | null;
  offer_snapshot_net_pence: number | null;
  is_stacked: boolean | null;
};

export type TripStampEvidence = {
  id: string;
  driver_id: string | null;
  financial_model: string | null;
  status: string | null;
  driver_net_pence: number | null;
  accepted_ride_offer_id: string | null;
  commission_pence: number | null;
  accepted_commission_percent: number | null;
};

export type AcceptanceAuditEvidence = {
  event_type: string;
  offer_id: string | null;
};

export type MoneyIsolationEvidence = {
  ten_count: number;
  ten_sum_pence: number;
  compensation_count: number;
  commission_wallet_count: number;
};

/** Exact integer entitlement from an accepted offer, or null if not proven. */
export function entitlementFromAcceptedOfferSnapshot(args: {
  tripId: string;
  driverId: string;
  offers: OfferEvidence[];
  acceptanceAudits: AcceptanceAuditEvidence[];
}): { entitlement_pence: number; offer_id: string } | null {
  const accepted = args.offers.filter(
    (o) =>
      o.trip_id === args.tripId &&
      o.driver_id === args.driverId &&
      String(o.status).toLowerCase() === "accepted",
  );
  if (accepted.length !== 1) return null;

  const offer = accepted[0];
  const auditOk = args.acceptanceAudits.some(
    (a) =>
      a.event_type === "ride_accepted" &&
      a.offer_id === offer.id,
  );
  if (!auditOk) return null;

  const rowNet = offer.offered_driver_net_pence;
  const snapNet = offer.offer_snapshot_net_pence;
  if (rowNet == null || !Number.isFinite(rowNet) || rowNet <= 0) return null;
  if (snapNet != null && snapNet !== rowNet) return null;

  return { entitlement_pence: Math.round(rowNet), offer_id: offer.id };
}

/** Orphan / pending / revoked offers never authorise money. */
export function orphanOfferCannotAuthorise(offer: OfferEvidence): boolean {
  const st = String(offer.status).toLowerCase();
  return st !== "accepted";
}

/**
 * Null trip stamp must never fall back to captured amount or percentage maths.
 * Returns null always — intentional fail-closed.
 */
export function entitlementFromNullStampFallbacks(_args: {
  driver_net_pence: number | null;
  captured_amount_pence: number | null;
  gross_fare_pence: number | null;
  commission_percent?: number | null;
}): null {
  return null;
}

export function classifyMk008Evidence(args: {
  trip: TripStampEvidence;
  offers: OfferEvidence[];
  acceptanceAudits: AcceptanceAuditEvidence[];
  money: MoneyIsolationEvidence;
}): {
  primary: DispositionClass;
  accompanying_defect: typeof DISPOSITION.SOURCE_WORKFLOW_DEFECT_CONFIRMED | null;
  authoritative_entitlement_pence: number | null;
  accepted_offer_link_proven: boolean;
  credit_approved_by_evidence: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (String(args.trip.financial_model) !== "PLATFORM_COLLECTED") {
    return {
      primary: DISPOSITION.PENDING_EVIDENCE,
      accompanying_defect: null,
      authoritative_entitlement_pence: null,
      accepted_offer_link_proven: false,
      credit_approved_by_evidence: false,
      reasons: ["financial_model_not_platform_collected"],
    };
  }

  if (args.money.ten_count > 0 || args.money.compensation_count > 0) {
    return {
      primary: DISPOSITION.ALREADY_COMPENSATED_OR_NOT_OWED,
      accompanying_defect: null,
      authoritative_entitlement_pence: null,
      accepted_offer_link_proven: false,
      credit_approved_by_evidence: false,
      reasons: ["existing_ten_or_compensation"],
    };
  }

  if (args.money.commission_wallet_count > 0) {
    return {
      primary: DISPOSITION.PENDING_EVIDENCE,
      accompanying_defect: null,
      authoritative_entitlement_pence: null,
      accepted_offer_link_proven: false,
      credit_approved_by_evidence: false,
      reasons: ["commission_wallet_contamination"],
    };
  }

  // Precedence 2: saved trip stamp
  const stamp = args.trip.driver_net_pence;
  if (stamp != null && Number.isFinite(stamp) && stamp > 0) {
    return {
      primary: DISPOSITION.AUTHORITATIVE_UNPAID_DRIVER_LIABILITY,
      accompanying_defect: null,
      authoritative_entitlement_pence: Math.round(stamp),
      accepted_offer_link_proven: args.trip.accepted_ride_offer_id != null,
      credit_approved_by_evidence: true,
      reasons: ["saved_trip_driver_net_stamp"],
    };
  }

  // Precedence 1: accepted offer snapshot + acceptance audit
  const fromOffer = entitlementFromAcceptedOfferSnapshot({
    tripId: args.trip.id,
    driverId: String(args.trip.driver_id ?? ""),
    offers: args.offers,
    acceptanceAudits: args.acceptanceAudits,
  });

  const defect =
    args.trip.accepted_ride_offer_id == null &&
    args.trip.driver_net_pence == null &&
    fromOffer != null
      ? DISPOSITION.SOURCE_WORKFLOW_DEFECT_CONFIRMED
      : null;

  if (fromOffer) {
    reasons.push("accepted_offer_snapshot_linked_trip_driver_with_ride_accepted_audit");
    if (defect) {
      reasons.push("trip_missing_accepted_ride_offer_id_and_driver_net_stamp");
    }
    return {
      primary: DISPOSITION.AUTHORITATIVE_UNPAID_DRIVER_LIABILITY,
      accompanying_defect: defect,
      authoritative_entitlement_pence: fromOffer.entitlement_pence,
      accepted_offer_link_proven: true,
      credit_approved_by_evidence: true,
      reasons,
    };
  }

  // Conflicting accepted offers / missing audit → pending
  const acceptedSameTrip = args.offers.filter(
    (o) => o.trip_id === args.trip.id && String(o.status).toLowerCase() === "accepted",
  );
  if (acceptedSameTrip.length > 1) {
    reasons.push("conflicting_accepted_offers");
  } else if (acceptedSameTrip.length === 1) {
    reasons.push("accepted_offer_lacks_immutable_net_or_acceptance_audit");
  } else {
    reasons.push("no_accepted_offer_and_null_trip_stamp");
  }

  return {
    primary: DISPOSITION.PENDING_EVIDENCE,
    accompanying_defect: defect,
    authoritative_entitlement_pence: null,
    accepted_offer_link_proven: false,
    credit_approved_by_evidence: false,
    reasons,
  };
}

/** Production MK-008 freeze shape used by disposition tests. */
export function mk008ProductionEvidenceFixture() {
  return {
    trip: {
      id: MK008_TRIP_ID,
      driver_id: MK008_DRIVER_ID,
      financial_model: "PLATFORM_COLLECTED",
      status: "completed",
      driver_net_pence: null,
      accepted_ride_offer_id: null,
      commission_pence: null,
      accepted_commission_percent: null,
    } satisfies TripStampEvidence,
    offers: [
      {
        id: MK008_ACCEPTED_OFFER_ID,
        trip_id: MK008_TRIP_ID,
        driver_id: MK008_DRIVER_ID,
        status: "accepted",
        offered_driver_net_pence: 609,
        offer_snapshot_net_pence: 609,
        is_stacked: true,
      },
    ] satisfies OfferEvidence[],
    acceptanceAudits: [
      {
        event_type: "ride_accepted",
        offer_id: MK008_ACCEPTED_OFFER_ID,
      },
    ] satisfies AcceptanceAuditEvidence[],
    money: {
      ten_count: 0,
      ten_sum_pence: 0,
      compensation_count: 0,
      commission_wallet_count: 0,
    } satisfies MoneyIsolationEvidence,
    captured_amount_pence: 716,
    gross_fare_pence: 745,
  };
}
