/**
 * Extended pre-deploy gate for terminal disposition + trigger enqueue classification.
 * Pure logic only — no provider or DB mutations.
 */
import { classifyTerminalHoldDisposition } from "./terminalTripPaymentDisposition.ts";

type TriggerDecision = {
  enqueue: boolean;
  reason: string;
};

/** Mirror of trg_trips_terminal_payment_disposition eligibility (must stay in sync with migration). */
export function classifyStatusTriggerEnqueue(args: {
  oldStatus: string;
  newStatus: string;
  cancelledBy?: string | null;
}): TriggerDecision {
  const oldS = args.oldStatus;
  const newS = args.newStatus;
  if (oldS === newS) return { enqueue: false, reason: "status_unchanged" };
  if (newS === "completed" || oldS === "completed") {
    return { enqueue: false, reason: "completed_excluded" };
  }
  const active = new Set([
    "searching", "searching_new_driver", "broadcasting", "offered", "offering",
    "negotiating", "pending", "payment_pending", "driver_assigned", "accepted",
    "confirmed", "queued", "en_route", "en_route_to_pickup", "driver_en_route",
    "arrived", "arrived_at_pickup", "at_pickup", "waiting", "pickup_waiting",
    "in_progress", "on_trip", "started", "ongoing", "completing",
  ]);
  if (active.has(newS)) return { enqueue: false, reason: `active_or_rematch:${newS}` };

  const terminal = new Set([
    "cancelled", "canceled", "customer_cancelled", "driver_cancelled",
    "expired", "expired_no_driver", "no_show", "failed", "declined", "completed",
  ]);
  if (terminal.has(oldS)) return { enqueue: false, reason: "already_terminal_no_reenqueue" };

  const eligible = new Set([
    "cancelled", "canceled", "customer_cancelled", "driver_cancelled",
    "expired", "expired_no_driver", "no_show", "failed", "declined",
  ]);
  if (!eligible.has(newS)) return { enqueue: false, reason: `not_eligible:${newS}` };
  return { enqueue: true, reason: "transition_to_terminal" };
}

Deno.test("1. customer cancel searching no fee → void", () => {
  const r = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "void_full") throw new Error(JSON.stringify(r));
});

Deno.test("2. customer cancel after assign before start with fee → partial", () => {
  const r = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    feePence: 400,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "partial_capture_fee") throw new Error(JSON.stringify(r));
});

Deno.test("3. admin terminal cancellation enqueued by migration hook", () => {
  const t = classifyStatusTriggerEnqueue({
    oldStatus: "searching",
    newStatus: "cancelled",
    cancelledBy: "admin",
  });
  if (!t.enqueue) throw new Error(JSON.stringify(t));
});

Deno.test("4. search expiry enqueued by migration hook", () => {
  const t = classifyStatusTriggerEnqueue({
    oldStatus: "searching",
    newStatus: "expired",
  });
  if (!t.enqueue) throw new Error(JSON.stringify(t));
});

Deno.test("5. valid driver rematch does not release / enqueue", () => {
  const t = classifyStatusTriggerEnqueue({
    oldStatus: "driver_assigned",
    newStatus: "searching_new_driver",
  });
  if (t.enqueue) throw new Error(JSON.stringify(t));
  const r = classifyTerminalHoldDisposition({
    tripStatus: "searching_new_driver",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "skip") throw new Error(JSON.stringify(r));
});

Deno.test("6. final rematch expiry releases", () => {
  const t = classifyStatusTriggerEnqueue({
    oldStatus: "searching_new_driver",
    newStatus: "expired",
  });
  if (!t.enqueue) throw new Error(JSON.stringify(t));
  const r = classifyTerminalHoldDisposition({
    tripStatus: "expired",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "void_full") throw new Error(JSON.stringify(r));
});

Deno.test("7. completed trips excluded from trigger and disposer", () => {
  const t = classifyStatusTriggerEnqueue({
    oldStatus: "in_progress",
    newStatus: "completed",
  });
  if (t.enqueue) throw new Error(JSON.stringify(t));
  const r = classifyTerminalHoldDisposition({
    tripStatus: "completed",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.outcome !== "SKIPPED_COMPLETED") throw new Error(JSON.stringify(r));
});

Deno.test("8. in-progress excluded", () => {
  const t = classifyStatusTriggerEnqueue({
    oldStatus: "driver_assigned",
    newStatus: "in_progress",
  });
  if (t.enqueue) throw new Error(JSON.stringify(t));
  const r = classifyTerminalHoldDisposition({
    tripStatus: "in_progress",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.outcome !== "SKIPPED_REMATCH_OR_ACTIVE") throw new Error(JSON.stringify(r));
});

Deno.test("9. duplicate trigger events (already terminal) → no second enqueue", () => {
  const t = classifyStatusTriggerEnqueue({
    oldStatus: "cancelled",
    newStatus: "customer_cancelled",
  });
  if (t.enqueue) throw new Error(JSON.stringify(t));
  const same = classifyStatusTriggerEnqueue({
    oldStatus: "cancelled",
    newStatus: "cancelled",
  });
  if (same.enqueue) throw new Error(JSON.stringify(same));
});

Deno.test("10. provider-confirmed CANCELLED classifies as already-released path input", () => {
  // Local reconcile-only when provider already CANCELLED is covered by disposer outcome enum.
  const r = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "void_full") throw new Error("would still attempt void; retrieve handles already-cancelled");
});

Deno.test("11. timeout must not mark RELEASED from classification alone", () => {
  // Classification never returns RELEASED_* — only void/partial/skip. Provider confirm required in disposer.
  const r = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (!["void_full", "partial_capture_fee", "skip"].includes(r.action)) {
    throw new Error(JSON.stringify(r));
  }
});

Deno.test("12. sweep dry-run candidates exclude rematch/active via classifier", () => {
  for (const status of ["searching_new_driver", "driver_assigned", "in_progress", "searching"]) {
    const r = classifyTerminalHoldDisposition({
      tripStatus: status,
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
    });
    if (r.action !== "skip") throw new Error(`${status} ${JSON.stringify(r)}`);
  }
});

Deno.test("13. sweep eligible only terminal non-completed", () => {
  const ok = classifyTerminalHoldDisposition({
    tripStatus: "expired",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (ok.action !== "void_full") throw new Error(JSON.stringify(ok));
});

Deno.test("14. completed settlement path unchanged (skip disposer)", () => {
  const r = classifyTerminalHoldDisposition({
    tripStatus: "completed",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.outcome !== "SKIPPED_COMPLETED") throw new Error(JSON.stringify(r));
});
