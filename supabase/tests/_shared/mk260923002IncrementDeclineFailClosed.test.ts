/**
 * MK-260923-002 — definitive increment decline must fail closed (not payment_unknown).
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/mk260923002IncrementDeclineFailClosed.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideFromPreauthInvokeResult,
} from "../../functions/_shared/tripModificationPaymentGateSSOT.ts";
import {
  isStructuredPreauthOutcome,
  parsePreauthInvokeErrorBody,
} from "../../functions/_shared/tripModificationApply.ts";

Deno.test("A: 500→1241 confirmed maps to PROVIDER_CONFIRMED", () => {
  const d = decideFromPreauthInvokeResult({
    success: true,
    requiredPayablePence: 1241,
    authorisedAmountPence: 1241,
    paymentCoverageStatus: "authorization_sufficient",
  });
  assertEquals(d.phase, "PROVIDER_CONFIRMED");
  assertEquals(d.mayApply, true);
  assertEquals(d.requestStatus, "payment_confirmed");
});

Deno.test("B: 500→1241 definitive decline → payment_failed, tripUnchanged path", async () => {
  const d = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 1241,
    authorisedAmountPence: 500,
    paymentCoverageStatus: "authorization_insufficient",
    errorCode: "AUTHORISED_TOTAL_BELOW_TARGET",
    warning: "Provider authorised total remains below the required fare.",
  });
  assertEquals(d.phase, "PAYMENT_FAILED");
  assertEquals(d.mayApply, false);
  assertEquals(d.requestStatus, "payment_failed");
  assertEquals(d.paymentStatus, "failed");
  if (d.phase === "PAYMENT_FAILED") assertEquals(d.reason, "declined");

  const exec = await Deno.readTextFile(
    new URL("../../functions/_shared/executeFareIncreaseModificationPayment.ts", import.meta.url),
  );
  assertStringIncludes(exec, "ADDITIONAL_AUTHORISATION_DECLINED");
  assertStringIncludes(exec, "tripUnchanged: true");
  // Decline auth-row safety net must exist.
  assertStringIncludes(exec, "ADDITIONAL_AUTHORISATION_DECLINED");
});

Deno.test("C: genuine timeout stays PAYMENT_PENDING / unknown", () => {
  const d = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 1241,
    authorisedAmountPence: 500,
    paymentCoverageStatus: "authorization_reconciliation_pending",
    errorCode: "TIMEOUT",
    warning: "timeout waiting for provider",
  });
  assertEquals(d.phase, "PAYMENT_PENDING");
  assertEquals(d.mayApply, false);
  if (d.phase === "PAYMENT_PENDING") assertEquals(d.reason, "timeout");
});

Deno.test("D: declined then success is a new gate decision (retry creates new attempt)", async () => {
  const first = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 1241,
    authorisedAmountPence: 500,
    paymentCoverageStatus: "authorization_insufficient",
    errorCode: "AUTHORISED_TOTAL_BELOW_TARGET",
  });
  assertEquals(first.phase, "PAYMENT_FAILED");

  const second = decideFromPreauthInvokeResult({
    success: true,
    requiredPayablePence: 1241,
    authorisedAmountPence: 1241,
    paymentCoverageStatus: "authorization_sufficient",
  });
  assertEquals(second.phase, "PROVIDER_CONFIRMED");
  assertEquals(second.mayApply, true);

  // payment_failed is not an open mod lock — retry inserts a new change request.
  const request = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  assertStringIncludes(request, '"payment_required"');
  assertStringIncludes(request, '"payment_pending"');
  assertEquals(request.includes('"payment_failed"'), false);
});

Deno.test("E: declined add_stop never claims apply RPC before fail return", async () => {
  const exec = await Deno.readTextFile(
    new URL("../../functions/_shared/executeFareIncreaseModificationPayment.ts", import.meta.url),
  );
  const failIdx = exec.indexOf("if (!gate.mayApply)");
  const claimIdx = exec.indexOf("claim_and_apply_fare_increase_modification");
  assertEquals(failIdx >= 0 && claimIdx > failIdx, true);
});

Deno.test("F: HTTP 409 structured decline body is preserved by invoke helpers", async () => {
  const declineBody = {
    success: false,
    error: "Provider authorised total remains below the required fare.",
    warning: "Provider authorised total remains below the required fare.",
    payment_coverage_status: "authorization_insufficient",
    error_code: "AUTHORISED_TOTAL_BELOW_TARGET",
    authorised_amount_pence: 500,
  };
  assertEquals(isStructuredPreauthOutcome(declineBody), true);

  const parsed = await parsePreauthInvokeErrorBody({
    message: "Edge Function returned a non-2xx status code",
    context: {
      json: async () => declineBody,
    },
  });
  assertEquals(parsed?.error_code, "AUTHORISED_TOTAL_BELOW_TARGET");
  assertEquals(parsed?.payment_coverage_status, "authorization_insufficient");

  const mapped = decideFromPreauthInvokeResult({
    success: parsed?.success === true,
    paymentCoverageStatus: String(parsed?.payment_coverage_status ?? ""),
    authorisedAmountPence: Number(parsed?.authorised_amount_pence ?? 0),
    requiredPayablePence: 1241,
    errorCode: String(parsed?.error_code ?? ""),
    warning: String(parsed?.warning ?? parsed?.error ?? ""),
  });
  assertEquals(mapped.phase, "PAYMENT_FAILED");
  assertEquals(mapped.requestStatus, "payment_failed");
  // Must never collapse to payment_unknown / payment_pending.
  assertEquals(mapped.phase === "PAYMENT_PENDING", false);
});

Deno.test("invokePreauthUpdateOnModification preserves structured errors (source lock)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/tripModificationApply.ts", import.meta.url),
  );
  assertStringIncludes(src, "parsePreauthInvokeErrorBody");
  assertStringIncludes(src, "isStructuredPreauthOutcome");
  assertStringIncludes(src, "TRIP_MODIFICATION_PREAUTH_STRUCTURED_ERROR");
  // Must not only special-case checkout and then throw away decline bodies.
  const checkoutOnlyThrow =
    src.includes("requires_revolut_checkout === true")
    && !src.includes("isStructuredPreauthOutcome");
  assertEquals(checkoutOnlyThrow, false);
});

Deno.test("observability persists provider increment evidence without inventing reasons", async () => {
  const exec = await Deno.readTextFile(
    new URL("../../functions/_shared/executeSameOrderIncrementSSOT.ts", import.meta.url),
  );
  assertStringIncludes(exec, "provider_increment_state");
  assertStringIncludes(exec, "provider_decline_reason");
  assertStringIncludes(exec, "provider_error_code");
  assertStringIncludes(exec, "Never invent issuer reasons");
});
