/**
 * Lock: Driver Wallet manual adjustment enablement package (flag enabled).
 * Auth hardening, ONECAB driver copy, RLS/HTTP matrix, idempotency invariants.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  canAuthenticatedClientInsertDriverWalletLedger,
  canDriverSelectOwnAdminAdjustmentLedgerRow,
  DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED,
  DRIVER_WALLET_ADMIN_CREDIT_TYPE,
  DRIVER_WALLET_ADMIN_DEBIT_TYPE,
  DRIVER_WALLET_ADJUSTMENT_DRIVER_VISIBLE_TITLE,
  driverWalletAdjustmentAdminDirectionLabel,
  driverWalletAdjustmentDriverTitle,
  evaluateDriverWalletAdjustmentCallerAccess,
  ledgerTypeForDriverWalletAdjustmentDirection,
  simulateConcurrentManualAdjustmentLedgerPosts,
} from "../../../shared/driverWalletManualAdjustmentSSOT.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

Deno.test("enablement: flag is true; park error path retained", async () => {
  assertEquals(DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED, true);
  const edge = await read("supabase/functions/admin-driver-adjustment/index.ts");
  const ssot = await read("shared/driverWalletManualAdjustmentSSOT.ts");
  assertStringIncludes(ssot, "DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED = true");
  assertStringIncludes(edge, "ADJUSTMENTS_NOT_DEPLOYED");
  assertStringIncludes(edge, "driverWalletAdminAdjustmentsDeployed");
});

Deno.test("enablement: edge requires staff finance profile", async () => {
  const edge = await read("supabase/functions/admin-driver-adjustment/index.ts");
  assertStringIncludes(edge, "requireFinanceExecutionAuth");
  assertStringIncludes(edge, "requireStaffFinanceProfile: true");
  // Gate itself rejects missing staff finance profile + support/operator.
  const gate = await read("supabase/functions/_shared/adminPaymentGate.ts");
  assertStringIncludes(gate, "FINANCE_STAFF_PROFILE_REQUIRED");
  assertStringIncludes(gate, "isCompanyFundsRejectedStaffRole");
});

Deno.test("enablement HTTP auth matrix (SSOT)", () => {
  assertEquals(
    evaluateDriverWalletAdjustmentCallerAccess({
      authenticated: false,
      hasStaffFinanceProfile: false,
      staffRole: null,
    }).ok,
    false,
  );
  assertEquals(
    evaluateDriverWalletAdjustmentCallerAccess({
      authenticated: true,
      hasStaffFinanceProfile: true,
      staffRole: "customer_support",
    }),
    { ok: false, code: "FINANCE_EXECUTION_FORBIDDEN" },
  );
  assertEquals(
    evaluateDriverWalletAdjustmentCallerAccess({
      authenticated: true,
      hasStaffFinanceProfile: true,
      staffRole: "operator",
    }),
    { ok: false, code: "FINANCE_EXECUTION_FORBIDDEN" },
  );
  // Legacy user_roles.admin without staff finance profile.
  assertEquals(
    evaluateDriverWalletAdjustmentCallerAccess({
      authenticated: true,
      hasStaffFinanceProfile: false,
      staffRole: "super_admin",
    }),
    { ok: false, code: "FINANCE_STAFF_PROFILE_REQUIRED" },
  );
  for (const role of ["finance_manager", "admin", "super_admin"]) {
    assertEquals(
      evaluateDriverWalletAdjustmentCallerAccess({
        authenticated: true,
        hasStaffFinanceProfile: true,
        staffRole: role,
      }),
      { ok: true, role },
    );
  }
});

Deno.test("enablement RLS matrix: own rows only; no client insert", async () => {
  const migration = await read(
    "supabase/migrations/20260930200000_driver_wallet_admin_manual_adjustments.sql",
  );
  assertStringIncludes(migration, "driver_wallet_ledger_driver_read_admin_adjustments");
  assertStringIncludes(migration, "d.id = driver_wallet_ledger.driver_id");
  assertStringIncludes(migration, 'DROP POLICY IF EXISTS "Admins can manage driver wallet ledger"');
  assert(!/CREATE POLICY[\s\S]{0,200}ON public\.driver_wallet_ledger[\s\S]{0,80}FOR (INSERT|UPDATE|DELETE)/i
    .test(migration.replace(/CREATE POLICY "Service role can manage wallet ledger"[\s\S]*?;/g, "")));

  assertEquals(
    canDriverSelectOwnAdminAdjustmentLedgerRow({
      viewerDriverId: "d1",
      rowDriverId: "d1",
      ledgerType: DRIVER_WALLET_ADMIN_CREDIT_TYPE,
    }),
    true,
  );
  assertEquals(
    canDriverSelectOwnAdminAdjustmentLedgerRow({
      viewerDriverId: "d1",
      rowDriverId: "d2",
      ledgerType: DRIVER_WALLET_ADMIN_CREDIT_TYPE,
    }),
    false,
  );
  assertEquals(canAuthenticatedClientInsertDriverWalletLedger(), false);
});

Deno.test("enablement: ONECAB driver title; admin direction kept internal", async () => {
  assertEquals(driverWalletAdjustmentDriverTitle("CREDIT"), "ONECAB adjustment");
  assertEquals(driverWalletAdjustmentDriverTitle("DEBIT"), "ONECAB adjustment");
  assertEquals(DRIVER_WALLET_ADJUSTMENT_DRIVER_VISIBLE_TITLE, "ONECAB adjustment");
  assertEquals(driverWalletAdjustmentAdminDirectionLabel("CREDIT"), "Credit");
  assertEquals(driverWalletAdjustmentAdminDirectionLabel("DEBIT"), "Debit");

  const titles = await read("shared/walletTransactionTitles.ts");
  assertStringIncludes(titles, 'ADMIN_WALLET_CREDIT: "ONECAB adjustment"');
  assertStringIncludes(titles, 'ADMIN_WALLET_DEBIT: "ONECAB adjustment"');
  assert(!titles.includes('ADMIN_WALLET_CREDIT: "Admin credit"'));

  const driverTx = await read("supabase/functions/driver-wallet-transactions/index.ts");
  assertStringIncludes(driverTx, "ONECAB adjustment");
  assert(!driverTx.includes("title: 'Admin credit'"));
});

Deno.test("enablement: idempotency + concurrency + ledger types", () => {
  assertEquals(
    ledgerTypeForDriverWalletAdjustmentDirection("CREDIT"),
    DRIVER_WALLET_ADMIN_CREDIT_TYPE,
  );
  assertEquals(
    ledgerTypeForDriverWalletAdjustmentDirection("DEBIT"),
    DRIVER_WALLET_ADMIN_DEBIT_TYPE,
  );

  const credit = simulateConcurrentManualAdjustmentLedgerPosts({
    idempotencyKey: "adj-credit-1",
    ledgerType: DRIVER_WALLET_ADMIN_CREDIT_TYPE,
    attempts: 5,
  });
  assertEquals(credit.posted, 1);
  assertEquals(credit.rejectedDuplicates, 4);
  assertEquals(credit.ledgerTypes, [DRIVER_WALLET_ADMIN_CREDIT_TYPE]);

  const debit = simulateConcurrentManualAdjustmentLedgerPosts({
    idempotencyKey: "adj-debit-1",
    ledgerType: DRIVER_WALLET_ADMIN_DEBIT_TYPE,
    attempts: 3,
  });
  assertEquals(debit.posted, 1);
  assertEquals(debit.ledgerTypes, [DRIVER_WALLET_ADMIN_DEBIT_TYPE]);

  let threw = false;
  try {
    simulateConcurrentManualAdjustmentLedgerPosts({
      idempotencyKey: "bad-ten",
      ledgerType: "TRIP_EARNING_NET",
      attempts: 2,
    });
  } catch {
    threw = true;
  }
  assert(threw);
});
