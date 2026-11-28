/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Trip settlement — SINGLE SOURCE OF TRUTH for commission / driver net / platform revenue.
 *
 * All settlement writers (trip complete, negotiation accept, admin fare edit, provider
 * webhook recovery, capture) must use calculateTripSettlement().
 *
 * Formula v2 / Slice 4 (waiting commissionable):
 *   commissionable = final_fare − airport_charge
 *   (waiting / stop waiting / commissionable extras stay inside final_fare)
 *   Non-commissionable ONLY: airport charges + driver tips
 *   tips are usually outside final_fare and added to driver_total only
 *
 * global_offer (this feature, no waiting in this path):
 *   commissionable = fare_snapshot_json.gross_fare_pence|locked_base_fare_pence
 *                  + customer_modification_charge_pence
 *   gross commission on that base; locked offer_discount_pence deducted from ONECAB only
 *
 * Explicit component API + golden fixtures: shared/canonicalSettlementSSOT.ts
 * Identity: captured = driver_net + gross_commission + airport + tips
 * Provider fee reduces ONECAB net only (never driver_net).
 */

import {
  calculateCanonicalSettlement,
  computeAuthoritativeSettlement,
} from "../../../functions/_shared/canonicalSettlementSSOT.ts";
import { TripSettlementTripRow, nonNegInt } from "../../../functions/_shared/tripSettlement.ts";


/** Audit-only prior promotion when negotiation superseded global_offer. */
export function resolvePreviousLockedPromotionPence(trip: TripSettlementTripRow): number {
  const snap = trip.fare_snapshot_json;
  if (snap && typeof snap === "object") {
    const fromSnap = nonNegInt(snap.previous_locked_promotion_pence);
    if (fromSnap > 0) return fromSnap;
  }
  const src = typeof trip.discount_source === "string" ? trip.discount_source : "";
  if (src !== "global_offer") return 0;
  return nonNegInt(trip.offer_discount_pence);
}

export * from "../../../functions/_shared/tripSettlement.ts";
