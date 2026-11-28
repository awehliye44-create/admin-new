/**
 * B4-A — tip re-SELECT skip when completion RETURNING is authoritative.
 *
 * Run: deno test --allow-read supabase/tests/_shared/completeTripB4aLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideTipWindowPersistPath,
  isCompleteTripB4aEnabled,
  measureCompleteTripB4aReselectWorkload,
} from "./offline/completeTripB4aSSOT.ts";
import {
  isAuthoritativeTipWindowPersisted,
  normalizeTipWindowTimestamp,
  tipWindowReturningHasAllFields,
} from "../../functions/_shared/tipWindowPersistDecisionSSOT.ts";
import { TIP_WINDOW_STATUS } from "../../functions/_shared/tipWindowConstants.ts";

const OPENED = "2026-11-27T12:00:00.000Z";
const EXPIRES = "2026-11-27T12:20:00.000Z";
const EXPECTED = {
  tip_window_opened_at: OPENED,
  tip_window_expires_at: EXPIRES,
  tip_window_status: TIP_WINDOW_STATUS.OPEN,
  tip_window_closed_at: null as null,
};

Deno.test("B4-A flag defaults OFF without env", () => {
  assertEquals(isCompleteTripB4aEnabled(undefined), false);
  assertEquals(isCompleteTripB4aEnabled("0"), false);
  assertEquals(isCompleteTripB4aEnabled("1"), true);
});

Deno.test("timestamp normalize equates Z and +00:00 RETURNING forms", () => {
  assertEquals(
    normalizeTipWindowTimestamp("2026-11-27T12:00:00.000Z"),
    normalizeTipWindowTimestamp("2026-11-27T12:00:00.000+00:00"),
  );
  assertEquals(
    isAuthoritativeTipWindowPersisted({
      expected: EXPECTED,
      persisted: {
        ...EXPECTED,
        tip_window_opened_at: "2026-11-27T12:00:00.000+00:00",
        tip_window_expires_at: "2026-11-27T12:20:00.000+00:00",
      },
    }),
    true,
  );
});

Deno.test("RETURNING authoritative → skip re-SELECT (ON and OFF)", () => {
  for (const enabled of [false, true]) {
    const d = decideTipWindowPersistPath({
      b4aEnabled: enabled,
      hasExpectedOpen: true,
      returningAuthoritative: true,
      returningRowPresent: true,
      returningHasAllTipFields: true,
    });
    assertEquals(d.performReselect, false);
    assertEquals(d.skipTipWindowColumns, true);
    assertEquals(d.action, "skip_reselect_returning_authoritative");
  }
});

Deno.test("missing RETURNING → recovery re-SELECT (fail closed path)", () => {
  const d = decideTipWindowPersistPath({
    b4aEnabled: true,
    hasExpectedOpen: true,
    returningAuthoritative: false,
    returningRowPresent: false,
    returningHasAllTipFields: false,
  });
  assertEquals(d.performReselect, true);
  assertEquals(d.reason, "returning_missing");
});

Deno.test("incomplete RETURNING fields → recovery re-SELECT", () => {
  assertEquals(
    tipWindowReturningHasAllFields({
      tip_window_opened_at: OPENED,
      tip_window_expires_at: null,
      tip_window_status: TIP_WINDOW_STATUS.OPEN,
    }),
    false,
  );
  const d = decideTipWindowPersistPath({
    b4aEnabled: true,
    hasExpectedOpen: true,
    returningAuthoritative: false,
    returningRowPresent: true,
    returningHasAllTipFields: false,
  });
  assertEquals(d.performReselect, true);
  assertEquals(d.reason, "returning_incomplete");
});

Deno.test("isolated OFF/ON: authoritative cases never re-SELECT; mismatch still recovers", () => {
  const cases = [
    {
      hasExpectedOpen: true,
      returningAuthoritative: true,
      returningRowPresent: true,
      returningHasAllTipFields: true,
    },
    {
      hasExpectedOpen: true,
      returningAuthoritative: true,
      returningRowPresent: true,
      returningHasAllTipFields: true,
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
  ];
  const off = measureCompleteTripB4aReselectWorkload({ enabled: false, cases });
  const on = measureCompleteTripB4aReselectWorkload({ enabled: true, cases });
  // Two authoritative → skip on both; one mismatch → reselect both; one no-expected → none.
  assertEquals(off.skip_reselect, 2);
  assertEquals(on.skip_reselect, 2);
  assertEquals(off.reselect_queries, 1);
  assertEquals(on.reselect_queries, 1);
});

Deno.test("stop-workflow wires B4-A decision and never drops PENDING", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "decideTipWindowPersistPath");
  assertStringIncludes(src, "isCompleteTripB4aEnabled");
  assertStringIncludes(src, "tip_window_reselect_start");
  assertStringIncludes(src, "tipWindowReturningHasAllFields");
  assertStringIncludes(src, "await postPendingEntitlement");
  assertStringIncludes(src, "payment_capture_deferred");
  assertEquals(src.includes("complete_trip_atomic"), false);
});
