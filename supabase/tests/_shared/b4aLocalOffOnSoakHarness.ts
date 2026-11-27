/**
 * B4-A isolated OFF/ON soak — tip re-SELECT query count + decision latency.
 * No network, no paid bookings. Pure decision-path measurement.
 */
import {
  decideTipWindowPersistPath,
  measureCompleteTripB4aReselectWorkload,
} from "../../functions/_shared/completeTripB4aSSOT.ts";
import { isAuthoritativeTipWindowPersisted } from "../../functions/_shared/tipWindowPersistDecisionSSOT.ts";
import { TIP_WINDOW_STATUS } from "../../functions/_shared/tipWindowConstants.ts";

export type B4aSoakResult = {
  all_pass: boolean;
  off: { reselect_queries: number; skip_reselect: number; decision_ns: number };
  on: { reselect_queries: number; skip_reselect: number; decision_ns: number };
  checks: Record<string, boolean>;
};

const OPENED = "2026-11-27T12:00:00.000Z";
const EXPIRES = "2026-11-27T12:20:00.000Z";
const EXPECTED = {
  tip_window_opened_at: OPENED,
  tip_window_expires_at: EXPIRES,
  tip_window_status: TIP_WINDOW_STATUS.OPEN,
  tip_window_closed_at: null as null,
};

/** Mix: healthy RETURNING (+00:00), missing, incomplete, mismatch, no window. */
function buildCases() {
  const returningOkPg = {
    tip_window_opened_at: "2026-11-27T12:00:00.000+00:00",
    tip_window_expires_at: "2026-11-27T12:20:00.000+00:00",
    tip_window_status: TIP_WINDOW_STATUS.OPEN,
    tip_window_closed_at: null as null,
  };
  const healthy = Array.from({ length: 40 }, () => ({
    hasExpectedOpen: true,
    returningAuthoritative: isAuthoritativeTipWindowPersisted({
      expected: EXPECTED,
      persisted: returningOkPg,
    }),
    returningRowPresent: true,
    returningHasAllTipFields: true,
  }));
  const edge = [
    {
      hasExpectedOpen: true,
      returningAuthoritative: false,
      returningRowPresent: false,
      returningHasAllTipFields: false,
    },
    {
      hasExpectedOpen: true,
      returningAuthoritative: false,
      returningRowPresent: true,
      returningHasAllTipFields: false,
    },
    {
      hasExpectedOpen: true,
      returningAuthoritative: false,
      returningRowPresent: true,
      returningHasAllTipFields: true,
    },
    {
      hasExpectedOpen: false,
      returningAuthoritative: false,
      returningRowPresent: false,
      returningHasAllTipFields: false,
    },
    // Concurrent duplicate: RETURNING already completed open window
    {
      hasExpectedOpen: true,
      returningAuthoritative: true,
      returningRowPresent: true,
      returningHasAllTipFields: true,
    },
  ];
  return [...healthy, ...edge];
}

function timeDecisions(enabled: boolean, cases: ReturnType<typeof buildCases>): number {
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) {
    for (const c of cases) {
      decideTipWindowPersistPath({ b4aEnabled: enabled, ...c });
    }
  }
  return Math.round((performance.now() - t0) * 1e6); // ns-ish via ms*1e6
}

export function runB4aLocalOffOnSoak(): B4aSoakResult {
  const cases = buildCases();
  const offW = measureCompleteTripB4aReselectWorkload({ enabled: false, cases });
  const onW = measureCompleteTripB4aReselectWorkload({ enabled: true, cases });
  const offNs = timeDecisions(false, cases);
  const onNs = timeDecisions(true, cases);

  const checks = {
    healthy_returning_skips_both: offW.skip_reselect === onW.skip_reselect &&
      offW.skip_reselect >= 40,
    recovery_reselect_preserved: offW.reselect_queries === onW.reselect_queries &&
      onW.reselect_queries >= 3,
    no_memory_authority: decideTipWindowPersistPath({
      b4aEnabled: true,
      hasExpectedOpen: true,
      returningAuthoritative: false,
      returningRowPresent: false,
      returningHasAllTipFields: false,
    }).performReselect === true,
    pg_returning_normalized_authoritative: isAuthoritativeTipWindowPersisted({
      expected: EXPECTED,
      persisted: {
        tip_window_opened_at: "2026-11-27T12:00:00.000+00:00",
        tip_window_expires_at: "2026-11-27T12:20:00.000+00:00",
        tip_window_status: TIP_WINDOW_STATUS.OPEN,
        tip_window_closed_at: null,
      },
    }) === true,
  };

  const all_pass = Object.values(checks).every(Boolean);
  return {
    all_pass,
    off: { ...offW, decision_ns: offNs },
    on: { ...onW, decision_ns: onNs },
    checks,
  };
}

if (import.meta.main) {
  const result = runB4aLocalOffOnSoak();
  console.log(JSON.stringify(result, null, 2));
  if (!result.all_pass) Deno.exit(1);
}
