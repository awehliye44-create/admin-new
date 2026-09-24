/**
 * Lock: payment-UI failure (OR_BIBED_13 / sheet cancel) must not leave
 * receivables RESERVED on a zero-payment pending ghost order.
 *
 * Contract:
 * 1. OR_BIBED_13 + zero provider payments → same-order cancel + OPEN 36p
 * 2. Crash after reserve / before payment UI → restart cleanup releases safely
 * 3. Provider AUTHORISED → reservation retained (until safe void)
 * 4. Provider UNKNOWN → reservation retained
 * 5. Cleanup twice → one cancel/release (idempotent planner + RPC)
 * 6. New Book blocked while another active reservation exists (planner signal)
 * 7. No TEN/wallet/commission/payout effects from release planner
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { planReleaseOnCancel } from "../supabase/functions/_shared/customerReceivableSSOT.ts";

const ORDER = "6ab4f8a6-6605-ae84-83f6-85b440542654";

Deno.test("1. OR_BIBED_13: pending + hold_safely_released → RELEASE (OPEN 36p path)", () => {
  // Session provider_state often still null/PENDING when abandon reconciles
  // after GET→cancel (stale closure) — must still RELEASE.
  for (const state of ["PENDING", "", "PROCESSING", null]) {
    const d = planReleaseOnCancel({
      provider_order_id: ORDER,
      provider_state: state,
      has_capture: false,
      hold_safely_released: true,
    });
    assertEquals(d.action, "RELEASE", `state=${String(state)}`);
    assertEquals(d.reason, "pending_hold_safely_cancelled_zero_capture");
  }
  // Explicit CANCELLED after cancel also RELEASE.
  const cancelled = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: "CANCELLED",
    has_capture: false,
    hold_safely_released: true,
  });
  assertEquals(cancelled.action, "RELEASE");
});

Deno.test("2. Crash / sheet fail before cancel proven: pending without hold_safely_released → KEEP", () => {
  const d = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: "PENDING",
    has_capture: false,
    hold_safely_released: false,
  });
  assertEquals(d.action, "KEEP_RESERVED");
  assertEquals(d.reason, "non_terminal_keep_reserved");
});

Deno.test("3. Provider AUTHORISED → retain RESERVED until hold safely released", () => {
  const keep = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: "AUTHORISED",
    has_capture: false,
    hold_safely_released: false,
  });
  assertEquals(keep.action, "KEEP_RESERVED");
  assertEquals(keep.reason, "authorised_awaiting_safe_hold_release");

  const afterVoid = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: "AUTHORISED",
    has_capture: false,
    hold_safely_released: true,
  });
  assertEquals(afterVoid.action, "RELEASE");
});

Deno.test("4. Provider UNKNOWN → retain RESERVED (even if local cancel claimed ok)", () => {
  const d = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: "UNKNOWN",
    has_capture: false,
    hold_safely_released: true,
  });
  assertEquals(d.action, "KEEP_RESERVED");
  assertEquals(d.reason, "provider_unknown_reconcile_only");
});

Deno.test("5. Cleanup called twice: CANCELLED + hold_safely_released stays RELEASE (idempotent)", () => {
  const first = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: "CANCELLED",
    has_capture: false,
    hold_safely_released: true,
  });
  const second = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: "CANCELLED",
    has_capture: false,
    hold_safely_released: true,
  });
  assertEquals(first.action, "RELEASE");
  assertEquals(second.action, "RELEASE");
  assertEquals(first.reason, second.reason);
});

Deno.test("6. Active reservation blocks new Book (signal): pending without safe cancel keeps RESERVED", () => {
  // UI/backend must refuse a second fold while this KEEP applies.
  const active = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: null,
    has_capture: false,
    hold_safely_released: false,
  });
  assertEquals(active.action, "KEEP_RESERVED");
});

Deno.test("7. Release planner never invents capture/settle/TEN — zero capture → RELEASE or KEEP only", () => {
  const released = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: "PENDING",
    has_capture: false,
    hold_safely_released: true,
  });
  assertEquals(released.action === "SETTLE", false);
  const kept = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: "UNKNOWN",
    has_capture: false,
    hold_safely_released: false,
  });
  assertEquals(kept.action === "SETTLE", false);
  // Capture path is SETTLE only with evidence — not a wallet/TEN write.
  const settle = planReleaseOnCancel({
    provider_order_id: ORDER,
    provider_state: "COMPLETED",
    has_capture: true,
    hold_safely_released: false,
  });
  assertEquals(settle.action, "SETTLE");
});
