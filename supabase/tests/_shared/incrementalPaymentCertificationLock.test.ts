/**
 * Cross-feature + initial-booking + financial-model isolation certification
 * for incremental payment SSOT (phases 8–10).
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SERVICE_AREA_FINANCIAL_MODEL } from "../../functions/_shared/commissionWalletSSOT.ts";

Deno.test("PHASE 8: add_stop / change_dropoff / negotiation follow money-before-mutation", async () => {
  const request = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  assertStringIncludes(request, '"add_stop"');
  assertStringIncludes(request, "change_dropoff");
  assertStringIncludes(request, "executeFareIncreaseModificationPayment");

  const negotiation = await Deno.readTextFile(
    new URL("../../functions/_shared/negotiationPayableAuthorisation.ts", import.meta.url),
  );
  assertStringIncludes(negotiation, "before");
  assertStringIncludes(negotiation, "requiredFarePence");
  assertStringIncludes(negotiation, "prepareRevolutModificationAuthorisation");

  const waiting = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(waiting, "preferSameOrderIncrement: true");
  assertStringIncludes(waiting, "assertPlatformCollectedCompletionPaymentGate");
  assertStringIncludes(waiting, "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED");
});

Deno.test("PHASE 9: initial PLATFORM_COLLECTED booking is money-before-trip", async () => {
  const ctap = await Deno.readTextFile(
    new URL("../../functions/create-trip-after-payment/index.ts", import.meta.url),
  );
  assertStringIncludes(ctap, "verifyRevolutHoldForTripCreateFast");
  assertStringIncludes(ctap, "Payment hold not confirmed. No trip created.");
  assertStringIncludes(ctap, "PAYMENT_SESSION_NOT_AUTHORISED");
  assertStringIncludes(ctap, "FINANCIAL_MODEL_VIOLATION");
  const verifyIdx = ctap.indexOf("verifyRevolutHoldForTripCreateFast");
  const insertMarker = '.from("trips")';
  const insertIdx = ctap.indexOf(insertMarker);
  assertEquals(verifyIdx >= 0, true);
  assertEquals(insertIdx > verifyIdx, true);
});

Deno.test("PHASE 10: PLATFORM increment path forbidden on DRIVER_COLLECTED", async () => {
  const exec = await Deno.readTextFile(
    new URL("../../functions/_shared/executeFareIncreaseModificationPayment.ts", import.meta.url),
  );
  assertStringIncludes(
    exec,
    SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
  );
  assertStringIncludes(exec, "FINANCIAL_MODEL_VIOLATION");
  assertStringIncludes(exec, "platform_collected_cash_forbidden");

  const request = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  assertStringIncludes(request, "platformCollected");
  assertStringIncludes(
    request,
    "fareDeltaPence > 0 && platformCollected",
  );

  const capture = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(
    capture,
    "platform capture forbidden on DRIVER_COLLECTED_COMMISSION_WALLET",
  );
});
