/**
 * LOCK — terminal earning in Today's earnings + arrival legacy metadata unit.
 *
 * Today's earnings: a chargeable terminal TRIP_EARNING_NET is visible
 * immediately (while Pending) at capture time. The unused buffer released after
 * a terminal partial capture is not a capture release (MK-261002-014: capture
 * 450, release 300 → was CAPTURE_RELEASED → Wallet Today 0).
 *
 * trips.arrival_cancellation_fee is INTEGER pence (column comment: "Arrival
 * cancellation fee charged (pence)"). Writing pounds (fee / 100) stored 4 for
 * 400p and failed the whole fee patch for 450p (4.5 is not an integer), which
 * left MK-261002-014 with arrival_cancellation_applied = false.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { specResolveEconomicDate } from "../../functions/_shared/economicEarnedAtResolverSpec.ts";
import { sumTodayEarningsPence } from "../../functions/_shared/todayEarningsSsot.ts";
import {
  arrivalCancellationLegacyPatch,
  TRIP_FEE_PATCH_FAILED,
} from "../../functions/_shared/terminalTripPaymentDisposition.ts";

const session014 = {
  purpose: "RIDE_BOOKING",
  captured_at: "2026-10-02T12:29:43.321Z",
  captured_amount_pence: 450,
  released_amount_pence: 300,
  released_at: "2026-10-02T12:29:44.000Z",
  refunded_amount_pence: 0,
  status: "captured",
  provider_state: "COMPLETED",
  provider_state_verified_at: "2026-10-02T12:29:43.900Z",
  hold_release_state: "released",
};

Deno.test("economic date: terminal remainder release resolves at capture time", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: "t014",
    created_at: "2026-10-02T12:29:45.802Z",
    financial_model: "PLATFORM_COLLECTED",
    sessions: [session014],
    chargeable_terminal: true,
  });
  assertEquals(r.economic_date_status, "RESOLVED");
  assertEquals(r.economic_earned_at, session014.captured_at);
});

Deno.test("economic date: non-terminal release is unchanged (CAPTURE_RELEASED)", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: "t",
    created_at: "2026-10-02T12:29:45.802Z",
    financial_model: "PLATFORM_COLLECTED",
    sessions: [session014],
  });
  assertEquals(r.economic_date_status, "CAPTURE_RELEASED");
});

Deno.test("economic date: terminal full release / refund still fail closed", () => {
  const base = {
    type: "TRIP_EARNING_NET",
    related_trip_id: "t",
    created_at: "2026-10-02T12:29:45.802Z",
    financial_model: "PLATFORM_COLLECTED",
    chargeable_terminal: true,
  };
  assertEquals(
    specResolveEconomicDate({ ...base, sessions: [{ ...session014, status: "released" }] }).economic_date_status,
    "CAPTURE_RELEASED",
  );
  const refunded = specResolveEconomicDate({ ...base, sessions: [{ ...session014, refunded_amount_pence: 450 }] });
  assertEquals(refunded.economic_date_status === "RESOLVED", false);
  assertEquals(refunded.economic_earned_at, null);
});

Deno.test("Today's earnings: MK-261002-014 TEN 426 counts on the capture day while Pending", () => {
  const today = sumTodayEarningsPence(
    [{
      type: "TRIP_EARNING_NET",
      amount_pence: 426,
      created_at: "2026-10-02T12:29:45.802Z",
      posting_created_at: "2026-10-02T12:29:45.802Z",
      economic_earned_at: session014.captured_at,
      economic_date_status: "RESOLVED",
    }],
    "2026-10-01T23:00:00.000Z",
    "2026-10-02T23:00:00.000Z",
  );
  assertEquals(today, 426);
});

Deno.test("arrival legacy metadata: integer pence, decision time, canonical reason", () => {
  const p = arrivalCancellationLegacyPatch(450, "2026-10-02T12:29:40.000Z");
  assertEquals(p, {
    arrival_cancellation_applied: true,
    arrival_cancellation_fee: 450,
    arrival_cancellation_applied_at: "2026-10-02T12:29:40.000Z",
    arrival_cancellation_reason: "ARRIVAL_CANCELLATION_FEE",
  });
  assertEquals(Number.isInteger(p.arrival_cancellation_fee), true);
  assertEquals(arrivalCancellationLegacyPatch(400, "x").arrival_cancellation_fee, 400);
});

Deno.test("disposition: fee patch is checked and fails closed before any provider mutation", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/terminalTripPaymentDisposition.ts", import.meta.url),
  );
  assertEquals(src.includes("decision.fee_amount_pence / 100"), false);
  assertStringIncludes(src, "const { error: feePatchErr } = await supabase.from(\"trips\").update(tripFeePatch)");
  assertStringIncludes(src, "${TRIP_FEE_PATCH_FAILED}:");
  assertEquals(TRIP_FEE_PATCH_FAILED, "TRIP_FEE_PATCH_FAILED");
  const patchAt = src.indexOf("update(tripFeePatch)");
  // The fee patch precedes the financial lock claim and every provider mutation.
  for (const call of [
    "await claimPaymentSessionFinancialLock(",
    "await captureRevolutOrder(",
    "await cancelRevolutOrder(",
  ]) {
    const at = src.indexOf(call);
    assertEquals(at > patchAt, true, call);
  }
});
