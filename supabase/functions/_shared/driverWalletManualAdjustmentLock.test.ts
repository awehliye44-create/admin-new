/**
 * Lock: controlled Driver Wallet manual adjustments — schema park + deployed flag.
 * Enablement auth/copy/matrix covered in driverWalletManualAdjustmentEnablementLock.test.ts.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

Deno.test("driver wallet manual adjustment schema park lock", async () => {
  const migration = await read(
    "supabase/migrations/20260930200000_driver_wallet_admin_manual_adjustments.sql",
  );
  const ssot = await read("shared/driverWalletManualAdjustmentSSOT.ts");
  const edge = await read("supabase/functions/admin-driver-adjustment/index.ts");
  const gate = await read("supabase/functions/_shared/adminPaymentGate.ts");
  const eligibility = await read("supabase/functions/_shared/driverPayoutEligibilitySSOT.ts");
  const ledgerPage = await read("src/pages/DriverWalletLedger.tsx");

  // Flag enabled; park error path still present for rollback.
  assert(ssot.includes("DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED = true"));
  assert(ssot.includes("driverWalletAdminAdjustmentsDeployed"));
  assert(edge.includes("ADJUSTMENTS_NOT_DEPLOYED"));
  assert(edge.includes("driverWalletAdminAdjustmentsDeployed"));
  assert(ledgerPage.includes("driverWalletAdminAdjustmentsDeployed"));

  // Migration: staff_role-typed comparisons only (no failing text[] cast on staff_role).
  assert(migration.includes("::public.staff_role[]"));
  assert(!migration.includes("ARRAY['super_admin'::text"));
  assert(!migration.includes("sp.role::text = ANY"));
  assert(!migration.includes("rpp.role = sp.role::text"));

  // Migration closes authenticated client writes on driver_wallet_ledger.
  assert(migration.includes('DROP POLICY IF EXISTS "Admins can manage driver wallet ledger"'));
  assert(migration.includes("driver_wallet_ledger_finance_read"));
  assert(migration.includes("FOR SELECT"));
  assert(migration.includes('"Service role can manage wallet ledger"'));
  assert(!/CREATE POLICY\s+"Admins can manage driver wallet ledger"/i.test(migration));
  // No authenticated INSERT/UPDATE/DELETE/ALL policy recreated for ledger writes.
  assert(!/CREATE POLICY[\s\S]{0,200}ON public\.driver_wallet_ledger[\s\S]{0,80}FOR (INSERT|UPDATE|DELETE|ALL)/i.test(
    migration.replace(/CREATE POLICY "Service role can manage wallet ledger"[\s\S]*?;/g, ""),
  ));

  // Adjustment ledger types only — ADMIN_WALLET_* ; no DML posting TRIP_EARNING_NET.
  assert(migration.includes("ADMIN_WALLET_CREDIT"));
  assert(migration.includes("ADMIN_WALLET_DEBIT"));
  assert(migration.includes("CHECK (ledger_type = ANY (ARRAY['ADMIN_WALLET_CREDIT'::text, 'ADMIN_WALLET_DEBIT'::text]))"));
  assert(!/INSERT\s+INTO\s+public\.driver_wallet_ledger/i.test(migration));
  assert(!/INSERT\s+INTO\s+driver_wallet_ledger/i.test(migration));

  assert(migration.includes("driver_wallet_admin_adjustments"));
  assert(migration.includes("dw_manual_adj:"));
  assert(migration.includes("driver_wallet_admin_adjustments_driver_read"));
  assert(migration.includes("d.id = driver_wallet_admin_adjustments.driver_id"));
  assert(migration.includes("driver_wallet_ledger_driver_read_admin_adjustments"));

  assert(ssot.includes("ADMIN_WALLET_CREDIT"));
  assert(ssot.includes("ADMIN_WALLET_DEBIT"));
  assert(ssot.includes("admin_manual_adjustment"));
  assert(ssot.includes("DRIVER_WALLET_ADJUSTMENT_OWNER_THRESHOLD_PENCE"));
  assert(ssot.includes("ONECAB adjustment"));

  // Edge remains parked; staff finance profile required; no PS / PL / Revolut.
  assert(edge.includes("requireFinanceExecutionAuth"));
  assert(edge.includes("requireStaffFinanceProfile: true"));
  assert(edge.includes("DRIVER_WALLET_LEDGER"));
  assert(edge.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(edge.includes("driver_wallet_admin_adjustments"));
  assert(edge.includes("logFinanceAuditEvent"));
  assert(!edge.includes("payment_sessions"));
  assert(!edge.includes("admin-payout-ledger"));
  assert(!edge.includes("revolut"));

  assert(gate.includes("DRIVER_WALLET_LEDGER"));
  assert(eligibility.includes("ADMIN_WALLET_PAYOUT_ELIGIBLE_LEDGER_TYPES"));
  assert(eligibility.includes("ADMIN_WALLET_CREDIT"));

  assertEquals("ADMIN_WALLET_CREDIT", "ADMIN_WALLET_CREDIT");
});
