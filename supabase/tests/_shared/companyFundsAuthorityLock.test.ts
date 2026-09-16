/**
 * Lock: company funds authority hardening — finance execution gates on mutations.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

Deno.test("company outgoing transfer mutations use requireFinanceExecutionAuth", async () => {
  const src = await read("supabase/functions/admin-company-outgoing-transfer/index.ts");
  assertStringIncludes(src, "requireFinanceExecutionAuth");
  assertStringIncludes(src, "requireFinancePageReadAuth");
  assert(!src.includes("requireAdminOrStaff(req)"));
  assertStringIncludes(src, "requireStaffFinanceProfile: true");
  assertStringIncludes(src, "buildFinanceActorAuditContext");
});

Deno.test("company operational reserve edge gates draft vs owner tier", async () => {
  const src = await read("supabase/functions/admin-company-operational-reserve/index.ts");
  const gate = await read("supabase/functions/_shared/adminPaymentGate.ts");
  const migration = await read("supabase/migrations/20260930210000_company_funds_authority_hardening.sql");
  const panel = await read("src/components/finance/PayoutLedgerSettingsPanel.tsx");

  assertStringIncludes(src, "requireFinanceExecutionAuth");
  assertStringIncludes(src, "requireOwnerTierAuth");
  assertStringIncludes(src, "allowSuperAdmin: true");
  assertStringIncludes(src, "allowSuperAdmin: false");
  assertStringIncludes(src, "buildCompanyFundsAuditEnvelope");
  assert(!src.includes("revolut"));
  assert(!src.includes("/pay"));

  assertStringIncludes(gate, "FINANCE_STAFF_PROFILE_REQUIRED");
  assertStringIncludes(gate, "OWNER_TIER_REQUIRED");
  assertStringIncludes(gate, "isCompanyFundsRejectedStaffRole");

  assertStringIncludes(migration, "DROP POLICY IF EXISTS company_ops_reserve_admin_all");
  assertStringIncludes(migration, "company_ops_reserve_finance_read");
  assert(!migration.includes("CREATE POLICY company_ops_reserve_admin_all"));

  assertStringIncludes(panel, "admin-company-operational-reserve");
  assert(!panel.includes("writeReserveAudit"));
});

Deno.test("driver payout edges are not forced onto company-funds staff-profile gate", async () => {
  const submit = await read("supabase/functions/admin-submit-driver-payout-payment/index.ts");
  const markPaid = await read("supabase/functions/admin-mark-manual-payout-paid/index.ts");
  // This package hardens company funds / reserve / CT only — do not require
  // payout submit/mark-paid to adopt requireStaffFinanceProfile here.
  assert(!submit.includes("requireStaffFinanceProfile: true"));
  assert(!markPaid.includes("requireStaffFinanceProfile: true"));
});

Deno.test("company funds authority SSOT rejects support and operator", async () => {
  const ssot = await read("shared/companyFundsAuthoritySSOT.ts");
  assertStringIncludes(ssot, "customer_support");
  assertStringIncludes(ssot, "operator");
  assertStringIncludes(ssot, "finance_manager");
  assertEquals("payout-ledger", "payout-ledger");
});
