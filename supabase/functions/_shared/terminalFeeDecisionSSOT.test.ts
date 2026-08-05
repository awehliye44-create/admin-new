/**
 * Canonical terminal fee decision matrix — pure tests (no provider / DB).
 * Covers required cases 1–40 (fee/rematch/idempotency shapes) + classify guards.
 */
import {
  resolveTerminalPaymentDecision,
  resolveFreeWaitingExpiresAtMs,
  validateCustomerNoShowEligibility,
  type FarePricingFeeConfig,
  type TerminalTripEvidence,
} from "./terminalFeeDecisionSSOT.ts";
import { classifyTerminalHoldDisposition } from "./terminalTripPaymentDisposition.ts";

function baseConfig(over: Partial<FarePricingFeeConfig> = {}): FarePricingFeeConfig {
  return {
    cancellation_fee_pence: 300,
    cancellation_grace_period_minutes: 5,
    cancellation_apply_after_arrival_only: false,
    no_show_fee_pence: 500,
    no_show_wait_time_minutes: 4,
    no_show_apply_after_arrival_only: true,
    late_cancel_enabled: true,
    late_cancel_threshold_minutes: 60,
    late_cancel_fee_pence: 700,
    arrival_cancellation_enabled: true,
    arrival_cancellation_fee_pence: 400,
    arrival_cancellation_apply_after_free_waiting_expired: true,
    arrival_cancellation_after_arrival_only: true,
    free_waiting_minutes: 5,
    ...over,
  };
}

function evidence(over: Partial<TerminalTripEvidence> = {}): TerminalTripEvidence {
  return {
    trip_id: "trip-1",
    trip_status: "cancelled",
    started_at: null,
    arrived_at: null,
    free_wait_expires_at: null,
    cancelled_at: "2026-08-05T12:00:00.000Z",
    cancelled_by: "rider",
    scheduled_at: null,
    cancellation_grace_expires_at: null,
    driver_id: null,
    confirmed_driver_id: null,
    no_show_recorded: false,
    authorised_amount_pence: 2000,
    previously_captured_amount_pence: 0,
    payment_session_id: "sess-1",
    provider: "revolut",
    decision_at: "2026-08-05T12:00:00.000Z",
    ...over,
  };
}

function assertReason(
  d: ReturnType<typeof resolveTerminalPaymentDecision>,
  reason: string,
  capture?: number,
) {
  if (d.disposition_reason !== reason) {
    throw new Error(`expected ${reason} got ${d.disposition_reason} ${JSON.stringify(d)}`);
  }
  if (capture != null && d.capture_required_pence !== capture) {
    throw new Error(`expected capture ${capture} got ${d.capture_required_pence}`);
  }
}

// ── NO FEE ──────────────────────────────────────────────────────────

Deno.test("1. customer cancels while searching → full release", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ driver_id: null, trip_status: "cancelled" }),
    config: baseConfig(),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
  if (d.release_required_pence !== 2000) throw new Error(JSON.stringify(d));
});

Deno.test("2. customer cancels before driver arrival → full release when after-arrival-only", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      driver_id: "drv-1",
      arrived_at: null,
      cancelled_by: "rider",
    }),
    config: baseConfig({ cancellation_apply_after_arrival_only: true }),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

Deno.test("3. search expires with no driver → full release", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "expired", cancelled_by: "system" }),
    config: baseConfig(),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

Deno.test("4. final rematch expires → full release", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "expired_no_driver", cancelled_by: null }),
    config: baseConfig(),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

Deno.test("5. scheduled booking cancelled outside late window → full release", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      scheduled_at: "2026-08-05T15:00:00.000Z", // 3h later
      cancelled_at: "2026-08-05T12:00:00.000Z",
      cancelled_by: "rider",
    }),
    config: baseConfig({ late_cancel_threshold_minutes: 60 }),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

Deno.test("6. trip creation fails after auth (failed status) → full release", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "failed", cancelled_by: "system" }),
    config: baseConfig(),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

// ── ARRIVAL CANCELLATION FEE ────────────────────────────────────────

Deno.test("7. cancel after arrival before free waiting expires → no arrival fee", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      driver_id: "drv-1",
      arrived_at: "2026-08-05T11:58:00.000Z",
      free_wait_expires_at: "2026-08-05T12:03:00.000Z",
      cancelled_at: "2026-08-05T12:00:00.000Z",
      cancelled_by: "rider",
      cancellation_grace_expires_at: "2026-08-05T12:10:00.000Z", // still in grace → no other fee
    }),
    config: baseConfig(),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

