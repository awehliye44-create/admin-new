/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Phase 0 — canonical typed wallet posting paths.
 * TRIP_EARNING_NET authority lives in creditCapturedCardTripLedger (onecabFinanceLedger.ts).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import { creditCapturedCardTripLedger } from "../../../functions/_shared/onecabFinanceLedger.ts";

import { type TripSettlementTripRow } from "../../../functions/_shared/tripSettlement.ts";

import { invoiceTipPenceFromConfirmedCapture } from "../../../functions/_shared/tripPaymentFinalised.ts";

import {
  loadTerminalCaptureEvidence,
  postTerminalEntitlementFromSettlement,
  stampTerminalOutcomeTripRow,
} from "../../../functions/_shared/terminalOutcomeEntitlementSSOT.ts";


/** @deprecated Use postTerminalEntitlementFromSettlement via settleNoShowFee. */
export async function postNoShowDriverCompensation(
  supabase: SupabaseClient,
  input: {
    driverId: string;
    tripId: string;
    feePence: number;
    currency: string;
  },
): Promise<boolean> {
  const evidence = await loadTerminalCaptureEvidence(
    supabase,
    input.tripId,
    Math.max(0, Math.round(Number(input.feePence) || 0)),
  );
  const posted = await postTerminalEntitlementFromSettlement({
    supabase,
    tripId: input.tripId,
    driverId: input.driverId,
    outcome: "NO_SHOW",
    currency: input.currency,
    evidence,
  });
  return posted.credited;
}

export * from "../../../functions/_shared/canonicalTypedWalletPostingSSOT.ts";
