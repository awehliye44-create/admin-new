/**
 * P0 lock — advanceWindowValidatedAt must be declared OUTSIDE the order-create
 * try/catch so the post-order payment-session link can reference it.
 *
 * Regression (2026-11-12): cfad376a declared the lets inside the try that ends
 * before post-order upsert → ReferenceError on every Instant + Scheduled Book.
 * Static "string present" checks are not enough — assert declaration precedes
 * the try and the post-order upsert still passes both clocks.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = Deno.readTextFileSync(
  new URL("./revolutPreauth.ts", import.meta.url).pathname,
);

function sliceFn(): string {
  const start = SRC.indexOf("export async function createRevolutPreauthResponse");
  assert(start >= 0, "createRevolutPreauthResponse missing");
  return SRC.slice(start);
}

Deno.test("advance-window clocks are declared before the order-create try", () => {
  const fn = sliceFn();
  const declAt = fn.indexOf("let advanceWindowValidatedAt: string | null = null;");
  const declSched = fn.indexOf(
    "let advanceWindowValidatedScheduledAt: string | null = null;",
  );
  // The order-create try starts with the canonical snapshot defense comment.
  const tryAt = fn.indexOf(
    "// Defense in depth: never create a NEW Revolut order without a canonical snapshot.",
  );
  assert(declAt >= 0, "advanceWindowValidatedAt declaration missing");
  assert(declSched >= 0, "advanceWindowValidatedScheduledAt declaration missing");
  assert(tryAt >= 0, "order-create try marker missing");
  assert(
    declAt < tryAt && declSched < tryAt,
    "advance-window lets must be hoisted above the order-create try (post-order link is outside that try)",
  );
});

Deno.test("post-order session link still stamps advance-window clocks", () => {
  const fn = sliceFn();
  const orderCreatedLog = fn.indexOf('logStep("Revolut order created"');
  assert(orderCreatedLog >= 0, "Revolut order created log missing");
  const after = fn.slice(orderCreatedLog);
  // First upsertPaymentSessionPending after order create is the order-link persist.
  const upsertAt = after.indexOf("upsertPaymentSessionPending");
  assert(upsertAt >= 0, "post-order upsertPaymentSessionPending missing");
  const upsertBlock = after.slice(upsertAt, upsertAt + 900);
  assertEquals(upsertBlock.includes("advanceWindowValidatedAt,"), true);
  assertEquals(upsertBlock.includes("advanceWindowValidatedScheduledAt,"), true);
  assertEquals(upsertBlock.includes("providerOrderId: order.id"), true);
});

Deno.test("runtime scope: try-block let is invisible after catch (documents the bug class)", () => {
  // Executable proof that the historical bug pattern throws ReferenceError.
  let threw = false;
  let message = "";
  try {
    // deno-lint-ignore no-new-func
    const boom = new Function(`
      let order = { id: "ord" };
      try {
        let advanceWindowValidatedAt = null;
        order = { id: "ord-created" };
      } catch (_e) {}
      // Mirrors post-order session link outside the try:
      void advanceWindowValidatedAt;
      return order;
    `);
    boom();
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  assertEquals(threw, true);
  assert(
    message.includes("advanceWindowValidatedAt is not defined") ||
      message.includes("advanceWindowValidatedAt"),
    `expected ReferenceError for advanceWindowValidatedAt, got: ${message}`,
  );
});

Deno.test("runtime scope: hoisted let is visible after catch (required fix)", () => {
  // deno-lint-ignore no-new-func
  const ok = new Function(`
    let order = { id: "ord" };
    let advanceWindowValidatedAt = null;
    let advanceWindowValidatedScheduledAt = null;
    try {
      advanceWindowValidatedAt = "2026-11-12T21:34:15.217Z";
      advanceWindowValidatedScheduledAt = "2026-11-12T22:00:00.000Z";
      order = { id: "ord-created" };
    } catch (_e) {}
    return {
      orderId: order.id,
      advanceWindowValidatedAt,
      advanceWindowValidatedScheduledAt,
    };
  `)() as {
    orderId: string;
    advanceWindowValidatedAt: string;
    advanceWindowValidatedScheduledAt: string;
  };
  assertEquals(ok.orderId, "ord-created");
  assertEquals(ok.advanceWindowValidatedAt, "2026-11-12T21:34:15.217Z");
  assertEquals(ok.advanceWindowValidatedScheduledAt, "2026-11-12T22:00:00.000Z");
});