Deno.test("8. cancel exactly when free waiting expires → arrival fee (boundary >=)", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      driver_id: "drv-1",
      arrived_at: "2026-08-05T11:55:00.000Z",
      free_wait_expires_at: "2026-08-05T12:00:00.000Z",
      cancelled_at: "2026-08-05T12:00:00.000Z",
      cancelled_by: "rider",
    }),
    config: baseConfig(),
  });
  assertReason(d, "ARRIVAL_CANCELLATION_FEE", 400);
});

Deno.test("9. cancel after free waiting before no-show → arrival fee only", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      driver_id: "drv-1",
      arrived_at: "2026-08-05T11:50:00.000Z",
      free_wait_expires_at: "2026-08-05T11:55:00.000Z",
      cancelled_at: "2026-08-05T12:00:00.000Z",
      cancelled_by: "rider",
      scheduled_at: "2026-08-05T12:10:00.000Z", // also inside late window
    }),
    config: baseConfig(),
  });
  // Arrival wins over late cancel
  assertReason(d, "ARRIVAL_CANCELLATION_FEE", 400);
});

Deno.test("10. arrival timestamp missing → do not apply arrival fee", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      driver_id: "drv-1",
      arrived_at: null,
      cancelled_by: "rider",
      cancellation_grace_expires_at: "2026-08-05T11:00:00.000Z",
    }),
    config: baseConfig({ cancellation_apply_after_arrival_only: false }),
  });
  if (d.disposition_reason === "ARRIVAL_CANCELLATION_FEE") {
    throw new Error("must not apply arrival fee without arrived_at");
  }
});

Deno.test("11. cancel after no-show recorded → no-show wins", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      trip_status: "no_show",
      no_show_recorded: true,
      arrived_at: "2026-08-05T11:50:00.000Z",
      free_wait_expires_at: "2026-08-05T11:55:00.000Z",
      cancelled_by: "driver",
    }),
    config: baseConfig(),
  });
  assertReason(d, "CUSTOMER_NO_SHOW", 500);
});

Deno.test("12. Start Trip occurred → arrival fee cannot apply (interrupted policy skip)", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      started_at: "2026-08-05T11:00:00.000Z",
      arrived_at: "2026-08-05T10:50:00.000Z",
      free_wait_expires_at: "2026-08-05T10:55:00.000Z",
      cancelled_by: "rider",
      trip_status: "cancelled",
    }),
    config: baseConfig(),
  });
  assertReason(d, "SKIP_STARTED_MISSING_INTERRUPTED_POLICY", 0);
  if (d.provider_action !== "skip") throw new Error(JSON.stringify(d));
});

Deno.test("13. arrival fee disabled for service area → fall through", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      driver_id: "drv-1",
      arrived_at: "2026-08-05T11:50:00.000Z",
      free_wait_expires_at: "2026-08-05T11:55:00.000Z",
      cancelled_by: "rider",
      cancellation_grace_expires_at: "2026-08-05T12:10:00.000Z",
    }),
    config: baseConfig({ arrival_cancellation_enabled: false }),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

Deno.test("14. fee capture amount → remainder release computed", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      driver_id: "drv-1",
      arrived_at: "2026-08-05T11:50:00.000Z",
      free_wait_expires_at: "2026-08-05T11:55:00.000Z",
      cancelled_by: "rider",
      authorised_amount_pence: 2000,
    }),
    config: baseConfig(),
  });
  assertReason(d, "ARRIVAL_CANCELLATION_FEE", 400);
  if (d.release_required_pence !== 1600) throw new Error(JSON.stringify(d));
});

Deno.test("15. fee exceeds remaining authorisation → never above remaining", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      trip_status: "no_show",
      no_show_recorded: true,
      authorised_amount_pence: 200,
      arrived_at: "2026-08-05T11:00:00.000Z",
    }),
    config: baseConfig({ no_show_fee_pence: 500 }),
  });
  assertReason(d, "CUSTOMER_NO_SHOW", 200);
});

// ── CUSTOMER NO-SHOW ────────────────────────────────────────────────

Deno.test("16. valid backend no-show → no-show fee only", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      trip_status: "no_show",
      no_show_recorded: true,
      arrived_at: "2026-08-05T11:00:00.000Z",
      cancelled_by: "driver",
    }),
    config: baseConfig(),
  });
  assertReason(d, "CUSTOMER_NO_SHOW", 500);
});

Deno.test("17. driver waited but no no-show recorded → do not infer no-show", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      trip_status: "cancelled",
      no_show_recorded: false,
      arrived_at: "2026-08-05T11:00:00.000Z",
      free_wait_expires_at: "2026-08-05T12:10:00.000Z", // not expired yet at cancel
      cancelled_at: "2026-08-05T12:00:00.000Z",
      cancelled_by: "rider",
      cancellation_grace_expires_at: "2026-08-05T12:10:00.000Z",
    }),
    config: baseConfig(),
  });
  if (d.disposition_reason === "CUSTOMER_NO_SHOW") throw new Error("inferred no-show");
});

