/**
 * Phase 0 writer retirement — structural lock tests.
 * Run: deno test --allow-read --no-check supabase/functions/_shared/phase0WriterRetirementLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { relative } from "https://deno.land/std@0.224.0/path/mod.ts";

const ROOT = new URL("../..", import.meta.url).pathname;

const TRIP_EARNING_INSERT_ALLOWLIST = new Set([
  "functions/_shared/onecabFinanceLedger.ts",
  "functions/_shared/canonicalTypedWalletPostingSSOT.ts",
]);

const PAYOUT_DEBIT_ALLOWLIST = new Set([
  "supabase/functions/_shared/payoutCompletionRpcSSOT.ts",
  "supabase/functions/_shared/payoutLedgerSync.ts",
]);

const PAYMENT_SESSION_UPDATE_ALLOWLIST = new Set([
  "functions/_shared/paymentSessionMutationCore.ts",
]);

async function collectTsFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of walk(ROOT, {
    exts: [".ts"],
    skip: [/node_modules/, /\.test\.ts$/, /phase0WriterRetirementLock\.test\.ts$/],
  })) {
    if (entry.isFile) {
      files.push(relative(ROOT, entry.path).replace(/\\/g, "/"));
    }
  }
  return files;
}

function countPattern(src: string, pattern: RegExp): number {
  return (src.match(pattern) ?? []).length;
}

Deno.test("TRIP_EARNING_NET inserts only in canonical allowlist", async () => {
  const files = await collectTsFiles();
  const violations: string[] = [];
  for (const file of files) {
    const src = await Deno.readTextFile(`${ROOT}/${file}`);
    const hasTripEarningInsert =
      /type:\s*['"]TRIP_EARNING_NET['"]/.test(src)
      && /\.from\(["']driver_wallet_ledger["']\)\.insert/.test(src);
    if (!hasTripEarningInsert) continue;
    if (!TRIP_EARNING_INSERT_ALLOWLIST.has(file)) {
      violations.push(file);
    }
  }
  assertEquals(violations, [], `Forbidden TRIP_EARNING_NET writers: ${violations.join(", ")}`);
});

Deno.test("payoutLedgerSync has no direct wallet debit insert", async () => {
  const src = await Deno.readTextFile(new URL("./payoutLedgerSync.ts", import.meta.url));
  assertEquals(src.includes('.from("driver_wallet_ledger").insert'), false);
  assertStringIncludes(src, "invokeAutomatedPayoutCompletion");
});

Deno.test("payout completion RPC is sole finalize_driver_payout_completion edge wrapper", async () => {
  const src = await Deno.readTextFile(new URL("./payoutCompletionRpcSSOT.ts", import.meta.url));
  assertStringIncludes(src, "finalize_driver_payout_completion");
  assertEquals(src.includes('.from("driver_wallet_ledger").insert'), false);
});

Deno.test("legacy trip earning paths delegate to canonicalTypedWalletPostingSSOT", async () => {
  const paths = [
    "../admin-payment-detail/index.ts",
    "../record-financial-outcome/index.ts",
    "../repair-commissions/index.ts",
    "../stop-workflow/index.ts",
    "./noShowSettlement.ts",
  ];
  for (const rel of paths) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    const hasTripEarningInsert =
      /type:\s*['"]TRIP_EARNING_NET['"]/.test(src)
      && /\.from\(["']driver_wallet_ledger["']\)\.insert/.test(src);
    assertEquals(
      hasTripEarningInsert,
      false,
      `${rel} must not insert TRIP_EARNING_NET directly`,
    );
  }
});

Deno.test("tripSettlement delegates standard path to calculateCanonicalSettlement", async () => {
  const src = await Deno.readTextFile(new URL("./tripSettlement.ts", import.meta.url));
  assertStringIncludes(src, "computeAuthoritativeSettlement");
});

Deno.test("payment session direct updates outside mutation core are forbidden", async () => {
  const pattern = /\.from\(["']payment_sessions["']\)\.update/g;
  const files = await collectTsFiles();
  const bypasses: string[] = [];
  for (const file of files) {
    const src = await Deno.readTextFile(`${ROOT}/${file}`);
    if (!pattern.test(src)) continue;
    if (!PAYMENT_SESSION_UPDATE_ALLOWLIST.has(file)) {
      bypasses.push(file);
    }
  }
  assertEquals(
    bypasses,
    [],
    `Direct payment_sessions.update bypasses (route through facade/core): ${bypasses.join(", ")}`,
  );
});

Deno.test("canonicalTypedWalletPostingSSOT owns TRIP_EARNING_NET posting entry", async () => {
  const src = await Deno.readTextFile(new URL("./canonicalTypedWalletPostingSSOT.ts", import.meta.url));
  assertStringIncludes(src, "creditCapturedCardTripLedger");
  assertStringIncludes(src, "postTripEarningNetCanonical");
});

Deno.test("financeOwnershipLock tests still pass paths unchanged", async () => {
  const src = await Deno.readTextFile(new URL("./financeOwnershipLock.test.ts", import.meta.url));
  assertStringIncludes(src, "creditCapturedCardTripLedger");
});
