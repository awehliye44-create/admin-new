/**
 * Permanent optimisation safety boundary across Edge functions.
 * waitUntil alone is not durable completion for financial / authoritative binds.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const CTAP = new URL(
  "../../functions/create-trip-after-payment/index.ts",
  import.meta.url,
);

Deno.test("CTAP: markPaymentSessionTripCreated stays on HTTP path (not waitUntil-only)", async () => {
  const ctap = await Deno.readTextFile(CTAP);
  assert(ctap.includes("EdgeRuntime.waitUntil(Promise.allSettled(postInsertTasks))"));
  const waitAt = ctap.indexOf("EdgeRuntime.waitUntil(Promise.allSettled(postInsertTasks))");
  const after = ctap.slice(waitAt, waitAt + 900);
  assert(
    after.includes("await markPaymentSessionTripCreated"),
    "session→trip mark must be awaited after waitUntil kickoff before response",
  );
  assert(
    !/EdgeRuntime\.waitUntil\(\(async\s*\(\)\s*=>\s*\{[\s\S]*?await markPaymentSessionTripCreated/.test(
      ctap,
    ),
    "forbidden: markPaymentSessionTripCreated only inside waitUntil",
  );
});

Deno.test("CTAP: booking payable snap remains on-path before session mark", async () => {
  const ctap = await Deno.readTextFile(CTAP);
  const snapAt = ctap.indexOf(
    "persistBookingPayableSnapshotAfterInsert(supabase, {\n        tripId: trip.id",
  );
  const markAt = ctap.lastIndexOf("await markPaymentSessionTripCreated");
  assert(snapAt > 0 && markAt > snapAt);
});

Deno.test("optimisation safety rule file documents waitUntil durability requirements", async () => {
  const rule = await Deno.readTextFile(
    new URL("../../../.cursor/rules/optimisation-safety-boundary-lock.mdc", import.meta.url),
  );
  assert(rule.includes("EdgeRuntime.waitUntil"));
  assert(rule.includes("insufficient"));
  assert(rule.includes("markPaymentSessionTripCreated"));
  assert(rule.includes("correlated same-request"));
});