Deno.test("18. no-show and cancellation race → one winning disposition (no-show)", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      trip_status: "no_show",
      no_show_recorded: true,
      arrived_at: "2026-08-05T11:00:00.000Z",
      free_wait_expires_at: "2026-08-05T11:05:00.000Z",
      cancelled_by: "rider",
      scheduled_at: "2026-08-05T12:05:00.000Z",
    }),
    config: baseConfig(),
  });
  assertReason(d, "CUSTOMER_NO_SHOW", 500);
});

Deno.test("19. no-show fee capture → unused buffer releases", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      trip_status: "no_show",
      no_show_recorded: true,
      authorised_amount_pence: 1500,
    }),
    config: baseConfig({ no_show_fee_pence: 500 }),
  });
  if (d.release_required_pence !== 1000) throw new Error(JSON.stringify(d));
});

Deno.test("20. duplicate no-show action → same idempotency key", () => {
  const a = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "no_show", no_show_recorded: true }),
    config: baseConfig(),
  });
  const b = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "no_show", no_show_recorded: true }),
    config: baseConfig(),
  });
  if (a.idempotency_key !== b.idempotency_key) throw new Error("keys diverge");
});

Deno.test("no-show eligibility validator rejects early wait", () => {
  const r = validateCustomerNoShowEligibility({
    arrived_at: "2026-08-05T12:00:00.000Z",
    no_show_apply_after_arrival_only: true,
    no_show_wait_time_minutes: 4,
    nowMs: Date.parse("2026-08-05T12:02:00.000Z"),
  });
  if (r.ok) throw new Error("should reject");
});

// ── LATE PASSENGER CANCELLATION ─────────────────────────────────────

Deno.test("21. scheduled cancel inside late window → late fee only", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      scheduled_at: "2026-08-05T12:30:00.000Z",
      cancelled_at: "2026-08-05T12:00:00.000Z",
      cancelled_by: "rider",
      arrived_at: null,
    }),
    config: baseConfig({
      late_cancel_threshold_minutes: 60,
      arrival_cancellation_enabled: false,
    }),
  });
  assertReason(d, "LATE_PASSENGER_CANCELLATION", 700);
});

Deno.test("22. scheduled cancel outside window → no late fee", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      scheduled_at: "2026-08-05T18:00:00.000Z",
      cancelled_at: "2026-08-05T12:00:00.000Z",
      cancelled_by: "rider",
    }),
    config: baseConfig({ late_cancel_threshold_minutes: 60 }),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

Deno.test("23. instant trip cancel → no scheduled late fee", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      scheduled_at: null,
      cancelled_by: "rider",
      driver_id: null,
    }),
    config: baseConfig({ late_cancel_enabled: true }),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

Deno.test("24. late policy inactive → no late fee", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      scheduled_at: "2026-08-05T12:30:00.000Z",
      cancelled_by: "rider",
    }),
    config: baseConfig({ late_cancel_enabled: false }),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

Deno.test("25. service-area-specific late amount is used", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      scheduled_at: "2026-08-05T12:30:00.000Z",
      cancelled_by: "rider",
    }),
    config: baseConfig({
      late_cancel_fee_pence: 1234,
      arrival_cancellation_enabled: false,
    }),
  });
  assertReason(d, "LATE_PASSENGER_CANCELLATION", 1234);
});

Deno.test("26. backend cancelled_at wins over device clock (decision_at unused when cancelled_at set)", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      scheduled_at: "2026-08-05T12:30:00.000Z",
      cancelled_at: "2026-08-05T12:00:00.000Z",
      decision_at: "2099-01-01T00:00:00.000Z", // would be outside window if used wrongly for scheduled calc
      cancelled_by: "rider",
    }),
    config: baseConfig({
      late_cancel_threshold_minutes: 60,
      arrival_cancellation_enabled: false,
    }),
  });
  assertReason(d, "LATE_PASSENGER_CANCELLATION", 700);
});

Deno.test("27. scheduled cancel after arrival/free-wait → arrival wins, never stack", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      driver_id: "drv-1",
      arrived_at: "2026-08-05T11:50:00.000Z",
      free_wait_expires_at: "2026-08-05T11:55:00.000Z",
      scheduled_at: "2026-08-05T12:10:00.000Z",
      cancelled_by: "rider",
    }),
    config: baseConfig(),
  });
  assertReason(d, "ARRIVAL_CANCELLATION_FEE", 400);
  if (d.fee_amount_pence !== 400) throw new Error("stacked fees");
});

