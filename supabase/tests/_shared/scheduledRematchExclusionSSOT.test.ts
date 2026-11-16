/**
 * Phase 2 — confirmed cancel rematch + driver exclusion verification.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { driverNetFromCustomerTotal } from "../../functions/_shared/airportChargeFareSplitSSOT.ts";
import {
  buildScheduledUrgentConversionPatch,
  resolveConversionBroadcastEnabled,
} from "../../functions/_shared/scheduledDispatchConfig.ts";
import { buildBroadcastNowPatch } from "../../functions/_shared/scheduledAdminReleaseSSOT.ts";
import { buildExclusiveFailureConversionPatch } from "../../functions/_shared/scheduledActivationExclusiveSSOT.ts";

async function readCancelAction(): Promise<string> {
  return await Deno.readTextFile(
    new URL("../../functions/scheduled-ride-action/index.ts", import.meta.url),
  );
}

Deno.test("airport earnings example: journey 4250 + airport 500 = total 4750", () => {
  const split = driverNetFromCustomerTotal({
    customerPence: 5500, // £50 journey + £5 airport in payable
    airportPence: 500,
    commissionPercent: 15,
  });
  // commissionable = 5000; commission 750; journey net 4250; +airport → 4750
  assertEquals(split.commissionablePence, 5000);
  assertEquals(split.commissionPence, 750);
  assertEquals(split.driverNetPence, 4750);
});

Deno.test("cancel_confirmed rematch: same trip, no terminal cancelled_at, decline exclusion", async () => {
  const src = await readCancelAction();
  const block = src.slice(src.indexOf('ACTION: CANCEL CONFIRMED'));
  // SQL CAS RPC declines inside release_scheduled_assignment_for_driver_cancel;
  // Edge fallback still calls decline_scheduled_ride directly.
  assertStringIncludes(block, "release_scheduled_assignment_for_driver_cancel");
  assertStringIncludes(block, "decline_scheduled_ride");
  // Bug #22: rematch patch SSOT clears cancelled_at (never terminal cancel stamp).
  assertStringIncludes(block, "buildScheduledMarketplaceRematchPatch");
  assertStringIncludes(block, "buildScheduledUrgentRematchPatch");
  const ssot = await Deno.readTextFile(
    new URL("../../functions/_shared/scheduledPreActivationReleaseSSOT.ts", import.meta.url),
  );
  assertStringIncludes(ssot, "cancelled_at: null");
  assertStringIncludes(ssot, "driver_id: null");
  assertStringIncludes(ssot, "confirmed_driver_id: null");
  // Phase 3: rematch preserves airport hold — never force broadcast_enabled: true.
  assertStringIncludes(block, "rematchBroadcastEnabled");
  assertEquals(block.includes("cancelled_at: releaseNowIso"), false);
  // In-progress / no-show stay terminal (cannot rematch).
  assertStringIncludes(block, "Cannot cancel after ride has started");
  assertStringIncludes(src, '["cancelled", "completed"]');
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20270225140000_bug22_driver_cancel_preactivation_cas.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "decline_scheduled_ride");
});

Deno.test("conversion / Admin Broadcast / exclusive rescue preserve airport hold", () => {
  assertEquals(
    resolveConversionBroadcastEnabled({ currentBroadcastEnabled: false }),
    false,
  );
  assertEquals(
    resolveConversionBroadcastEnabled({ currentBroadcastEnabled: true }),
    true,
  );
  // Phase 3 gap closure: forceOpen must NOT clear unresolved airport pricing.
  assertEquals(
    resolveConversionBroadcastEnabled({
      currentBroadcastEnabled: false,
      forceOpen: true,
    }),
    false,
  );

  const held = buildScheduledUrgentConversionPatch({
    nowIso: "2026-01-01T00:00:00.000Z",
    searchingExpiresAtIso: "2026-01-01T00:06:00.000Z",
    broadcastEnabled: false,
  });
  assertEquals(held.broadcast_enabled, false);

  const adminHeld = buildBroadcastNowPatch({
    nowIso: "2026-01-01T00:00:00.000Z",
    searchingExpiresAtIso: "2026-01-01T00:06:00.000Z",
    currentBroadcastEnabled: false,
  });
  assertEquals(adminHeld.broadcast_enabled, false);

  const openOk = buildBroadcastNowPatch({
    nowIso: "2026-01-01T00:00:00.000Z",
    searchingExpiresAtIso: "2026-01-01T00:06:00.000Z",
    currentBroadcastEnabled: true,
  });
  assertEquals(openOk.broadcast_enabled, true);

  const exclusiveHeld = buildExclusiveFailureConversionPatch({
    nowIso: "2026-01-01T00:00:00.000Z",
    searchingExpiresAtIso: "2026-01-01T00:06:00.000Z",
    currentBroadcastEnabled: false,
  });
  assertEquals(exclusiveHeld.broadcast_enabled, false);
});

Deno.test("no-airport bookings still open broadcast by default", () => {
  const patch = buildScheduledUrgentConversionPatch({
    nowIso: "2026-01-01T00:00:00.000Z",
    searchingExpiresAtIso: "2026-01-01T00:06:00.000Z",
  });
  assertEquals(patch.broadcast_enabled, true);
});
