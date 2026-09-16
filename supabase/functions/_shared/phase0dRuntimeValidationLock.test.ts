/**
 * Phase 0d — terminal fee resumption + edge caller contract locks.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROOT));
}

Deno.test("TERMINAL_FEE_RESUME: revolut-webhook persists fee and resumes terminal settlement", async () => {
  const webhook = await read("revolut-webhook/index.ts");
  const backfill = await read("revolut-backfill-provider-fees/index.ts");
  const resume = await read("_shared/terminalFeeSettlementResumptionSSOT.ts");
  assertEquals(webhook.includes("settleNoShowFee"), false);
  assertStringIncludes(webhook, "persistProviderFeeAndMaybeResumeTerminalSettlement");
  assertStringIncludes(backfill, "persistProviderFeeAndMaybeResumeTerminalSettlement");
  assertStringIncludes(resume, "postTerminalEntitlementFromSettlement");
  assertStringIncludes(resume, "maybeResumeTerminalFeeSettlementAfterProviderFee");
});

Deno.test("TERMINAL_FEE_PENDING: record-financial-outcome can repair missing ledger on service call", async () => {
  const src = await read("record-financial-outcome/index.ts");
  assertStringIncludes(src, "postTerminalOutcomeSettlement");
  assertStringIncludes(src, "missing ledger entries — repairing");
});

Deno.test("edge caller: driver-withdraw uses automated RPC directly", async () => {
  const src = await read("driver-withdraw/index.ts");
  assertStringIncludes(src, "finalize_driver_payout_completion");
  assertEquals(src.includes("finalize_manual_external_payout_completion"), false);
});

Deno.test("edge caller: admin-finalize uses automated RPC", async () => {
  const src = await read("admin-finalize-driver-payout-completion/index.ts");
  assertStringIncludes(src, "finalize_driver_payout_completion");
});

Deno.test("edge caller: admin-mark-manual uses manual external path via payoutLedgerSync", async () => {
  const src = await read("admin-mark-manual-payout-paid/index.ts");
  const sync = await read("_shared/payoutLedgerSync.ts");
  assertStringIncludes(src, "finalizePayoutAfterProviderSuccess");
  assertStringIncludes(sync, "invokeManualExternalPayoutCompletion");
  assertStringIncludes(sync, "finalizeManualExternalPayout");
});

Deno.test("edge caller: payoutLedgerSync automated vs manual split", async () => {
  const src = await read("_shared/payoutLedgerSync.ts");
  const rpc = await read("_shared/payoutCompletionRpcSSOT.ts");
  assertStringIncludes(src, "invokeAutomatedPayoutCompletion");
  assertStringIncludes(src, "invokeManualExternalPayoutCompletion");
  assertStringIncludes(rpc, "finalize_manual_external_payout_completion");
  const manualBlock = src.slice(src.indexOf("export async function finalizeManualExternalPayout"), src.indexOf("/** Path A"));
  const automatedBlock = src.slice(src.indexOf("export async function finalizeAutomatedPayoutAfterProviderSuccess"), src.indexOf("/** @deprecated"));
  assertEquals(manualBlock.includes("invokeAutomatedPayoutCompletion"), false);
  assertEquals(automatedBlock.includes("invokeManualExternalPayoutCompletion"), false);
});

Deno.test("edge caller: driverWithdrawProviderReconcile direct RPC", async () => {
  const src = await read("_shared/driverWithdrawProviderReconcile.ts");
  assertStringIncludes(src, "finalize_driver_payout_completion");
});

Deno.test("edge caller: admin-execute-weekly-payout-occurrence direct RPC", async () => {
  const src = await read("admin-execute-weekly-payout-occurrence/index.ts");
  assertStringIncludes(src, "finalize_driver_payout_completion");
});

Deno.test("payoutCompletionRpcSSOT matches SQL signatures", async () => {
  const src = await read("_shared/payoutCompletionRpcSSOT.ts");
  assertStringIncludes(src, "p_payout_item_id");
  assertStringIncludes(src, "p_provider_payment_id");
  assertStringIncludes(src, "p_external_reference");
  assertStringIncludes(src, "p_operator_reason");
});
