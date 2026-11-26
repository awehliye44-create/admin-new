/**
 * #110 P4B — four-trigger immediate driver credit architecture lock.
 *
 * Triggers: CUSTOMER_SKIP | CUSTOMER_SUBMIT_NO_TIP | CUSTOMER_SUBMIT_WITH_TIP | WINDOW_EXPIRED
 * Tips disabled → capture on complete (stop-workflow capture_requested path).
 * Sweeps remain fallback only — customer/expiry triggers start capture immediately.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TIP_WINDOW_TRIGGER } from "../../functions/_shared/tipWindowConstants.ts";

const submit = await Deno.readTextFile(
  new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
);
const expiry = await Deno.readTextFile(
  new URL("../../functions/capture-expired-tip-windows/index.ts", import.meta.url),
);
const stop = await Deno.readTextFile(
  new URL("../../functions/stop-workflow/index.ts", import.meta.url),
);
const immediate = await Deno.readTextFile(
  new URL("../../functions/_shared/tipWindowImmediateFinalizeSSOT.ts", import.meta.url),
);

Deno.test("#110 P4B four tip-window triggers are the only finalisation owners", () => {
  assertEquals(TIP_WINDOW_TRIGGER.CUSTOMER_SKIP, "CUSTOMER_SKIP");
  assertEquals(TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_NO_TIP, "CUSTOMER_SUBMIT_NO_TIP");
  assertEquals(TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP, "CUSTOMER_SUBMIT_WITH_TIP");
  assertEquals(TIP_WINDOW_TRIGGER.WINDOW_EXPIRED, "WINDOW_EXPIRED");
});

Deno.test("#110 P4B customer tip triggers initiate same-isolate capture immediately", () => {
  assertStringIncludes(submit, "finalizeTipWindowCaptureImmediate");
  assertStringIncludes(submit, "tip_capture_queued");
  assertStringIncludes(immediate, 'stage: "tip_capture_initiated"');
  assertStringIncludes(immediate, "finalizeRevolutTripCapture");
  // Deferred accept preserved — never block tip_accepted on Revolut.
  assertStringIncludes(submit, "tip_capture_deferred: true");
  assertStringIncludes(submit, "scheduleEdgeBackground");
  // Eager start before waitUntil registration.
  assertStringIncludes(submit, "const deferredFinalize = runDeferredTipWindowFinalize");
});

Deno.test("#110 P4B WINDOW_EXPIRED uses same immediate finalize SSOT", () => {
  assertStringIncludes(expiry, "await finalizeTipWindowCaptureImmediate");
  assertStringIncludes(expiry, "WINDOW_EXPIRED");
  assert(
    expiry.indexOf("await claimTipWindowTrigger") <
      expiry.indexOf("await finalizeTipWindowCaptureImmediate"),
  );
});

Deno.test("#110 P4B tips-disabled complete initiates capture without tip-window deferral", () => {
  assertStringIncludes(stop, "deferCaptureForTipWindow");
  assertStringIncludes(stop, "tipsEnabledForArea");
  assertStringIncludes(stop, "auto_capture_queued");
  assertStringIncludes(stop, "capture_requested");
  // Tip-window deferral requires tips enabled; disabled falls through to auto capture.
  assertStringIncludes(stop, "tipsEnabledForArea &&");
});

Deno.test("#110 P4B PENDING entitlement on complete remains fail-closed", () => {
  assertStringIncludes(stop, "creditTripEarningPending");
  assertStringIncludes(stop, "PENDING_ENTITLEMENT_FAILED");
  assertStringIncludes(stop, "postPendingEntitlement");
});

Deno.test("#110 P4B HTTP finalize invoke remains fallback only", () => {
  assertStringIncludes(immediate, "invokeFinalizeTripCapture");
  assertStringIncludes(immediate, "tip_capture_same_isolate_fallback_http");
});

Deno.test("#110 P4D same-isolate durable settlement parity with HTTP finalize", () => {
  assertStringIncludes(immediate, "persistDurableSettlementOutcomeIfNeeded");
  assertStringIncludes(immediate, "persistDurableSettlementOutcome");
  assertStringIncludes(immediate, "provider_authorisation_missing");
  assertStringIncludes(immediate, "resolveTrustedCaptureTipPence");
  assertStringIncludes(immediate, "durableSettlementOutcomeSSOT");
});
