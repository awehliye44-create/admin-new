/**
 * Bug #28 — trip modification payment notification / terminal classification lock.
 * MK-261115-014: structured 409 PROVIDER_INCREMENT_FAILED must not become pending.
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/bug28TripModPaymentNotificationLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canPendingOverwriteModificationRequestStatus,
  decideFromPreauthInvokeResult,
  gateFromTerminalAuthorisationStatus,
  invokeErrorBodyHasPaymentStructure,
  isTerminalAdditionalAuthorisationStatus,
  TERMINAL_ADDITIONAL_AUTHORISATION_STATUSES,
} from "../../functions/_shared/tripModificationPaymentGateSSOT.ts";

const APPLY_SRC = await Deno.readTextFile(
  new URL("../../functions/_shared/tripModificationApply.ts", import.meta.url),
);
const EXEC_SRC = await Deno.readTextFile(
  new URL("../../functions/_shared/executeFareIncreaseModificationPayment.ts", import.meta.url),
);
const GATE_SRC = await Deno.readTextFile(
  new URL("../../functions/_shared/tripModificationPaymentGateSSOT.ts", import.meta.url),
);

Deno.test("Bug #28 — MK-261115-014 fixture: 409 PROVIDER_INCREMENT_FAILED → PAYMENT_FAILED technical", () => {
  // Isolated fixture mirroring MK-261115-014 structured update-preauth body.
  const gate = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 898,
    authorisedAmountPence: 671,
    paymentCoverageStatus: "authorization_provider_failed",
    errorCode: "PROVIDER_INCREMENT_FAILED",
    warning: "Incremental authorisation failed",
  });
  assertEquals(gate.phase, "PAYMENT_FAILED");
  assertEquals(gate.mayApply, false);
  if (gate.phase === "PAYMENT_FAILED") {
    assertEquals(gate.reason, "failed");
    assertEquals(gate.authorisedTotalPence, 671);
  }
});

Deno.test("Bug #28 — explicit issuer decline stays PAYMENT_FAILED declined", () => {
  const gate = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 898,
    authorisedAmountPence: 671,
    paymentCoverageStatus: "authorization_insufficient",
    errorCode: "AUTHORISED_TOTAL_BELOW_TARGET",
    warning: "authorised total remains below the required fare",
  });
  assertEquals(gate.phase, "PAYMENT_FAILED");
  if (gate.phase === "PAYMENT_FAILED") {
    assertEquals(gate.reason, "declined");
  }
});

Deno.test("Bug #28 — genuine pending / timeout / network stay PAYMENT_PENDING", () => {
  for (const errorCode of ["TIMEOUT", "NETWORK", "AUTHORISATION_RECONCILIATION_PENDING"]) {
    const gate = decideFromPreauthInvokeResult({
      success: false,
      requiredPayablePence: 898,
      authorisedAmountPence: 671,
      paymentCoverageStatus: "authorization_reconciliation_pending",
      errorCode,
      warning: errorCode === "TIMEOUT"
        ? "timeout waiting for provider"
        : errorCode === "NETWORK"
        ? "network fetch failed"
        : "ambiguous provider response",
    });
    assertEquals(gate.phase, "PAYMENT_PENDING", errorCode);
    assertEquals(gate.mayApply, false);
  }
});

Deno.test("Bug #28 — HTTP status alone is not payment structure", () => {
  assertEquals(invokeErrorBodyHasPaymentStructure(null), false);
  assertEquals(invokeErrorBodyHasPaymentStructure({}), false);
  assertEquals(invokeErrorBodyHasPaymentStructure({ success: false, error: "boom" }), false);
  assertEquals(
    invokeErrorBodyHasPaymentStructure({
      success: false,
      error_code: "PROVIDER_INCREMENT_FAILED",
      payment_coverage_status: "authorization_provider_failed",
      authorised_amount_pence: 671,
    }),
    true,
  );
});

Deno.test("Bug #28 — FAILED_TERMINAL / DECLINED / UNSUPPORTED safety-net mapping", () => {
  assertEquals(
    TERMINAL_ADDITIONAL_AUTHORISATION_STATUSES.includes(
      "ADDITIONAL_AUTHORISATION_FAILED_TERMINAL",
    ),
    true,
  );
  assertEquals(
    isTerminalAdditionalAuthorisationStatus("ADDITIONAL_AUTHORISATION_FAILED_TERMINAL"),
    true,
  );
  const terminal = gateFromTerminalAuthorisationStatus({
    status: "ADDITIONAL_AUTHORISATION_FAILED_TERMINAL",
    authorisedTotalPence: 671,
  });
  assertEquals(terminal?.phase, "PAYMENT_FAILED");
  if (terminal?.phase === "PAYMENT_FAILED") {
    assertEquals(terminal.reason, "failed");
  }
  const declined = gateFromTerminalAuthorisationStatus({
    status: "ADDITIONAL_AUTHORISATION_DECLINED",
    authorisedTotalPence: 671,
  });
  assertEquals(declined?.phase, "PAYMENT_FAILED");
  if (declined?.phase === "PAYMENT_FAILED") {
    assertEquals(declined.reason, "declined");
  }
  assertEquals(
    gateFromTerminalAuthorisationStatus({
      status: "ADDITIONAL_AUTHORISATION_PENDING",
      authorisedTotalPence: 671,
    }),
    null,
  );
});

Deno.test("Bug #28 — stale pending must not overwrite terminal TCR statuses", () => {
  assertEquals(canPendingOverwriteModificationRequestStatus("payment_pending"), true);
  assertEquals(canPendingOverwriteModificationRequestStatus("payment_required"), true);
  assertEquals(canPendingOverwriteModificationRequestStatus("payment_failed"), false);
  assertEquals(canPendingOverwriteModificationRequestStatus("applied"), false);
  assertEquals(canPendingOverwriteModificationRequestStatus("expired"), false);
});

Deno.test("Bug #28 — invoke parses structured non-2xx; safety net covers FAILED_TERMINAL", () => {
  assertEquals(APPLY_SRC.includes("readFunctionsInvokeErrorBody"), true);
  assertEquals(APPLY_SRC.includes("invokeErrorBodyHasPaymentStructure"), true);
  assertEquals(APPLY_SRC.includes("TRIP_MODIFICATION_PREAUTH_STRUCTURED_ERROR"), true);
  assertEquals(APPLY_SRC.includes("invokeErrorBodyHasPaymentStructure(parsed)"), true);

  assertEquals(EXEC_SRC.includes("TERMINAL_ADDITIONAL_AUTHORISATION_STATUSES"), true);
  assertEquals(EXEC_SRC.includes("gateFromTerminalAuthorisationStatus"), true);
  assertEquals(EXEC_SRC.includes("canPendingOverwriteModificationRequestStatus"), true);
  assertEquals(GATE_SRC.includes("ADDITIONAL_AUTHORISATION_FAILED_TERMINAL"), true);
  assertEquals(GATE_SRC.includes("invokeErrorBodyHasPaymentStructure"), true);
});
