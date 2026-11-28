/**
 * #111B/#111C LOCK — terminal fee policy SSOT.
 * CANCELLED_WITH_FEE settle gate is ON (owner-approved #111C), prospective from the cutover.
 * Driver net formula for chargeable terminal fees: capture − ACTUAL fee; commission 0.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  TERMINAL_FEE_SETTLE_CANCELLED_WITH_FEE,
  TERMINAL_FEE_UNIFIED_POLICY_CUTOVER_ISO,
  TERMINAL_FEE_POLICY_VERSION,
  isUnifiedTerminalFeePolicyActive,
  TERMINAL_EARNING_CATEGORY,
  buildTerminalFeeLedgerMetadata,
  earningCategoryForTerminalOutcome,
  shouldSettleCancelledWithFeeAsTerminalTen,
  terminalFeeLedgerDescription,
  resolveTerminalEarningCategoryFromEvidence,
} from "./offline/terminalFeePolicySSOT.ts";
import { computeTerminalOutcomeEntitlement } from "../../functions/_shared/terminalOutcomeEntitlementSSOT.ts";

Deno.test("#111C CANCELLED_WITH_FEE settle gate is true with a documented UTC cutover", () => {
  assertEquals(TERMINAL_FEE_SETTLE_CANCELLED_WITH_FEE, true);
  assertEquals(shouldSettleCancelledWithFeeAsTerminalTen(), true);
  assertEquals(TERMINAL_FEE_UNIFIED_POLICY_CUTOVER_ISO, "2026-11-27T04:00:00.000Z");
  assertEquals(TERMINAL_FEE_POLICY_VERSION, "terminal_fee_capture_minus_actual_provider_fee_v1");
});

Deno.test("#111C isUnifiedTerminalFeePolicyActive is prospective and fails closed", () => {
  assertEquals(isUnifiedTerminalFeePolicyActive("2026-11-27T03:59:59.999Z"), false);
  assertEquals(isUnifiedTerminalFeePolicyActive("2026-11-27T04:00:00.000Z"), true);
  assertEquals(isUnifiedTerminalFeePolicyActive("2026-12-01T00:00:00.000Z"), true);
  assertEquals(isUnifiedTerminalFeePolicyActive(null), false);
  assertEquals(isUnifiedTerminalFeePolicyActive(undefined), false);
  assertEquals(isUnifiedTerminalFeePolicyActive("not-a-date"), false);
});

Deno.test("#111C CANCELLED_WITH_FEE maps to other_cancellation_earning with commission 0 metadata", () => {
  assertEquals(
    earningCategoryForTerminalOutcome("CANCELLED_WITH_FEE"),
    TERMINAL_EARNING_CATEGORY.OTHER_CANCELLATION,
  );
  assertStringIncludes(
    terminalFeeLedgerDescription({ outcome: "CANCELLED_WITH_FEE", currency: "GBP", amountPence: 376 }),
    "Cancellation compensation",
  );
  const meta = buildTerminalFeeLedgerMetadata({
    outcome: "CANCELLED_WITH_FEE",
    capturedPence: 400,
    providerFeePence: 24,
    entitlementPence: 376,
    formulaVersion: "2",
  });
  assertEquals(meta.earning_category, "other_cancellation_earning");
  assertEquals(meta.commission_pence, 0);
  assertEquals(meta.policy, TERMINAL_FEE_POLICY_VERSION);
});

Deno.test("#111B earning categories cover no-show / arrival / late / other", () => {
  assertEquals(earningCategoryForTerminalOutcome("NO_SHOW"), TERMINAL_EARNING_CATEGORY.NO_SHOW);
  assertEquals(
    earningCategoryForTerminalOutcome("ARRIVAL_CANCELLATION"),
    TERMINAL_EARNING_CATEGORY.ARRIVAL_CANCELLATION,
  );
  assertEquals(
    earningCategoryForTerminalOutcome("LATE_PASSENGER_CANCELLATION"),
    TERMINAL_EARNING_CATEGORY.LATE_CANCELLATION,
  );
  assertEquals(
    earningCategoryForTerminalOutcome("OTHER_CANCELLATION"),
    TERMINAL_EARNING_CATEGORY.OTHER_CANCELLATION,
  );
});

Deno.test("#111B ledger metadata stamps commission 0 + earning_category", () => {
  const meta = buildTerminalFeeLedgerMetadata({
    outcome: "NO_SHOW",
    capturedPence: 450,
    providerFeePence: 24,
    entitlementPence: 426,
    formulaVersion: "2",
  });
  assertEquals(meta.earning_category, "no_show_earning");
  assertEquals(meta.commission_pence, 0);
  assertEquals(meta.captured_pence, 450);
  assertEquals(meta.provider_fee_pence, 24);
  assertEquals(meta.entitlement_pence, 426);
});

Deno.test("#111B entitlement is capture minus ACTUAL provider fee (commission 0)", () => {
  const result = computeTerminalOutcomeEntitlement({
    payment_session_id: "ps",
    captured_pence: 450,
    provider_fee_pence: 24,
    provider_fee_confirmed: true,
  });
  assertEquals(result.pending, false);
  assertEquals(result.commission_pence, 0);
  assertEquals(result.expected_driver_entitlement_pence, 426);
});

Deno.test("#111B descriptions are stable Wallet classifiers (fallback)", () => {
  assertStringIncludes(
    terminalFeeLedgerDescription({ outcome: "NO_SHOW", currency: "GBP", amountPence: 426 }),
    "No-show",
  );
  assertStringIncludes(
    terminalFeeLedgerDescription({
      outcome: "ARRIVAL_CANCELLATION",
      currency: "GBP",
      amountPence: 376,
    }),
    "Arrival cancellation",
  );
});

Deno.test("#111B historical category resolution prefers metadata then outcome/description", () => {
  assertEquals(
    resolveTerminalEarningCategoryFromEvidence({
      metadata: { earning_category: "no_show_earning" },
      description: "Card trip",
    }),
    "no_show_earning",
  );
  assertEquals(
    resolveTerminalEarningCategoryFromEvidence({
      financialOutcome: "ARRIVAL_CANCELLATION",
    }),
    "arrival_cancellation_earning",
  );
  assertEquals(
    resolveTerminalEarningCategoryFromEvidence({
      description: "No-show compensation (ONECAB) — GBP 4.26",
    }),
    "no_show_earning",
  );
  assertEquals(
    resolveTerminalEarningCategoryFromEvidence({
      financialOutcome: "CANCELLED_WITH_FEE",
    }),
    "other_cancellation_earning",
  );
});
