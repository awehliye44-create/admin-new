/**
 * Completion capture must statically import revolutProviderAuthorisedTotalPence.
 * A dynamic import of revolutOrders.ts left that export undefined on Edge
 * → "revolutProviderAuthorisedTotalPence is not a function" → capture_failed
 * while Revolut stayed AUTHORISED (MK-260815-010).
 *
 * Run: deno test --allow-read supabase/functions/_shared/revolutCompletionCaptureBootLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("completion capture statically imports authorised-total helper", async () => {
  const src = await Deno.readTextFile(
    new URL("./revolutCompletionCapture.ts", import.meta.url),
  );
  const orders = await Deno.readTextFile(
    new URL("./revolutOrders.ts", import.meta.url),
  );
  assertEquals(src.includes("revolutProviderAuthorisedTotalPence"), true);
  assertEquals(src.includes('from "./revolutOrders.ts"'), true);
  assertEquals(src.includes('from "./executeSameOrderIncrementSSOT.ts"'), true);
  assertEquals(src.includes('from "./paymentRecoveryGuardSSOT.ts"'), true);
  assertEquals(src.includes('from "./paymentSessionFinancialLockSSOT.ts"'), true);
  assertEquals(src.includes('from "./revolutCaptureIdempotencySSOT.ts"'), true);
  assertEquals(/await\s+import\s*\(/.test(src), false);
  assertEquals(
    orders.includes("export function revolutProviderAuthorisedTotalPence"),
    true,
  );
});

Deno.test("captured sessions stamp provider_state COMPLETED", async () => {
  const session = await Deno.readTextFile(
    new URL("./paymentSessionSSOT.ts", import.meta.url),
  );
  const fn = session.slice(session.indexOf("export async function markPaymentSessionCaptured"));
  const body = fn.slice(0, fn.indexOf("\nexport async function markPaymentSessionPaymentShortfall"));
  assertEquals(body.includes('provider_state: "COMPLETED"'), true);
  assertEquals(body.includes('provider_state_verified_by: "markPaymentSessionCaptured"'), true);
});
