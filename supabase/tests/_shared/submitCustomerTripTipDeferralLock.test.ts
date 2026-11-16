/**
 * Bug #24B: submit-customer-trip-tip durably accepts tip intent (amount + mutex)
 * then defers Revolut finalize via scheduleEdgeBackground — never fire-and-forget
 * from the client alone, and never a second capture pipeline.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const tipSrc = await Deno.readTextFile(
  new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
);

Deno.test("Bug #24B lock: tip amount + mutex claim before deferred finalize", () => {
  assertStringIncludes(tipSrc, "scheduleEdgeBackground");
  assertStringIncludes(tipSrc, "runDeferredTipWindowFinalize");
  assertStringIncludes(tipSrc, 'tip_capture_deferred: true');
  assertStringIncludes(tipSrc, "tip_accepted: true");
  assertStringIncludes(tipSrc, "claimTipWindowTrigger");
  assertStringIncludes(tipSrc, "source: \"submit_customer_trip_tip\"");

  const claimAt = tipSrc.indexOf("claimTipWindowTrigger");
  const scheduleAt = tipSrc.indexOf(
    'scheduleEdgeBackground(async () => {\n        await runDeferredTipWindowFinalize',
  );
  const returnDeferredAt = tipSrc.indexOf("tip_capture_deferred: true");
  assertEquals(claimAt > 0, true);
  assertEquals(scheduleAt > claimAt, true);
  assertEquals(returnDeferredAt > scheduleAt, true);

  // Sync await invokeFinalize must not remain on the Revolut response path.
  const revolutBranch = tipSrc.slice(
    tipSrc.indexOf('provider === "revolut"'),
    tipSrc.indexOf("if (isCash)"),
  );
  assertEquals(revolutBranch.includes("await invokeFinalizeTripCapture"), false);
  assertEquals(revolutBranch.includes("scheduleEdgeBackground"), true);
});

Deno.test("Bug #24B lock: deferred finalize reuses tip mutex release / seal SSOT", () => {
  assertStringIncludes(tipSrc, "releaseTipWindowTriggerClaim");
  assertStringIncludes(tipSrc, "finalizeTipWindowTrigger");
  assertStringIncludes(tipSrc, "tip_authorisation_declined");
  assertStringIncludes(tipSrc, "provider_unknown");
  assertStringIncludes(tipSrc, "tipRequestedButNotCollected");
});
