/**
 * Deno tests for FCM confirmation display gating.
 * Run: deno test src/lib/dispatchMetricsFcmDisplay.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FCM_CONFIRMATION_COVERAGE_MIN,
  fcmConfirmationCoverage,
  fcmConfirmationSparse,
  fcmDisplaySuccessRate,
  fcmEligibleCount,
} from "./dispatchMetricsFcmDisplay.ts";

Deno.test("eligible = enqueued − skip_no_token", () => {
  assertEquals(fcmEligibleCount({ pushEnqueued: 126, pushSkipNoToken: 0 }), 126);
  assertEquals(fcmEligibleCount({ pushEnqueued: 10, pushSkipNoToken: 3 }), 7);
});

Deno.test("1 confirmed of 126 is sparse — withhold misleading 0.79%", () => {
  assertEquals(
    Math.abs(fcmConfirmationCoverage({ pushSent: 1, pushFailed: 0, eligible: 126 }) - 1 / 126) < 1e-9,
    true,
  );
  assertEquals(
    fcmConfirmationSparse({
      pushSent: 1,
      pushFailed: 0,
      pushEnqueued: 126,
      pushSkipNoToken: 0,
    }),
    true,
  );
  assertEquals(
    fcmDisplaySuccessRate({
      pushSent: 1,
      pushFailed: 0,
      pushEnqueued: 126,
      pushSkipNoToken: 0,
      pushSuccessRate: 0.79,
    }),
    null,
  );
});

Deno.test("coverage threshold gates display rate", () => {
  assertEquals(FCM_CONFIRMATION_COVERAGE_MIN, 0.2);
  assertEquals(
    fcmDisplaySuccessRate({
      pushSent: 25,
      pushFailed: 0,
      pushEnqueued: 126,
      pushSuccessRate: 19.84,
    }),
    null,
  );
  assertEquals(
    fcmDisplaySuccessRate({
      pushSent: 26,
      pushFailed: 0,
      pushEnqueued: 126,
      pushSuccessRate: 20.63,
    }),
    20.63,
  );
});

Deno.test("dense confirmation shows real rate", () => {
  assertEquals(
    fcmDisplaySuccessRate({
      pushSent: 120,
      pushFailed: 2,
      pushEnqueued: 126,
      pushSuccessRate: 95.24,
    }),
    95.24,
  );
  assertEquals(
    fcmConfirmationSparse({
      pushSent: 120,
      pushFailed: 2,
      pushEnqueued: 126,
    }),
    false,
  );
});
