/**
 * CTAP fresh AUTHORISED session fast path: skip the Revolut GET only when a same-request
 * provider read stamped the session within 60s and every invariant matches.
 * Run: deno test --allow-read supabase/tests/_shared/bookingPaymentVerifyFastFreshSession.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FRESH_PROVIDER_READ_MAX_AGE_MS,
  freshProviderReadSessionOrder,
} from "../../functions/_shared/bookingPaymentVerifyFast.ts";

const NOW = Date.parse("2026-10-02T18:00:00.000Z");

const session = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  status: "authorised_hold",
  provider_state: "AUTHORISED",
  provider_state_verified_by: "create_preauth_provider_read",
  provider_state_verified_at: new Date(NOW - 2_000).toISOString(),
  provider_order_id: "ord-1",
  client_action_id: "cai-1",
  user_id: "user-1",
  payment_provider: "revolut",
  purpose: "RIDE_BOOKING",
  platform_payment_method_id: "pm-saved-1",
  authorised_amount_pence: 750,
  estimated_total_pence: 500,
  ...over,
});

const args = { orderId: "ord-1", clientActionId: "cai-1", userId: "user-1", nowMs: NOW };

Deno.test("fresh provider-read session yields AUTHORISED order with session amount (750 = 500 + 250)", () => {
  for (const verifiedBy of ["create_preauth_provider_read", "confirm_provider_read"]) {
    const r = freshProviderReadSessionOrder(session({ provider_state_verified_by: verifiedBy }), args);
    assert(r.ok, verifiedBy);
    if (r.ok) {
      assertEquals(r.order.state, "AUTHORISED");
      assertEquals(r.order.amount, 750);
      assertEquals(r.order.metadata?.client_action_id, "cai-1");
      assertEquals(r.order.metadata?.customer_user_id, "user-1");
      assertEquals(r.order.metadata?.save_card_eligible, "false");
    }
  }
});

Deno.test("any failing invariant forces the Revolut GET", () => {
  const cases: Array<[string, Record<string, unknown>, Partial<typeof args>]> = [
    ["verifier_not_provider_read", { provider_state_verified_by: "markPaymentSessionAuthorised" }, {}],
    ["verifier_not_provider_read", { provider_state_verified_by: "webhook" }, {}],
    ["provider_state_not_authorised", { provider_state: "PENDING" }, {}],
    ["session_not_authorised_hold", { status: "pending_payment" }, {}],
    ["provider_read_stale", { provider_state_verified_at: new Date(NOW - FRESH_PROVIDER_READ_MAX_AGE_MS - 1).toISOString() }, {}],
    ["provider_read_stale", { provider_state_verified_at: null }, {}],
    ["provider_read_stale", { provider_state_verified_at: new Date(NOW + 5_000).toISOString() }, {}],
    ["provider_order_mismatch", {}, { orderId: "ord-2" }],
    ["client_action_mismatch", {}, { clientActionId: "cai-2" }],
    ["client_action_mismatch", {}, { clientActionId: null as unknown as string }],
    ["customer_mismatch", {}, { userId: "user-2" }],
    ["customer_mismatch", {}, { userId: null as unknown as string }],
    ["provider_mismatch", { payment_provider: "other" }, {}],
    ["not_ride_booking", { purpose: "SAVE_CARD" }, {}],
    ["authorised_below_payable", { authorised_amount_pence: 400 }, {}],
    ["authorised_below_payable", { estimated_total_pence: 0 }, {}],
  ];
  for (const [reason, sOver, aOver] of cases) {
    const r = freshProviderReadSessionOrder(session(sOver), { ...args, ...aOver });
    assert(!r.ok, `${reason} should fail`);
    if (!r.ok) assertEquals(r.reason, reason);
  }
  assertEquals(freshProviderReadSessionOrder(null, args), { ok: false, reason: "no_session" });
});

Deno.test("session without platform PM (non-save card / wallet) carries no PM metadata", () => {
  const r = freshProviderReadSessionOrder(session({ platform_payment_method_id: null }), args);
  assert(r.ok);
  if (r.ok) assertEquals(r.order.metadata?.platform_payment_method_id, undefined);
});

Deno.test("source lock: provider-read labels are never written for card-save bookings", async () => {
  const confirm = await Deno.readTextFile(new URL("../../functions/confirm-revolut-payment/index.ts", import.meta.url));
  assert(confirm.includes('coversHold && !saveCardEligible ? { verifiedBy: "confirm_provider_read"'));
  const preauth = await Deno.readTextFile(new URL("../../functions/_shared/revolutPreauth.ts", import.meta.url));
  assert(preauth.includes("reuseCoversHold && !reuseSaveEligible"));
  // Saved-card charge path is only reached with a caller-supplied saved PM (never card-save).
  assert(preauth.includes("!resolvedPlatformPaymentMethodId\n    && savePaymentMethod === true"));
});
