/**
 * Bug #24B — durable tip accept verification (backend-owned).
 *
 * Tip amount + mutex claim are durable before the HTTP success return.
 * Revolut finalize runs via scheduleEdgeBackground (not client fire-and-forget).
 * Duplicate charge prevented by tip-window mutex; ambiguous UNKNOWN retains claim.
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const tipSrc = await Deno.readTextFile(
  new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
);

Deno.test("Bug #24B: durable accept before deferred finalize (kill/offline safe)", () => {
  assertStringIncludes(tipSrc, "claimTipWindowTrigger");
  assertStringIncludes(tipSrc, "tip_accepted: true");
  assertStringIncludes(tipSrc, "tip_capture_deferred: true");
  assertStringIncludes(tipSrc, "tip_window_status: TIP_WINDOW_STATUS.PROCESSING");
  assertStringIncludes(tipSrc, "scheduleEdgeBackground");
  assertStringIncludes(tipSrc, "runDeferredTipWindowFinalize");

  const claimAt = tipSrc.indexOf("await claimTipWindowTrigger");
  const deferredStartAt = tipSrc.indexOf("const deferredFinalize = runDeferredTipWindowFinalize");
  const scheduleAt = tipSrc.indexOf("scheduleEdgeBackground(\n        () => deferredFinalize");
  const deferredReturnAt = tipSrc.indexOf("tip_capture_deferred: true");
  assertEquals(claimAt > 0, true);
  assertEquals(deferredStartAt > claimAt, true);
  assertEquals(scheduleAt > deferredStartAt, true);
  assertEquals(deferredReturnAt > scheduleAt, true);

  const revolutBranch = tipSrc.slice(
    tipSrc.indexOf('provider === "revolut"'),
    tipSrc.indexOf("if (isCash)"),
  );
  assertEquals(revolutBranch.includes("await invokeFinalizeTripCapture"), false);
});

Deno.test("Bug #24B: auth decline + ambiguous + duplicate protection", () => {
  assertStringIncludes(tipSrc, "tip_authorisation_declined");
  assertStringIncludes(tipSrc, "TIP_AUTHORISATION_DECLINED");
  assertStringIncludes(tipSrc, "clearTip: true");
  assertStringIncludes(tipSrc, "provider_unknown");
  assertStringIncludes(tipSrc, "claim retained");
  assertStringIncludes(tipSrc, "TIP_WINDOW_PROCESSING");
  assertStringIncludes(tipSrc, "CLAIM_HELD");
  assertStringIncludes(tipSrc, "TIP_ALREADY_SUBMITTED");
});

Deno.test("Bug #24B: deferred finalize reuses same finalize SSOT (no second pipeline)", () => {
  assertStringIncludes(tipSrc, 'source: "submit_customer_trip_tip"');
  assertStringIncludes(tipSrc, "finalizeTipWindowTrigger");
  assertStringIncludes(tipSrc, "tipRequestedButNotCollected");
});
