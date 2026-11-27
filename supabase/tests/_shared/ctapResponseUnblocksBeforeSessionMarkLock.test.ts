/**
 * Financial safety — markPaymentSessionTripCreated is request-path SSOT.
 *
 * waitUntil is not durable completion. Moving session→trip linkage into
 * waitUntil alone allows Edge abort after HTTP 200 to leave an authorised
 * session unbound while a live trip exists (hold-sweep / orphan risk).
 *
 * Payable snap stays on-path (#92J). Post-commit dispatch may stay waitUntil.
 * UI latency must not override this boundary.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("CTAP awaits markPaymentSessionTripCreated on the HTTP path (not waitUntil-only)", async () => {
  const ctap = await Deno.readTextFile(
    new URL("../../functions/create-trip-after-payment/index.ts", import.meta.url),
  );

  assert(ctap.includes("persistBookingPayableSnapshotAfterInsert"));
  assert(ctap.includes("markPaymentSessionTripCreated"));
  assert(ctap.includes("EdgeRuntime.waitUntil(Promise.allSettled(postInsertTasks))"));

  const waitUntilAt = ctap.indexOf("EdgeRuntime.waitUntil(Promise.allSettled(postInsertTasks))");
  assert(waitUntilAt > 0, "post-commit tasks must remain waitUntil");

  const afterWaitUntil = ctap.slice(waitUntilAt, waitUntilAt + 900);
  assert(
    afterWaitUntil.includes("await markPaymentSessionTripCreated"),
    "session mark must be awaited after waitUntil kickoff and before response",
  );

  // Forbidden: wrap mark inside waitUntil-only (aborts lose durable linkage).
  assert(
    !ctap.includes("markPaymentSessionTripCreated_waitUntil_failed"),
    "must not treat session mark as waitUntil-best-effort",
  );
  assert(
    !/EdgeRuntime\.waitUntil\(\(async\s*\(\)\s*=>\s*\{[\s\S]*?await markPaymentSessionTripCreated/.test(
      ctap,
    ),
    "markPaymentSessionTripCreated must not live only inside waitUntil",
  );
});

Deno.test("CTAP keeps booking payable snap on-path before session mark", async () => {
  const ctap = await Deno.readTextFile(
    new URL("../../functions/create-trip-after-payment/index.ts", import.meta.url),
  );
  const snapAt = ctap.indexOf("persistBookingPayableSnapshotAfterInsert(supabase, {\n        tripId: trip.id");
  const markAt = ctap.lastIndexOf("await markPaymentSessionTripCreated");
  assert(snapAt > 0 && markAt > snapAt, "payable snap must precede session mark on success path");
});
