/**
 * #92G/#92H — Targeted recovery entry for MK-261125-003.
 * Delegates to generic PLATFORM_COLLECTED integrity recovery (idempotent).
 * Never POSTs CAPTURE/INCREMENT. Never creates a second TEN.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  recoverPlatformCollectedTripFinancialIntegrity,
} from "./platformCollectedFinancialIntegrityRecoverySSOT.ts";
import { readTripEarningNetLedgerState } from "./tripEarningNetLedgerReadback.ts";

export const MK_261125_003 = {
  tripCode: "MK-261125-003",
  tripId: "85082fe7-4aab-455a-932e-e7a01cf24d25",
  paymentSessionId: "59de4b07-b990-4784-91b7-e792c01595b9",
  providerOrderId: "6b06f49f-d42c-adce-a35e-27c48dd8b200",
  driverId: "c40dd8a6-f422-40bc-9534-bae7be88b93e",
  capturedPence: 570,
  tenPence: 484,
  authorisedFinalPence: 1482,
} as const;

export async function recoverMk261125003IntegrityGaps(
  supabase: SupabaseClient,
): Promise<{
  integrity: Awaited<ReturnType<typeof recoverPlatformCollectedTripFinancialIntegrity>>;
  tenCount: number;
  tenAmountPence: number;
  captureConfirmedPence: number | null;
  sessionStatus: string | null;
}> {
  const t = MK_261125_003;
  const integrity = await recoverPlatformCollectedTripFinancialIntegrity(supabase, {
    tripId: t.tripId,
  });

  const ten = await readTripEarningNetLedgerState(supabase, t.tripId);
  const { data: session } = await supabase
    .from("payment_sessions")
    .select("status, capture_confirmed_pence, captured_amount_pence")
    .eq("id", t.paymentSessionId)
    .maybeSingle();

  return {
    integrity,
    tenCount: ten.count,
    tenAmountPence: ten.totalPence,
    captureConfirmedPence: session?.capture_confirmed_pence != null
      ? Math.round(Number(session.capture_confirmed_pence))
      : session?.captured_amount_pence != null
      ? Math.round(Number(session.captured_amount_pence))
      : null,
    sessionStatus: session?.status != null ? String(session.status) : null,
  };
}
