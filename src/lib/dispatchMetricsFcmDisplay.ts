/**
 * Dispatch Metrics — FCM confirmation display helpers.
 *
 * Provider acceptance rate is only meaningful once enough offers in the window
 * have a terminal FCM outcome (push_sent / push_failed). A single smoke probe
 * against a large historical eligible pool must not look like "0.79% FCM success".
 */

/** Min share of eligible offers with push_sent|push_failed before rate is shown. */
export const FCM_CONFIRMATION_COVERAGE_MIN = 0.2;

export function fcmEligibleCount(input: {
  pushEnqueued: number;
  pushSkipNoToken?: number | null;
}): number {
  return Math.max(input.pushEnqueued - (input.pushSkipNoToken ?? 0), 0);
}

export function fcmConfirmationCoverage(input: {
  pushSent: number;
  pushFailed: number;
  eligible: number;
}): number {
  if (input.eligible <= 0) return 0;
  return (Math.max(0, input.pushSent) + Math.max(0, input.pushFailed)) / input.eligible;
}

/**
 * Rate used for the FCM card value + health.
 * null = not enough confirmation logging yet (treat like unlogged).
 */
export function fcmDisplaySuccessRate(input: {
  pushSent: number;
  pushFailed: number;
  pushEnqueued: number;
  pushSkipNoToken?: number | null;
  pushSuccessRate: number | null;
}): number | null {
  const eligible = fcmEligibleCount(input);
  if (eligible <= 0) return null;
  const coverage = fcmConfirmationCoverage({
    pushSent: input.pushSent,
    pushFailed: input.pushFailed,
    eligible,
  });
  if (coverage < FCM_CONFIRMATION_COVERAGE_MIN) return null;
  return input.pushSuccessRate;
}

export function fcmConfirmationSparse(input: {
  pushSent: number;
  pushFailed: number;
  pushEnqueued: number;
  pushSkipNoToken?: number | null;
}): boolean {
  const eligible = fcmEligibleCount(input);
  if (eligible <= 0) return false;
  return (
    fcmConfirmationCoverage({
      pushSent: input.pushSent,
      pushFailed: input.pushFailed,
      eligible,
    }) < FCM_CONFIRMATION_COVERAGE_MIN
  );
}
