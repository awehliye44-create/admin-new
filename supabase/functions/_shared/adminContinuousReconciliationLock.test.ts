/**
 * admin-continuous-reconciliation is a read/snapshot Edge.
 * It must not grow money-write, repair, capture, payout, or Commission Wallet ownership.
 *
 * Run: deno test --allow-read --no-check supabase/functions/_shared/adminContinuousReconciliationLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertFalse } from "https://deno.land/std@0.224.0/assert/assert_false.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";

const V153_INDEX_SHA256 =
  "fb49ea568551ffdb208c29d4ec30845819a23eba2b06fccaf68984976eec0f6a";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("continuous-reconciliation boot/import: snapshot-only, no money writes", async () => {
  const src = await Deno.readTextFile(
    new URL("../admin-continuous-reconciliation/index.ts", import.meta.url),
  );
  assertStringIncludes(src, 'from "../_shared/fetchDriverWalletPayoutSnapshot.ts"');
  assertFalse(src.includes(".insert("));
  assertFalse(src.includes(".update("));
  assertFalse(src.includes(".upsert("));
  assertFalse(src.includes(".delete("));
  assertFalse(src.includes("creditCapturedCardTripLedger"));
  assertFalse(src.includes("recoverCapturedTripWallet"));
  assertFalse(src.includes("capturedTripWalletRecovery"));
  assertFalse(src.includes("applyCanonicalSettlementAfterCapture"));
  assertFalse(src.includes("api.revolut"));
  assertFalse(src.includes("financial_ssot_mismatches"));
  assertFalse(src.includes("financial_ssot_repairs"));
  assertFalse(src.includes("driver_wallet_ledger"));
  assertFalse(src.includes("payment_sessions"));
  assertFalse(src.includes("payout_items"));
  assertFalse(src.includes("driver_commission_wallet"));
  assertEquals(src.includes("repair_mode: body.repair_mode === true"), true);
  assertFalse(/if\s*\(\s*body\.repair_mode/.test(src));
  assertEquals(src.includes("provider: null"), true);

  const bytes = new TextEncoder().encode(src);
  assertEquals(await sha256Hex(bytes), V153_INDEX_SHA256);
});

Deno.test("continuous-reconciliation v153 rollback handler is identical snapshot-only source", async () => {
  const v153 = await Deno.readTextFile(
    new URL(
      "../../../.rollback-step4c1-2026-08-18/admin-continuous-reconciliation-v153/supabase/functions/admin-continuous-reconciliation/index.ts",
      import.meta.url,
    ),
  );
  assertFalse(v153.includes(".insert("));
  assertFalse(v153.includes(".update("));
  assertFalse(v153.includes(".upsert("));
  assertFalse(v153.includes(".delete("));
  assertEquals(v153.includes("repair_mode: body.repair_mode === true"), true);
  assertEquals(await sha256Hex(new TextEncoder().encode(v153)), V153_INDEX_SHA256);
});
