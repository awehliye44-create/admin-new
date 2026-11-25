/**
 * #92G — Static-import wrapper for authoritative payable snapshots.
 *
 * Dynamic `import("./writeAuthoritativePayableSnapshotSSOT.ts")` was excluded
 * from Edge function ESZIP bundles (MK-261125-003: zero snapshots in production).
 * Callers must use this static path and treat ok:false as a durable integrity gap.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  writeAuthoritativePayableSnapshot,
  type TripPayableSnapshotRow,
} from "./writeAuthoritativePayableSnapshotSSOT.ts";
import type { PayableSnapshotSource, WaitingBasis } from "./payableFareSnapshotSSOT.ts";
import { recordPaymentFinancialEvent } from "./paymentFinancialDiagnosticsSSOT.ts";

export async function writePayableSnapshotOrLog(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    trip: TripPayableSnapshotRow;
    source: PayableSnapshotSource;
    tipPence?: number | null;
    receivablesPence?: number | null;
    waitingBasis?: WaitingBasis;
    totalPayableOverridePence?: number | null;
    paymentSessionId?: string | null;
    logPrefix: string;
  },
): Promise<{ ok: true; id: string; version: number } | { ok: false; error: string }> {
  try {
    const result = await writeAuthoritativePayableSnapshot(supabase, {
      tripId: args.tripId,
      trip: args.trip,
      source: args.source,
      tipPence: args.tipPence,
      receivablesPence: args.receivablesPence,
      waitingBasis: args.waitingBasis,
      totalPayableOverridePence: args.totalPayableOverridePence,
    });
    if (!result.ok) {
      console.error(`[${args.logPrefix}] payable snapshot persist failed`, result.error);
      if (args.paymentSessionId) {
        await recordPaymentFinancialEvent(supabase, {
          paymentSessionId: args.paymentSessionId,
          tripId: args.tripId,
          opType: "RECONCILE",
          eventType: "payable_snapshot_persist_failed",
          detail: { source: args.source, error: result.error },
        }).catch(() => undefined);
      }
      return result;
    }
    return { ok: true, id: result.id, version: result.version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${args.logPrefix}] payable snapshot threw`, msg);
    if (args.paymentSessionId) {
      await recordPaymentFinancialEvent(supabase, {
        paymentSessionId: args.paymentSessionId,
        tripId: args.tripId,
        opType: "RECONCILE",
        eventType: "payable_snapshot_persist_failed",
        detail: { source: args.source, error: msg },
      }).catch(() => undefined);
    }
    return { ok: false, error: msg };
  }
}
