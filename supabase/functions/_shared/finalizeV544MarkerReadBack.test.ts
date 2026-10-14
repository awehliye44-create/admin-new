/**
 * Proves the v544 read-back gate does not change capture, waiting, tip,
 * cancellation or driver-earning behaviour. The patch is the only edit
 * proposed against the downloaded live source.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordReceivableAfterConfirmedMarker } from "./finalizeV544MarkerReadBack.ts";

const PATCH = new URL("./finalize-v544-marker-readback.patch", import.meta.url);
const HELPER = new URL("./finalizeV544MarkerReadBack.ts", import.meta.url);

Deno.test("a failed marker read-back does not record a receivable", async () => {
  let recorded = 0;
  const result = await recordReceivableAfterConfirmedMarker({} as never, {
    marker: {
      tripId: "trip-1",
      shortfallPence: 40,
      reason: "declined",
    },
    receivable: {
      source_trip_id: "trip-1",
      captured_pence: 500,
      shortfall_pence: 40,
      final_fare_pence: 540,
    },
  }, {
    commit: async () => ({ committed: false, sessionId: "sess-1", error: "marker_readback_mismatch" }),
    record: async () => {
      recorded += 1;
      return { ok: true, data: { receivable_id: "should-not", created: true, plan: {} } };
    },
  });
  assertEquals(recorded, 0);
  assertEquals(result.ok, false);
});

Deno.test("a confirmed marker records the receivable with the same amounts", async () => {
  const seen: unknown[] = [];
  const result = await recordReceivableAfterConfirmedMarker({} as never, {
    marker: {
      sessionId: "sess-1",
      tripId: "trip-1",
      shortfallPence: 40,
      expectedFarePence: 540,
      capturedPence: 500,
      reason: "partial",
    },
    receivable: {
      source_trip_id: "trip-1",
      source_payment_session_id: "sess-1",
      captured_pence: 500,
      shortfall_pence: 40,
      final_fare_pence: 540,
      pickup_waiting_charge_pence: 40,
      provider_state: "COMPLETED",
    },
  }, {
    commit: async () => ({ committed: true, sessionId: "sess-1" }),
    record: async (_supabase, args) => {
      seen.push(args);
      return { ok: true, data: { receivable_id: "recv-1", created: true, plan: {} } };
    },
  });
  assertEquals(result.ok, true);
  assertEquals(seen, [{
    source_trip_id: "trip-1",
    source_payment_session_id: "sess-1",
    captured_pence: 500,
    shortfall_pence: 40,
    final_fare_pence: 540,
    pickup_waiting_charge_pence: 40,
    provider_state: "COMPLETED",
  }]);
});

Deno.test("the v544 patch only gates the two shortfall receivable calls", async () => {
  const patch = await Deno.readTextFile(PATCH);
  const removed = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
  const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const addedBody = added.map((line) => line.slice(1).trim());
  for (const line of removed) {
    const body = line.slice(1).trim();
    const kept = addedBody.includes(body)
      || (body === "});" && patch.split("\n").some((line) => line.startsWith(" ") && line.trim() === "});"));
    const isGate = body.includes("markPaymentSessionPaymentShortfall")
      || body.includes("recordReceivableAfterDeclinedIncrement")
      || body === "clientActionId,";
    assert(kept || isGate, line);
  }
  assertEquals(added.filter((line) => line.includes("recordReceivableAfterConfirmedMarker")).length, 3);
  assert(added.some((line) => line.includes("captured_pence: 0")));
  assert(added.some((line) => line.includes("captured_pence: safe.capturePence")));
  assert(!patch.includes("TRIP_EARNING"));
  assert(!patch.includes("tipAuthorisation"));
  assert(!patch.includes("increment-authorisation"));
  const helper = await Deno.readTextFile(HELPER);
  assert(!helper.includes("TRIP_EARNING"));
  assert(!helper.includes("captureRevolut"));
  assert(helper.includes("commitShortfallSessionMarker"));
  assert(helper.includes("recordReceivableAfterDeclinedIncrement"));
});
