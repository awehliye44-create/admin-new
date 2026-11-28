/**
 * BR2 — cancel-without-auth vs authorised-hold release stamp.
 * Durable recovery + create-preauth post-order rollback.
 *
 * Run: deno test --allow-read supabase/tests/_shared/br2ProviderCancelledPreauthStampLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CANCEL_AUTHORISED_HOLD_REASON,
  CANCEL_WITHOUT_AUTH_REASON,
  classifyProviderCancelledPreauthStamp,
  providerOrderWasAuthorised,
} from "../../functions/_shared/stampProviderCancelledPreauthSSOT.ts";

const root = new URL("../../functions/", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, root));
}

Deno.test("BR2: cancel without authorisation keeps hold_release_state null", () => {
  const c = classifyProviderCancelledPreauthStamp({
    priorProviderState: "PENDING",
    providerPayload: { state: "CANCELLED" },
  });
  assertEquals(c.cancellationClass, "without_authorisation");
  assertEquals(c.holdReleaseState, null);
  assertEquals(c.releasedAmountPence, null);
  assertEquals(c.holdTerminalReason, CANCEL_WITHOUT_AUTH_REASON);
  assertEquals(c.status, "cancelled");
  assertEquals(c.skip, false);
});

Deno.test("BR2: authorised then cancelled classifies as hold release", () => {
  const c = classifyProviderCancelledPreauthStamp({
    priorProviderState: "AUTHORISED",
    providerPayload: { state: "CANCELLED", cancelled_amount: 704 },
  });
  assertEquals(c.cancellationClass, "authorised_hold_release");
  assertEquals(c.holdReleaseState, "released");
  assertEquals(c.holdTerminalReason, CANCEL_AUTHORISED_HOLD_REASON);
  assertEquals(c.status, "released");
  assertEquals(c.releasedAmountPence, 704);
});

Deno.test("BR2: already stamped is idempotent skip", () => {
  const c = classifyProviderCancelledPreauthStamp({
    priorMetadata: { cancellation_class: "without_authorisation" },
    priorHoldTerminalReason: CANCEL_WITHOUT_AUTH_REASON,
    providerPayload: { state: "CANCELLED" },
  });
  assertEquals(c.skip, true);
  assertEquals(c.skipReason, "already_stamped");
});

Deno.test("BR2: providerOrderWasAuthorised reads payments[].authorised_amount", () => {
  assertEquals(
    providerOrderWasAuthorised({
      priorProviderState: "PENDING",
      providerPayload: {
        state: "CANCELLED",
        payments: [{ authorised_amount: 500, state: "CANCELLED" }],
      },
    }),
    true,
  );
  assertEquals(
    providerOrderWasAuthorised({
      priorProviderState: null,
      providerPayload: { state: "CANCELLED" },
    }),
    false,
  );
});

Deno.test("BR2: revolutPreauth wires cancel+stamp on post-order failure paths", async () => {
  const src = await read("_shared/revolutPreauth.ts");
  assertStringIncludes(src, "cancelCreatedPreauthOrderAndStamp");
  assertStringIncludes(src, "stampProviderCancelledPreauthSession");
  assertStringIncludes(src, "POST_ORDER_EXCEPTION");
  assertStringIncludes(src, "google_pay_attempt_bind_failed");
  assertStringIncludes(src, "session_persist_failed_after_order");
  // Never silently leave order without stamp helper.
  assertStringIncludes(src, "POST_ORDER_EXCEPTION — cancelling Revolut order");
});

Deno.test("BR2: webhook + sweep stamp incomplete cancels", async () => {
  const webhook = await read("revolut-webhook/index.ts");
  assertStringIncludes(webhook, "stampProviderCancelledPreauthSession");
  assertStringIncludes(webhook, "provider cancel stamp");

  const sweep = await read("sweep-revolut-stale-holds/index.ts");
  assertStringIncludes(sweep, "incomplete_cancel_stamp_recovery_br2");
  assertStringIncludes(sweep, "sweep_incomplete_cancel_stamp");
});
