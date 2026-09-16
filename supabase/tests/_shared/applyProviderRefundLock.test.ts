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
});

Deno.test("single helper delegates to atomic RPC only", async () => {
  const src = await Deno.readTextFile(`${ROOT}_shared/applyProviderRefund.ts`);
  assert(src.includes("apply_confirmed_provider_refund_atomic"));
  assert(!src.includes("upsertPaymentSessionRefund"));
  assert(!src.includes('.from("driver_wallet_ledger").insert'));
  assert(!src.includes("loadRideBookingPaymentSessions"));
  assert(src.includes("thisRefundAmountPence"));
  assert(src.includes("provider_refund_id_required"));
});

Deno.test("admin-refund-trip-payment uses atomic helper with provider/local failure split", async () => {
  const src = await Deno.readTextFile(`${ROOT}admin-refund-trip-payment/index.ts`);
  assert(src.includes("applyProviderRefundToOnecab"));
  assert(src.includes("provider: \"revolut\""));
  assert(src.includes("providerRefundId"));
  assert(src.includes("thisRefundAmountPence: refundAmount"));
  assert(src.includes("retry_provider_refund: false"));
  assert(src.includes("failure_stage: \"local_application\""));
});
