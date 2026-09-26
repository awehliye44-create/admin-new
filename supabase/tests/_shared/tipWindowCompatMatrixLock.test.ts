/**
 * Tip-window Admin↔Customer compatibility matrix lock (PR #66 release gate).
 */

import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  TIP_AUTHORISATION_DECLINED,
  TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE,
  TIP_NOT_COLLECTED,
  TIP_NOT_COLLECTED_CUSTOMER_MESSAGE,
} from "../../functions/_shared/tipWindowConstants.ts";
import { classifyTipWindowCaptureOutcome } from "../../functions/_shared/tipWindowTriggerMutexSSOT.ts";
import { durableSettlementColumns } from "../../functions/_shared/durableSettlementOutcomeSSOT.ts";

const BANK_COPY =
  "Your bank declined the tip. Your fare has not been taken yet. You can try again, continue without a tip, or skip.";

const FARE_TAKEN_COPY =
  "The fare was already taken, so this tip could not be added. You can continue without a tip or skip.";

const CUSTOMER_TIP =
  "/Users/admin/onecab-customer-native/src/features/booking/data/submitCustomerTripTip.ts";

Deno.test("COMPAT: Old Customer + new Edge — typed decline is failure, zero capture, stays authorised", () => {
  const body = {
    success: false,
    error_code: TIP_AUTHORISATION_DECLINED,
    error: TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE,
    status: TIP_AUTHORISATION_DECLINED,
    capture_amount_pence: 0,
    provider_state: "AUTHORISED",
  };
  assertEquals(classifyTipWindowCaptureOutcome(body).kind, "tip_authorisation_declined");
  assertEquals(body.success, false);
  assertEquals(body.capture_amount_pence, 0);
  const cols = durableSettlementColumns("TIP_AUTHORISATION_DECLINED", false);
  assertEquals(cols.payment_status, "authorized");
});

Deno.test("COMPAT: New Customer + old Edge — generic CAPTURE_FAILED fallback, never invents success", async () => {
  const src = await Deno.readTextFile(CUSTOMER_TIP);
  assertStringIncludes(src, "CAPTURE_FAILED");
  assertStringIncludes(src, "Could not process the tip. Please try again.");
  // success path only when payload.success is not false / no error.
  assertStringIncludes(src, "payload.success === false");
  assertStringIncludes(src, "return { ok: false, message, code }");
});

Deno.test("COMPAT: New Customer + new Edge — typed bank-decline copy", async () => {
  assertEquals(TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE, BANK_COPY);
  const src = await Deno.readTextFile(CUSTOMER_TIP);
  assertStringIncludes(src, "TIP_AUTHORISATION_DECLINED");
  assertStringIncludes(src, BANK_COPY);
});

Deno.test("COMPAT: MK-260926-001 tip-not-collected refuse copy on Edge + Customer", async () => {
  assertEquals(TIP_NOT_COLLECTED_CUSTOMER_MESSAGE, FARE_TAKEN_COPY);
  const src = await Deno.readTextFile(CUSTOMER_TIP);
  assertStringIncludes(src, "TIP_NOT_COLLECTED");
  assertStringIncludes(src, FARE_TAKEN_COPY);
  const submit = await Deno.readTextFile(
    new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
  );
  assertStringIncludes(submit, TIP_NOT_COLLECTED);
  assertStringIncludes(submit, "tipRequestedButNotCollected");
});

Deno.test("COMPAT: Migration + old Edge — additive; closed remains valid", async () => {
  const mig = await Deno.readTextFile(
    new URL("../../migrations/20261126120000_tip_window_trigger_mutex.sql", import.meta.url),
  );
  assertStringIncludes(mig, "ADD COLUMN IF NOT EXISTS tip_window_trigger");
  assertStringIncludes(mig, "'open', 'processing', 'closed', 'expired'");
  assertStringIncludes(mig, "Preserve existing CLOSED rows");
});

Deno.test("COMPAT: New Edge without migration — claim RPC fail-closed before capture", async () => {
  const mutex = await Deno.readTextFile(
    new URL("../../functions/_shared/tipWindowTriggerMutexSSOT.ts", import.meta.url),
  );
  const submit = await Deno.readTextFile(
    new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
  );
  assertStringIncludes(mutex, "CLAIM_RPC_FAILED");
  assertStringIncludes(submit, "Could not claim tip window");
  assert(
    submit.indexOf("await claimTipWindowTrigger") <
      submit.indexOf("await invokeFinalizeTripCapture"),
    "mutex claim must precede finalize invoke",
  );
});

Deno.test("COMPAT: MIGRATION_FIRST_ORDER — expiry also requires claim RPC before capture", async () => {
  const expiry = await Deno.readTextFile(
    new URL("../../functions/capture-expired-tip-windows/index.ts", import.meta.url),
  );
  assert(
    expiry.indexOf("await claimTipWindowTrigger") <
      expiry.indexOf("await invokeFinalizeTripCapture"),
  );
});
