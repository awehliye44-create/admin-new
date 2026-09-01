/**
 * Phase 0b ownership closure — structural lock + re-audit gate tests.
 * Run: deno test --allow-read --no-check supabase/functions/_shared/phase0bOwnershipClosureLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { relative } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  computeAuthoritativeSettlement,
  AUTHORITATIVE_SETTLEMENT_GOLDEN_FIXTURES,
} from "../../../shared/canonicalSettlementSSOT.ts";
import {
  TERMINAL_FEE_LIFECYCLE_PROOF,
  terminalFeeWalletCreditPence,
  hasConflictingEntitlementTypes,
  isDriverEntitlementLedgerType,
} from "./driverEntitlementLedgerSSOT.ts";
import {
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
  evaluateLedgerEntryEligibility,
} from "./driverPayoutEligibilitySSOT.ts";

const ROOT = new URL("../..", import.meta.url).pathname;

const PAYMENT_SESSION_MUTATION_ALLOWLIST = new Set([
  "functions/_shared/paymentSessionMutationCore.ts",
]);

async function collectTsFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of walk(ROOT, {
    exts: [".ts"],
    skip: [/node_modules/, /\.test\.ts$/],
  })) {
    if (entry.isFile) {
      files.push(relative(ROOT, entry.path).replace(/\\/g, "/"));
    }
  }
  return files;
}

Deno.test("PAYMENT_SESSION_DIRECT_BYPASSES = 0 outside mutation core", async () => {
  const pattern = /\.from\(["']payment_sessions["']\)\.update/g;
  const files = await collectTsFiles();
  const bypasses: string[] = [];
  for (const file of files) {
    const src = await Deno.readTextFile(`${ROOT}/${file}`);
    if (!pattern.test(src)) continue;
    if (!PAYMENT_SESSION_MUTATION_ALLOWLIST.has(file)) {
      bypasses.push(file);
    }
  }
  assertEquals(bypasses, [], `Direct payment_sessions.update bypasses: ${bypasses.join(", ")}`);
});

Deno.test("payoutCompletionRpcSSOT has no ensureManualPayoutCompletionPrerequisites", async () => {
  const src = await Deno.readTextFile(new URL("./payoutCompletionRpcSSOT.ts", import.meta.url));
  assertEquals(src.includes("ensureManualPayoutCompletionPrerequisites"), false);
  assertStringIncludes(src, "invokeManualExternalPayoutCompletion");
  assertStringIncludes(src, "invokeAutomatedPayoutCompletion");
  assertStringIncludes(src, "finalize_manual_external_payout_completion");
});

Deno.test("payoutLedgerSync manual path uses atomic RPC only", async () => {
  const src = await Deno.readTextFile(new URL("./payoutLedgerSync.ts", import.meta.url));
  assertEquals(src.includes("ensureManualPayoutCompletionPrerequisites"), false);
  assertStringIncludes(src, "finalizeManualExternalPayout");
  assertStringIncludes(src, "invokeManualExternalPayoutCompletion");
});

Deno.test("SETTLEMENT_FORMULA_AUTHORITIES = 1 via computeAuthoritativeSettlement", async () => {
  const tripSrc = await Deno.readTextFile(new URL("./tripSettlement.ts", import.meta.url));
  assertStringIncludes(tripSrc, "computeAuthoritativeSettlement");
  assertEquals(tripSrc.includes("Math.round((commissionableFarePence * tierPercentUsed)"), false);
});

Deno.test("authoritative settlement golden fixtures balance capture identity", () => {
  for (const fx of AUTHORITATIVE_SETTLEMENT_GOLDEN_FIXTURES) {
    const result = computeAuthoritativeSettlement(fx.input as Parameters<typeof computeAuthoritativeSettlement>[0]);
    if (fx.expected.entitlement != null) {
      assertEquals(result.driver_entitlement_pence, fx.expected.entitlement, fx.label);
    }
    if (fx.expected.commission != null) {
      assertEquals(result.commission_amount_pence, fx.expected.commission, fx.label);
    }
    if (fx.expected.subsidy != null) {
      assertEquals(result.promotion_subsidy_pence, fx.expected.subsidy, fx.label);
    }
  }
});

Deno.test("terminal fee lifecycle proof — 400 capture / 24 fee / 376 entitlement", () => {
  assertEquals(TERMINAL_FEE_LIFECYCLE_PROOF.entitlement_pence, 376);
  assertEquals(
    terminalFeeWalletCreditPence({
      captured_pence: 400,
      provider_fee_pence: 24,
      commission_pence: 0,
    }),
    376,
  );
  assertEquals(TERMINAL_FEE_LIFECYCLE_PROOF.clearing_delay_hours, DEFAULT_PAYOUT_CLEARING_DELAY_HOURS);
});

Deno.test("DRIVER_COMPENSATION_CREDIT is payout-eligible (terminal entitlement family)", () => {
  const now = new Date();
  const created = new Date(now.getTime() - 28 * 60 * 60 * 1000).toISOString();
  const result = evaluateLedgerEntryEligibility({
    ledger_entry_id: "le-1",
    trip_id: "trip-1",
    trip_exists: true,
    ledger_type: "DRIVER_COMPENSATION_CREDIT",
    amount_pence: 376,
    payment_session_id: "ps-1",
    captured_amount_pence: 400,
    canonical_driver_net_pence: null,
    financial_model: "PLATFORM_COLLECTED",
    earning_credited_at: created,
    completed_at: created,
    trip_status: "no_show",
  });
  assertEquals(result.status, "ELIGIBLE");
  assertEquals(result.payable_pence, 376);
});

Deno.test("duplicate TRIP_EARNING_NET + DRIVER_COMPENSATION on same trip is forbidden", () => {
  assertEquals(
    hasConflictingEntitlementTypes(["TRIP_EARNING_NET", "DRIVER_COMPENSATION_CREDIT"]),
    true,
  );
  assertEquals(hasConflictingEntitlementTypes(["TRIP_EARNING_NET"]), false);
});

Deno.test("driver entitlement family includes canonical types", () => {
  assertEquals(isDriverEntitlementLedgerType("TRIP_EARNING_NET"), true);
  assertEquals(isDriverEntitlementLedgerType("DRIVER_COMPENSATION_CREDIT"), true);
  assertEquals(isDriverEntitlementLedgerType("COMMISSION_WALLET"), false);
});

Deno.test("automated payout rejects provider pending (structural)", async () => {
  const src = await Deno.readTextFile(new URL("./payoutCompletionRpcSSOT.ts", import.meta.url));
  assertStringIncludes(src, "PROVIDER_NOT_COMPLETED");
  assertStringIncludes(src, "RESERVATION_NOT_ACTIVE");
  assertStringIncludes(src, "PAYOUT_ITEM_NOT_SUBMITTED");
});
