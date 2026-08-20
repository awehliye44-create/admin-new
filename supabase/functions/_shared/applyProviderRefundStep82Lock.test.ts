/**
 * Step 8.2A.3 — refund PS sync via atomic RPC (replaces direct PS/ledger writes).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("H: refund applies via apply_confirmed_provider_refund_atomic RPC", async () => {
  const src = await Deno.readTextFile(new URL("./applyProviderRefund.ts", import.meta.url));
  assertEquals(src.includes("apply_confirmed_provider_refund_atomic"), true);
  assertEquals(src.includes("upsertPaymentSessionRefund"), false);
  assertEquals(src.includes('.from("driver_wallet_ledger").insert'), false);
  assertEquals(src.includes("thisRefundAmountPence"), true);
});

Deno.test("H: admin-refund passes provider refund id and incremental delta", async () => {
  const src = await Deno.readTextFile(
    new URL("../admin-refund-trip-payment/index.ts", import.meta.url),
  );
  assertEquals(src.includes("thisRefundAmountPence: refundAmount"), true);
  assertEquals(src.includes("providerRefundId"), true);
  assertEquals(src.includes("retry_provider_refund: false"), true);
});

Deno.test("H: sibling PAYMENT_RECOVERY excluded inside RPC RIDE_BOOKING gate", async () => {
  const migration = await Deno.readTextFile(
    new URL("../../migrations/20260930150000_provider_refund_ledger_idempotency.sql", import.meta.url),
  );
  assertEquals(migration.includes("purpose = 'RIDE_BOOKING'"), true);
  assertEquals(migration.includes("CAPTURE_AMBIGUOUS"), true);
});
