/**
 * Admin refund helper lock — one applyProviderRefundToOnecab only.
 * Run: deno test --allow-read supabase/functions/_shared/applyProviderRefundLock.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL(".", import.meta.url).pathname.replace(/_shared\/$/, "");

Deno.test("applyProviderRefundToOnecab is declared exactly once", async () => {
  const src = await Deno.readTextFile(`${ROOT}_shared/applyProviderRefund.ts`);
  const declarations = src.match(/export async function applyProviderRefundToOnecab/g) ?? [];
  assertEquals(declarations.length, 1);
  assert(!/const result = await applyProviderRefundToOnecab\(/.test(src));
});

Deno.test("single helper still updates payment_sessions and keeps ledger idempotent", async () => {
  const src = await Deno.readTextFile(`${ROOT}_shared/applyProviderRefund.ts`);
  assert(src.includes('from("payment_sessions")'));
  assert(src.includes("refunded_amount_pence"));
  assert(src.includes("REFUND_DEBIT"));
  assert(src.includes("existingDebit"));
  assert(src.includes("providerOrderId"));
});

Deno.test("admin-refund-trip-payment still uses the same helper contract", async () => {
  const src = await Deno.readTextFile(`${ROOT}admin-refund-trip-payment/index.ts`);
  assert(src.includes("applyProviderRefundToOnecab"));
  assert(src.includes("provider: \"revolut\""));
  assert(src.includes("providerOrderId: orderId"));
  assert(src.includes("source: \"admin_refund\""));
  assert(src.includes("amountRefundedPence: alreadyRefunded + refundAmount"));
});
