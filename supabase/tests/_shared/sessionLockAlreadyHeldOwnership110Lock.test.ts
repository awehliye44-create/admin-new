/**
 * #110 P4C — sessionLockAlreadyHeld requires genuine live lock ownership.
 * Stage D require_financial_op_claim / strict_trip_capture_mirror stay true/true.
 */

import {
  assertStringIncludes,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("#110 P4C guarded capture verifies live CAPTURING/RECONCILING owner", async () => {
  const guarded = await Deno.readTextFile(
    new URL("../../functions/_shared/guardedProviderCaptureSSOT.ts", import.meta.url),
  );
  assertStringIncludes(guarded, "sessionLockAlreadyHeld");
  assertStringIncludes(guarded, "sessionLockOwner");
  assertStringIncludes(guarded, "readPaymentSessionFinancialLock");
  assertStringIncludes(guarded, 'live.state === "CAPTURING" || live.state === "RECONCILING"');
  assertStringIncludes(guarded, "sessionLockAlreadyHeld without genuine lock");
  // Must not treat the bare boolean as sufficient without a session read.
  const flagOnly = guarded.indexOf("args.sessionLockAlreadyHeld === true");
  const readAt = guarded.indexOf("readPaymentSessionFinancialLock", flagOnly);
  assertEquals(flagOnly > 0, true);
  assertEquals(readAt > flagOnly, true);
});

Deno.test("#110 P4C completion + admin + terminal fee pass sessionLockOwner", async () => {
  const completion = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(completion, "sessionLockOwner: safeLock.ok ? safeLock.owner : null");
  assertStringIncludes(completion, "sessionLockOwner: lock.ok ? lock.owner : captureOwner");
  assertStringIncludes(
    completion,
    "owner: compositionLockOwner ?? captureOwner",
  );

  const terminal = await Deno.readTextFile(
    new URL("../../functions/_shared/terminalTripPaymentDisposition.ts", import.meta.url),
  );
  assertStringIncludes(terminal, "sessionLockOwner: dispositionLockOwner");
});
