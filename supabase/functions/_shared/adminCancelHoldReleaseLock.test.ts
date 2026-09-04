/**
 * Lock: Admin cancel + started_at must dispose Revolut hold via shared path.
 * A–G payment remediation for MK-260816-006 class defects.
 *
 * Run: deno test --allow-read supabase/functions/_shared/adminCancelHoldReleaseLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyTerminalHoldDisposition } from "./terminalTripPaymentDisposition.ts";
import { resolveTerminalPaymentDecision } from "./terminalFeeDecisionSSOT.ts";

const adminActionsPath = new URL("../admin-trip-actions/index.ts", import.meta.url);
const activeTripsPath = new URL("../../../src/pages/ActiveTrips.tsx", import.meta.url);
const scheduledRidesPath = new URL("../../../src/pages/ScheduledRides.tsx", import.meta.url);
const cancelPath = new URL("../cancel-trip/index.ts", import.meta.url);
const disposePath = new URL("./terminalTripPaymentDisposition.ts", import.meta.url);
const feePath = new URL("./terminalFeeDecisionSSOT.ts", import.meta.url);

const feeConfig = {
  cancellation_fee_pence: 500,
  cancellation_grace_period_minutes: 5,
  cancellation_apply_after_arrival_only: false,
  no_show_fee_pence: 800,
  no_show_wait_time_minutes: 5,
  no_show_apply_after_arrival_only: true,
  late_cancel_enabled: false,
  late_cancel_threshold_minutes: null,
  late_cancel_fee_pence: null,
  arrival_cancellation_enabled: false,
  arrival_cancellation_fee_pence: null,
  arrival_cancellation_apply_after_free_waiting_expired: null,
  arrival_cancellation_after_arrival_only: null,
  free_waiting_minutes: null,
};

function baseEvidence(over: Partial<Parameters<typeof resolveTerminalPaymentDecision>[0]["evidence"]> = {}) {
  return {
    trip_id: "trip-1",
    trip_status: "cancelled",
    started_at: null as string | null,
    arrived_at: null as string | null,
    free_wait_expires_at: null,
    cancelled_at: "2026-08-16T20:50:05.000Z",
    cancelled_by: "admin",
    scheduled_at: null,
    cancellation_grace_expires_at: null,
    driver_id: "drv-1",
    confirmed_driver_id: "drv-1",
    no_show_recorded: false,
    authorised_amount_pence: 788,
    previously_captured_amount_pence: 0,
    payment_session_id: "sess-1",
    provider: "revolut",
    decision_at: "2026-08-16T20:50:05.000Z",
    ...over,
  };
}

Deno.test("A: rider cancel + untouched auth classifies void_full", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: baseEvidence({
      cancelled_by: "rider",
      authorised_amount_pence: 450,
      driver_id: null,
      confirmed_driver_id: null,
    }),
    config: feeConfig,
    feePolicyId: "fps-1",
  });
  assertEquals(d.provider_action, "void_full");
  assertEquals(d.release_required_pence, 450);
  assertEquals(d.capture_required_pence, 0);
});

Deno.test("B: admin cancel + untouched auth → void_full", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: baseEvidence({ authorised_amount_pence: 788, started_at: null }),
    config: feeConfig,
    feePolicyId: "fps-1",
  });
  assertEquals(d.provider_action, "void_full");
  assertEquals(d.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(d.release_required_pence, 788);
});

Deno.test("C: admin cancel after fare decrease — release auth 788 not fare 413", () => {
  // Fare may be 413; authorised hold on session/order remains 788.
  const d = resolveTerminalPaymentDecision({
    evidence: baseEvidence({
      started_at: "2026-08-16T20:38:31.000Z",
      authorised_amount_pence: 788,
      cancelled_by: "admin",
    }),
    config: feeConfig,
    feePolicyId: "fps-1",
  });
  assertEquals(d.provider_action, "void_full");
  assertEquals(d.authorised_amount_pence, 788);
  assertEquals(d.release_required_pence, 788);
  assertEquals(d.capture_required_pence, 0);
});

Deno.test("D: same-order incremental auth — release full current authorised total", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: baseEvidence({
      authorised_amount_pence: 1039,
      cancelled_by: "admin",
      started_at: "2026-08-16T20:00:00.000Z",
    }),
    config: feeConfig,
    feePolicyId: "fps-1",
  });
  assertEquals(d.release_required_pence, 1039);
  assertEquals(d.provider_action, "void_full");
});

Deno.test("E: admin-trip-actions invokes dispose (idempotent shared path); ActiveTrips + ScheduledRides use Edge", async () => {
  const adminSrc = await Deno.readTextFile(adminActionsPath);
  assertStringIncludes(adminSrc, "disposeTerminalTripPayment");
  assertStringIncludes(adminSrc, 'reason: "admin_cancel"');
  assertStringIncludes(adminSrc, "forceFeePenceOverride: true");
  assertStringIncludes(adminSrc, "feePence: 0");
  assertStringIncludes(adminSrc, "apply_terminal_trip_cancellation");
  // Staff gate must key auth.users id via user_id — not staff_profiles.id PK.
  assertStringIncludes(adminSrc, '.eq("user_id", userId)');
  assertEquals(adminSrc.includes('.eq("id", userId)'), false);
  // Must not invent a second Revolut cancel client
  assertEquals(adminSrc.includes("cancelRevolutOrder"), false);

  const ui = await Deno.readTextFile(activeTripsPath);
  assertStringIncludes(ui, "admin-trip-actions");
  assertEquals(
    /handleCancel[\s\S]*?supabase\.rpc\(\s*['\"]apply_terminal_trip_cancellation['\"]/.test(ui),
    false,
  );

  const scheduledUi = await Deno.readTextFile(scheduledRidesPath);
  assertStringIncludes(scheduledUi, "admin-trip-actions");
  // Old mute path wrote trips.status + scheduled_status together; Edge cancel owns status.
  assertEquals(
    /status:\s*['\"]cancelled['\"],\s*scheduled_status:\s*['\"]cancelled['\"]/.test(scheduledUi),
    false,
  );
  assertStringIncludes(scheduledUi, "scheduled_status: 'cancelled'");
});

Deno.test("F: completed trip never voids uncaptured hold", () => {
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "completed",
      startedAt: "2026-08-16T20:00:00.000Z",
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
    }).action,
    "skip",
  );
  const d = resolveTerminalPaymentDecision({
    evidence: baseEvidence({ trip_status: "completed", started_at: "2026-08-16T20:00:00.000Z" }),
    config: feeConfig,
  });
  assertEquals(d.provider_action, "skip");
  assertEquals(d.disposition_reason, "SKIP_COMPLETED");
});

Deno.test("G: legitimate no-show fee policy preserved (partial capture)", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: baseEvidence({
      trip_status: "no_show",
      cancelled_by: "driver",
      no_show_recorded: true,
      arrived_at: "2026-08-16T20:30:00.000Z",
      started_at: null,
      authorised_amount_pence: 788,
    }),
    config: feeConfig,
    feePolicyId: "fps-1",
  });
  assertEquals(d.disposition_reason, "CUSTOMER_NO_SHOW");
  assertEquals(d.provider_action, "partial_capture_fee");
  assertEquals(d.capture_required_pence, 788); // min(fee 800, auth 788)
  assertEquals(d.release_required_pence, 0);
});

Deno.test("started_at + cancelled + fee=0 classifies void_full (no stranded hold)", () => {
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "cancelled",
      startedAt: "2026-08-16T20:38:31.000Z",
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
    }).action,
    "void_full",
  );
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "cancelled",
      startedAt: "2026-08-16T20:38:31.000Z",
      feePence: 500,
      hasProviderOrder: true,
      provider: "revolut",
    }).action,
    "partial_capture_fee",
  );
});

Deno.test("cancel-trip still owns rider dispose; dispose uses cancelRevolutOrder only once", async () => {
  const cancel = await Deno.readTextFile(cancelPath);
  assertStringIncludes(cancel, "disposeTerminalTripPayment");
  const dispose = await Deno.readTextFile(disposePath);
  assertStringIncludes(dispose, "cancelRevolutOrder");
  assertEquals(dispose.includes("refundRevolutOrder"), false);
  const fee = await Deno.readTextFile(feePath);
  assert(
    !fee.includes('reason: "SKIP_STARTED_MISSING_INTERRUPTED_POLICY"'),
    "started_at must not early-return SKIP (stranded AUTHORISED)",
  );
});
