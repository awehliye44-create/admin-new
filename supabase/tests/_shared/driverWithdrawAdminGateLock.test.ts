/**
 * Lock: Admin Slice 7 LIVE=false gate must not block Driver Withdraw.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateDriverWithdrawExecutionGate,
  evaluateSlice7FlagGate,
} from "../../../shared/driverPayoutSubmissionSSOT.ts";

function envOf(map: Record<string, string | undefined>) {
  return { get: (k: string) => map[k] };
}

Deno.test("admin Slice 7 gate still forbids LIVE_PAYOUT_EXECUTION_ENABLED=true", () => {
  const gate = evaluateSlice7FlagGate(
    envOf({
      LIVE_PAYOUT_EXECUTION_ENABLED: "true",
      REVOLUT_PAYMENT_TRANSPORT_ENABLED: "true",
    }),
  );
  assertEquals(gate.ok, false);
  if (!gate.ok) {
    assertEquals(gate.code, "LIVE_AUTOMATIC_EXECUTION_FORBIDDEN");
    assertStringIncludes(gate.message, "Slice 7 admin submission");
  }
});

Deno.test("admin Slice 7 gate allows TRANSPORT=true and LIVE=false", () => {
  const gate = evaluateSlice7FlagGate(
    envOf({
      LIVE_PAYOUT_EXECUTION_ENABLED: "false",
      REVOLUT_PAYMENT_TRANSPORT_ENABLED: "true",
    }),
  );
  assertEquals(gate.ok, true);
});

Deno.test("Driver Withdraw gate does not fail when LIVE=true (today's P0)", () => {
  const gate = evaluateDriverWithdrawExecutionGate(
    envOf({
      LIVE_PAYOUT_EXECUTION_ENABLED: "true",
      REVOLUT_PAYMENT_TRANSPORT_ENABLED: "true",
    }),
  );
  assertEquals(gate.ok, true);
});

Deno.test("Driver Withdraw gate still requires payment transport", () => {
  const gate = evaluateDriverWithdrawExecutionGate(
    envOf({
      LIVE_PAYOUT_EXECUTION_ENABLED: "true",
      REVOLUT_PAYMENT_TRANSPORT_ENABLED: "false",
    }),
  );
  assertEquals(gate.ok, false);
  if (!gate.ok) {
    assertEquals(gate.code, "PAYMENT_TRANSPORT_DISABLED");
  }
});

Deno.test("Driver Withdraw gate message never mentions Slice 7 admin LIVE invariant", () => {
  const blocked = evaluateDriverWithdrawExecutionGate(
    envOf({ REVOLUT_PAYMENT_TRANSPORT_ENABLED: "false" }),
  );
  assertEquals(blocked.ok, false);
  if (!blocked.ok) {
    assertEquals(
      blocked.message.includes("LIVE_PAYOUT_EXECUTION_ENABLED must stay false"),
      false,
    );
  }
});
