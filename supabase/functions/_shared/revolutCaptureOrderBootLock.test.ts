/**
 * Step 8.2A — revolut-capture-order retirement boot lock.
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/revolutCaptureOrderBootLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL(".", import.meta.url).pathname.replace(/_shared\/$/, "");

Deno.test("revolut-capture-order is 410-only with no financial import graph", async () => {
  const src = await Deno.readTextFile(`${ROOT}revolut-capture-order/index.ts`);
  assertEquals(src.includes("LEGACY_CAPTURE_ENDPOINT_DISABLED"), true);
  assertEquals(src.includes("captureRevolutOrder"), false);
  assertEquals(src.includes("retrieveRevolutOrder"), false);
  assertEquals(src.includes("markPaymentSessionCaptured"), false);
  assertEquals(src.includes("applyCanonicalSettlementAfterCapture"), false);
  assertEquals(src.includes('from("trips")'), false);
  assertEquals(src.includes('from("payment_sessions")'), false);
  assertEquals(src.includes('from("driver_wallet_ledger")'), false);
  assertEquals(src.includes("requireAdmin"), true);
});

Deno.test("no production caller imports revolut-capture-order for capture", async () => {
  const adminCapture = await Deno.readTextFile(`${ROOT}admin-capture-trip-payment/index.ts`);
  assertEquals(adminCapture.includes("revolut-capture-order"), false);
  assertEquals(adminCapture.includes("executeAdminCaptureTripPayment"), true);
});
