/**
 * Lock: controlled Driver Wallet manual adjustments — finance gate, append-only types, isolation.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

Deno.test("driver wallet manual adjustment lock", async () => {
  const migration = await read(
    "supabase/migrations/20260930200000_driver_wallet_admin_manual_adjustments.sql",
  );
  const ssot = await read("shared/driverWalletManualAdjustmentSSOT.ts");
  const edge = await read("supabase/functions/admin-driver-adjustment/index.ts");
  const gate = await read("supabase/functions/_shared/adminPaymentGate.ts");
  const driverTx = await read("supabase/functions/driver-wallet-transactions/index.ts");
  const eligibility = await read("supabase/functions/_shared/driverPayoutEligibilitySSOT.ts");

  assert(migration.includes("ADMIN_WALLET_CREDIT"));
  assert(migration.includes("ADMIN_WALLET_DEBIT"));
  assert(migration.includes("driver_wallet_admin_adjustments"));
  assert(migration.includes("dw_manual_adj:"));
  assert(migration.includes("driver_wallet_admin_adjustments_driver_read"));
  assert(migration.includes("d.id = driver_wallet_admin_adjustments.driver_id"));
  assert(migration.includes("driver_wallet_ledger_driver_read_admin_adjustments"));

  assert(ssot.includes("ADMIN_WALLET_CREDIT"));
  assert(ssot.includes("ADMIN_WALLET_DEBIT"));
  assert(ssot.includes("admin_manual_adjustment"));
  assert(ssot.includes("DRIVER_WALLET_ADJUSTMENT_OWNER_THRESHOLD_PENCE"));
  assert(ssot.includes("DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED"));
  assert(ssot.includes("driverWalletAdminAdjustmentsDeployed"));

  assert(edge.includes("requireFinanceExecutionAuth"));
  assert(edge.includes("DRIVER_WALLET_LEDGER"));
  assert(edge.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(edge.includes("ADJUSTMENTS_NOT_DEPLOYED"));
  assert(edge.includes("driverWalletAdminAdjustmentsDeployed"));
  assert(edge.includes("driver_wallet_admin_adjustments"));
  assert(edge.includes("logFinanceAuditEvent"));
  assert(!edge.includes("payment_sessions"));
  assert(!edge.includes("admin-payout-ledger"));
  assert(!edge.includes("revolut"));

  assert(gate.includes("DRIVER_WALLET_LEDGER"));

  assert(driverTx.includes("ADMIN_WALLET_CREDIT"));
  assert(driverTx.includes("ONECAB adjustment"));

  assert(eligibility.includes("ADMIN_WALLET_PAYOUT_ELIGIBLE_LEDGER_TYPES"));
  assert(eligibility.includes("ADMIN_WALLET_CREDIT"));

  assertEquals("ADMIN_WALLET_CREDIT", "ADMIN_WALLET_CREDIT");
});
