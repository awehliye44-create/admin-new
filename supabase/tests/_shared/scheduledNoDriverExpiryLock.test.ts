/**
 * STEP 4 no-driver expiry gap lock + Admin presentation wiring.
 * Run:
 *   deno test --allow-read supabase/tests/_shared/scheduledNoDriverExpiryLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveBackfillSearchingExpiresAtIso,
  shouldExpireConvertedScheduledNoDriver,
} from "../../functions/_shared/scheduledNoDriverExpirySSOT.ts";

Deno.test("past pickup + null searching_expires_at → expire (no Overdue linger)", () => {
  const decision = shouldExpireConvertedScheduledNoDriver({
    searchingExpiresAt: null,
    scheduledAt: "2026-09-23T09:20:00.000Z",
    nowMs: Date.parse("2026-09-23T09:25:00.000Z"),
  });
  assertEquals(decision.expire, true);
  assertEquals(decision.reason, "past_pickup_no_search_deadline");
});

Deno.test("stamped searching_expires_at past → expire via search window", () => {
  const decision = shouldExpireConvertedScheduledNoDriver({
    searchingExpiresAt: "2026-09-23T09:15:00.000Z",
    scheduledAt: "2026-09-23T09:20:00.000Z",
    nowMs: Date.parse("2026-09-23T09:16:00.000Z"),
  });
  assertEquals(decision.expire, true);
  assertEquals(decision.reason, "search_window_exhausted");
});

Deno.test("open search window before pickup → do not expire", () => {
  const decision = shouldExpireConvertedScheduledNoDriver({
    searchingExpiresAt: "2026-09-23T09:30:00.000Z",
    scheduledAt: "2026-09-23T09:40:00.000Z",
    nowMs: Date.parse("2026-09-23T09:16:00.000Z"),
  });
  assertEquals(decision.expire, false);
  assertEquals(decision.reason, "search_window_open");
});

Deno.test("null deadline before pickup → await + backfill helper caps at pickup", () => {
  const decision = shouldExpireConvertedScheduledNoDriver({
    searchingExpiresAt: null,
    scheduledAt: "2026-09-23T10:00:00.000Z",
    nowMs: Date.parse("2026-09-23T09:00:00.000Z"),
  });
  assertEquals(decision.expire, false);
  assertEquals(decision.reason, "awaiting_search_deadline");

  const backfill = resolveBackfillSearchingExpiresAtIso({
    nowMs: Date.parse("2026-09-23T09:00:00.000Z"),
    scheduledAt: "2026-09-23T09:03:00.000Z",
    maxFindDriverMinutes: 6,
  });
  assertEquals(backfill, "2026-09-23T09:03:00.000Z");
});

Deno.test("scheduled-dispatch STEP 4 uses expiry SSOT + clears confirmed/pending", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "shouldExpireConvertedScheduledNoDriver");
  assertStringIncludes(src, "resolveBackfillSearchingExpiresAtIso");
  assertStringIncludes(src, "missed_reason: decision.reason");
  assertStringIncludes(src, "confirmed_driver_id: null");
  assertStringIncludes(src, "pending_release_kind: null");
  assertStringIncludes(src, 'scheduled_status: "no_driver_found"');
  // Null deadline must not invent a future window via expire RPC — stamp past first.
  assertStringIncludes(src, "nowMs - 1000");
  assertStringIncludes(src, "expireTripWhenSearchExhaustedAndNotifyCustomer");
  // Past-pickup HELD/Jobs/preconfirm must also leave the live board.
  assertStringIncludes(src, "expirePastPickup");
  assertStringIncludes(src, "buildScheduledUrgentConversionPatch");
  assertStringIncludes(src, "was_converted");
});

Deno.test("Admin ScheduledRides uses presentation SSOT + excludes active driver_id", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../src/pages/ScheduledRides.tsx", import.meta.url),
  );
  assertStringIncludes(src, "resolveAdminScheduledRidePresentation");
  assertStringIncludes(src, "resolveAdminScheduledTimeCue");
  assertStringIncludes(src, ".is('driver_id', null)");
  assertStringIncludes(
    src,
    "confirmed_driver:drivers!trips_confirmed_driver_id_fkey",
  );
  assert(!/getScheduleStatus/.test(src), "Overdue getScheduleStatus must be removed");
  assert(!/SelectItem value="overdue"/.test(src), "Overdue filter must be removed");
  assert(!/\? 'Pending'/.test(src), "Pending fallback label must be gone");
  // View Details must use the same ownership SSOT (not driver_id-only).
  assertStringIncludes(src, "Pre-confirmed Driver");
  assertStringIncludes(src, "detailPresentation");
  // Scheduled Jobs Now / At
  assertStringIncludes(src, "handleMakeAvailableScheduledJobsAt");
  assertStringIncludes(src, "pending_release_kind: 'jobs'");
  assertStringIncludes(src, "Scheduled Jobs At");
});

Deno.test("HELD insert migration preserves admin_held without broadcast stamp", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20261126140000_preserve_admin_held_on_scheduled_insert.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(mig, "admin_held");
  assertStringIncludes(mig, "NEW.scheduled_broadcast_at := NULL");
  assertStringIncludes(mig, "Preserves admin_held");
});
