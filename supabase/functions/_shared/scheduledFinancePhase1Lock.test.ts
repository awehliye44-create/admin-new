/**
 * Phase 1 scheduled finance lock — advance window + capture coverage invariants.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateScheduledAdvanceWindow,
  maxAdvanceElapsedMs,
  SCHEDULED_ADVANCE_WINDOW_DEFAULTS,
  computeRequiredCaptureCoverageUntilMs,
} from "./scheduledAdvanceWindowSSOT.ts";
import {
  evaluateCaptureDeadlineCoverage,
  mergeCaptureDeadlinePersistence,
  isCardFundedPaymentMethod,
} from "./scheduledCaptureCoverageSSOT.ts";
import { SCHEDULED_BOOKING_POLICY_DEFAULTS } from "../../../shared/scheduledRidesPolicySSOT.ts";

Deno.test("Phase1 defaults: 5 days / 20 min / 120h", () => {
  assertEquals(SCHEDULED_ADVANCE_WINDOW_DEFAULTS.maxAdvanceDays, 5);
  assertEquals(SCHEDULED_ADVANCE_WINDOW_DEFAULTS.minAdvanceMinutes, 20);
  assertEquals(maxAdvanceElapsedMs(5), 120 * 3600_000);
  assertEquals(SCHEDULED_BOOKING_POLICY_DEFAULTS.max_advance_days, 5);
});

Deno.test("authorisation expires before expected completion → insufficient definitive", () => {
  const pickup = "2026-07-01T18:00:00.000Z";
  const r = evaluateCaptureDeadlineCoverage({
    scheduledAtIso: pickup,
    estimatedDurationMinutes: 50,
    captureDeadlineIso: new Date(Date.parse(pickup) + 10 * 60_000).toISOString(),
    session: { status: "authorised", provider_state: "AUTHORISED" },
  });
  assertEquals(r.verdict, "insufficient");
  assertEquals(r.definitive, true);
});

Deno.test("exactly 120h boundary + DST spring-forward still UTC elapsed", () => {
  const nowMs = Date.parse("2026-03-28T01:30:00.000Z");
  const at = new Date(nowMs + 120 * 3600_000).toISOString();
  assert(
    evaluateScheduledAdvanceWindow({
      scheduledAtIso: at,
      nowMs,
      policy: SCHEDULED_ADVANCE_WINDOW_DEFAULTS,
    }).ok,
  );
  assertEquals(
    evaluateScheduledAdvanceWindow({
      scheduledAtIso: new Date(nowMs + 120 * 3600_000 + 1).toISOString(),
      nowMs,
      policy: SCHEDULED_ADVANCE_WINDOW_DEFAULTS,
    }).ok,
    false,
  );
});

Deno.test("grandfather existing >5d booking keeps TOO_FAR open", () => {
  const nowMs = Date.parse("2026-07-01T12:00:00.000Z");
  const far = new Date(nowMs + 10 * 24 * 3600_000).toISOString();
  assert(
    evaluateScheduledAdvanceWindow({
      scheduledAtIso: far,
      nowMs,
      policy: SCHEDULED_ADVANCE_WINDOW_DEFAULTS,
      grandfatherMaxAdvance: true,
    }).ok,
  );
});

Deno.test("delayed pickup / longer journey recalculates required horizon", () => {
  const original = computeRequiredCaptureCoverageUntilMs({
    scheduledAtIso: "2026-07-01T12:00:00.000Z",
    estimatedDurationMinutes: 30,
  })!;
  const delayed = computeRequiredCaptureCoverageUntilMs({
    scheduledAtIso: "2026-07-01T14:00:00.000Z",
    estimatedDurationMinutes: 90,
  })!;
  assert(delayed > original);
  const deadline = new Date(original).toISOString();
  const r = evaluateCaptureDeadlineCoverage({
    scheduledAtIso: "2026-07-01T14:00:00.000Z",
    estimatedDurationMinutes: 90,
    captureDeadlineIso: deadline,
    session: { status: "authorised", provider_state: "AUTHORISED" },
  });
  assertEquals(r.verdict, "insufficient");
});

Deno.test("non-card methods are not card-funded coverage subjects", () => {
  assertEquals(isCardFundedPaymentMethod("cash"), false);
  assertEquals(isCardFundedPaymentMethod("corporate_invoice"), false);
  assertEquals(isCardFundedPaymentMethod("card"), true);
});

Deno.test("webhook omit does not clear deadline (duplicate release / race hygiene)", () => {
  const m = mergeCaptureDeadlinePersistence({
    existingDeadlineIso: "2026-07-02T00:00:00.000Z",
    providerDeadlineRaw: null,
    source: "provider_webhook",
  });
  assertEquals(m.captureDeadlineIso, "2026-07-02T00:00:00.000Z");
});
