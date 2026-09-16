/**
 * Phase 0c safety closure — structural re-audit gate tests.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FINANCIAL_MODEL,
  resolveFinancialModelStamp,
  classifyTripForPlatformCollectedAdminPage,
  countUnknownFinancialModelTrips,
} from "../../../shared/financialModelScopeSSOT.ts";
import { DRIVER_EARNING_SETTLEMENT_ROLE } from "./driverEarningSettlementOwnershipSSOT.ts";

const REQUIRED_AUTOMATED_RPC_CHECKS = [
  "assert_payout_item_ledger_lineage",
  "PAYOUT_LINEAGE_MISMATCH",
  "PROVIDER_NOT_COMPLETED",
  "MISSING_PROVIDER_PAYMENT_ID",
  "PAYOUT_ITEM_NOT_SUBMITTED",
  "RESERVATION_NOT_ACTIVE",
  "DRIVER_MISMATCH",
  "AMOUNT_MISMATCH",
  "already_applied",
  "REVOKE ALL",
  "GRANT EXECUTE",
  "service_role",
];

const REQUIRED_MANUAL_RPC_CHECKS = [
  "MISSING_OPERATOR_REASON",
  "MISSING_EXTERNAL_REFERENCE",
  "CROSS_DRIVER_REFERENCE_REUSE",
  "DUPLICATE_EXTERNAL_REFERENCE",
  "assert_payout_item_ledger_lineage",
  "REVOKE ALL",
  "FROM anon",
  "FROM authenticated",
  "service_role",
  "admin_payment_audit",
];

Deno.test("DIRECT_PAYOUT_RPC_INVARIANTS_ENFORCED in SQL migration", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260901130000_payout_rpc_invariant_hardening.sql", import.meta.url),
  );
  for (const check of REQUIRED_AUTOMATED_RPC_CHECKS) {
    assertStringIncludes(sql, check, `missing ${check}`);
  }
});

Deno.test("MANUAL_EXTERNAL_RPC_SECURE in SQL migration", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260930240000_manual_external_payout_completion_atomic.sql", import.meta.url),
  );
  for (const check of REQUIRED_MANUAL_RPC_CHECKS) {
    assertStringIncludes(sql, check, `missing ${check}`);
  }
});

Deno.test("FINANCIAL_MODEL_READ_FALLBACKS removed from scope SSOT", () => {
  assertEquals(resolveFinancialModelStamp(null), FINANCIAL_MODEL.UNKNOWN);
  assertEquals(resolveFinancialModelStamp(""), FINANCIAL_MODEL.UNKNOWN);
  assertEquals(resolveFinancialModelStamp("PLATFORM_COLLECTED"), FINANCIAL_MODEL.PLATFORM_COLLECTED);
  const nullTrip = classifyTripForPlatformCollectedAdminPage({ financial_model: null });
  assertEquals(nullTrip.includeOnPlatformPage, false);
});

Deno.test("unknown financial_model trips counted for admin issues", () => {
  const n = countUnknownFinancialModelTrips([
    { financial_model: null },
    { financial_model: "PLATFORM_COLLECTED" },
    { financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET" },
    { financial_model: "LEGACY" },
  ]);
  assertEquals(n, 2);
});

Deno.test("model-scoped driver financial summary views exist locally", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260901140000_model_scoped_driver_financial_summary.sql", import.meta.url),
  );
  assertStringIncludes(sql, "platform_collected_driver_financial_summary");
  assertStringIncludes(sql, "commission_wallet_driver_financial_summary");
  assertStringIncludes(sql, "driver_commission_wallet_ledger");
});

Deno.test("COMMISSION_WALLET_READ_LEAKAGE = 0 on PLATFORM pages", async () => {
  const pages = [
    "../../../src/pages/PaymentSessions.tsx",
    "../../../src/pages/FinancialReconciliation.tsx",
    "../../../src/pages/DriverWalletLedger.tsx",
    "../../../src/pages/PayoutLedger.tsx",
  ];
  for (const rel of pages) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    assertEquals(src.includes("commission_wallet_ledger"), false, rel);
    assertEquals(src.includes("driver_commission_wallet_ledger"), false, rel);
  }
});

Deno.test("DRIVER_EARNING_SETTLEMENT_ROLE = AUDIT_COMPANION", () => {
  assertEquals(DRIVER_EARNING_SETTLEMENT_ROLE, "AUDIT_COMPANION");
});

Deno.test("production count report script exists (read-only)", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../../scripts/fr-financial-model-counts.sql", import.meta.url),
  );
  assertStringIncludes(sql, "platform_collected");
  assertStringIncludes(sql, "null_financial_model");
});

Deno.test("payout TS wrapper does not replace SQL invariant enforcement", async () => {
  const rpc = await Deno.readTextFile(new URL("./payoutCompletionRpcSSOT.ts", import.meta.url));
  assertEquals(rpc.includes("reserve_driver_payout"), false);
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260901130000_payout_rpc_invariant_hardening.sql", import.meta.url),
  );
  assertStringIncludes(sql, "PERFORM public.assert_payout_item_ledger_lineage");
  assertEquals(sql.includes("payoutCompletionRpcSSOT"), false);
});

Deno.test("DIRECT_RPC_BYPASS_SAFE — automated callers may invoke SQL directly", async () => {
  const callers = [
    "../driver-withdraw/index.ts",
    "../admin-finalize-driver-payout-completion/index.ts",
    "./driverWithdrawProviderReconcile.ts",
  ];
  for (const rel of callers) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    assertStringIncludes(src, "finalize_driver_payout_completion");
  }
});
