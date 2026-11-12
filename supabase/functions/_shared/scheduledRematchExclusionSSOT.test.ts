/**
 * Phase 2 — confirmed cancel rematch + driver exclusion verification.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { driverNetFromCustomerTotal } from "./airportChargeFareSplitSSOT.ts";
import {
  buildScheduledUrgentConversionPatch,
  resolveConversionBroadcastEnabled,
} from "./scheduledDispatchConfig.ts";
import { buildBroadcastNowPatch } from "./scheduledAdminReleaseSSOT.ts";
import { buildExclusiveFailureConversionPatch } from "./scheduledActivationExclusiveSSOT.ts";

async function readCancelAction(): Promise<string> {
  return await Deno.readTextFile(
    new URL("../scheduled-ride-action/index.ts", import.meta.url),
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
  assertStringIncludes(block, 'rpc("decline_scheduled_ride"');
  assertStringIncludes(block, "cancelled_at: null");
  assertStringIncludes(block, "driver_id: null");
  assertStringIncludes(block, "confirmed_driver_id: null");
  // Phase 3: rematch preserves airport hold — never force broadcast_enabled: true.
  assertStringIncludes(block, "rematchBroadcastEnabled");
  assertStringIncludes(block, "airport pricing hold");
  assertEquals(block.includes("cancelled_at: releaseNowIso"), false);
  // In-progress / no-show stay terminal (cannot rematch).
  assertStringIncludes(block, "Cannot cancel after ride has started");
  assertStringIncludes(src, '["cancelled", "completed"]');
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