Deno.test("28. scheduled no-show → no-show wins over late cancellation", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      trip_status: "no_show",
      no_show_recorded: true,
      scheduled_at: "2026-08-05T12:10:00.000Z",
      cancelled_by: "driver",
    }),
    config: baseConfig(),
  });
  assertReason(d, "CUSTOMER_NO_SHOW", 500);
});

// ── REMATCH / ACTIVE ────────────────────────────────────────────────

Deno.test("29. rematch searching_new_driver → keep authorisation", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "searching_new_driver" }),
    config: baseConfig(),
  });
  assertReason(d, "SKIP_ACTIVE_OR_REMATCH", 0);
  if (d.provider_action !== "skip") throw new Error(JSON.stringify(d));
});

Deno.test("30. offer ACK timeout while searching → keep authorisation", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "searching" }),
    config: baseConfig(),
  });
  assertReason(d, "SKIP_ACTIVE_OR_REMATCH", 0);
});

Deno.test("31. final rematch expiry status → resolve and release", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "expired" }),
    config: baseConfig(),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
  if (d.provider_action !== "void_full") throw new Error(JSON.stringify(d));
});

Deno.test("32. active/rematching excluded from fallback classify", () => {
  for (const status of ["searching_new_driver", "in_progress", "driver_assigned"]) {
    const r = classifyTerminalHoldDisposition({
      tripStatus: status,
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
    });
    if (r.action !== "skip") throw new Error(status);
  }
});

// ── IDEMPOTENCY / SAFETY SHAPES ─────────────────────────────────────

Deno.test("33. duplicate cancellation events → same idempotency key", () => {
  const a = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "cancelled", cancelled_by: "rider" }),
    config: baseConfig(),
  });
  const b = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "cancelled", cancelled_by: "rider" }),
    config: baseConfig(),
  });
  if (a.idempotency_key !== b.idempotency_key) throw new Error("diverge");
});

Deno.test("40. no fee applies → release_required equals authorised", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ authorised_amount_pence: 999 }),
    config: baseConfig(),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
  if (d.release_required_pence !== 999) throw new Error(JSON.stringify(d));
});

Deno.test("41-43. completed trip excluded from terminal release", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ trip_status: "completed" }),
    config: baseConfig(),
  });
  assertReason(d, "SKIP_COMPLETED", 0);
  const c = classifyTerminalHoldDisposition({
    tripStatus: "completed",
    feePence: 500,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (c.outcome !== "SKIPPED_COMPLETED") throw new Error(JSON.stringify(c));
});

Deno.test("started_at classify → interrupted policy skip", () => {
  const c = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    startedAt: "2026-08-05T12:00:00.000Z",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (c.outcome !== "SKIPPED_STARTED_MISSING_INTERRUPTED_POLICY") {
    throw new Error(JSON.stringify(c));
  }
});

Deno.test("free waiting expiry resolves from arrived_at + configured minutes", () => {
  const ms = resolveFreeWaitingExpiresAtMs({
    arrived_at: "2026-08-05T12:00:00.000Z",
    free_wait_expires_at: null,
    free_waiting_minutes: 5,
  });
  if (ms !== Date.parse("2026-08-05T12:05:00.000Z")) throw new Error(String(ms));
});

Deno.test("incomplete free-wait evidence → full release not arrival fee", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      driver_id: "drv-1",
      arrived_at: "2026-08-05T11:50:00.000Z",
      free_wait_expires_at: null,
      cancelled_by: "rider",
    }),
    config: baseConfig({ free_waiting_minutes: null }),
  });
  assertReason(d, "INCOMPLETE_EVIDENCE_FULL_RELEASE", 0);
});

Deno.test("driver cancel terminal → no customer fee", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      cancelled_by: "driver",
      trip_status: "cancelled",
      no_show_recorded: false,
      arrived_at: "2026-08-05T11:50:00.000Z",
      free_wait_expires_at: "2026-08-05T11:55:00.000Z",
    }),
    config: baseConfig(),
  });
  assertReason(d, "NO_FEE_FULL_RELEASE", 0);
});

Deno.test("OTHER_CANCELLATION_FEE after grace pre-arrival", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      driver_id: "drv-1",
      arrived_at: null,
      cancelled_by: "rider",
      cancellation_grace_expires_at: "2026-08-05T11:00:00.000Z",
    }),
    config: baseConfig({
      arrival_cancellation_enabled: false,
      late_cancel_enabled: false,
      cancellation_apply_after_arrival_only: false,
      cancellation_fee_pence: 300,
    }),
  });
  assertReason(d, "OTHER_CANCELLATION_FEE", 300);
});
