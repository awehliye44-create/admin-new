/**
 * Admin HELD scheduled create lock — Hard Rule #1.
 *
 * New scheduled bookings start admin_held with no marketplace broadcast_at.
 * T−urgent convert_at is still stamped. Drivers must not see the job until
 * Admin Assign/Broadcast release (or T−urgent emergency convert).
 *
 * Run: deno test --allow-read supabase/tests/_shared/adminHeldScheduledCreateLock.test.ts
 */
import {
  assertEquals,
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildMinimalTripInsertRow } from "../../functions/_shared/bookingSSOT.ts";
import {
  ADMIN_HELD_SCHEDULED_STATUS,
  isAdminHeldScheduledStatus,
  NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES,
  resolveScheduledDispatchConfig,
} from "../../functions/_shared/scheduledDispatchConfig.ts";

const FIXTURE = {
  body: {
    client_action_id: "held-lock-1",
    pickup: { address: "A", lat: 52.04, lng: -0.76 },
    dropoff: { address: "B", lat: 52.05, lng: -0.75 },
    when: "SCHEDULED" as const,
    scheduled_at: "2026-09-21T14:00:00.000Z",
    estimated_fare: 12.5,
    payment_method: "card",
  },
  customerId: "cust-1",
  tripCode: "MK-TEST-001",
  preauthAmountPence: 1500,
  finalFarePence: 1250,
  paymentRefId: "ord_1",
  paymentProvider: "revolut" as const,
  regionId: "reg-1",
  regionCurrencyCode: "GBP",
  regionDistanceUnit: "mi",
  serviceAreaId: "sa-1",
  serviceAreaCode: "MK",
  nowMs: Date.parse("2026-09-21T12:00:00.000Z"),
  scheduledDispatchConfig: resolveScheduledDispatchConfig({
    enable_scheduled_to_urgent_conversion: true,
    scheduled_response_window_minutes: 4,
    urgent_dispatch_trigger_minutes_before_pickup: 9,
    max_driver_find_time_minutes: 6,
  }),
};

Deno.test("Admin HELD: create stamps admin_held + null broadcast_at + T−9 convert_at", () => {
  const row = buildMinimalTripInsertRow(FIXTURE);
  assertEquals(row.status, "scheduled");
  assertEquals(row.dispatch_mode, "scheduled");
  assertEquals(row.is_scheduled, true);
  assertEquals(row.scheduled_status, ADMIN_HELD_SCHEDULED_STATUS);
  assertEquals(row.scheduled_broadcast_at, null);
  assertEquals(row.scheduled_convert_at, "2026-09-21T13:51:00.000Z");
  assert(isAdminHeldScheduledStatus(String(row.scheduled_status)));
});

Deno.test("Admin HELD: immediate NOW booking is unchanged", () => {
  const row = buildMinimalTripInsertRow({
    ...FIXTURE,
    body: {
      ...FIXTURE.body,
      when: "NOW",
      scheduled_at: null,
    },
  });
  assertEquals(row.status, "searching");
  assertEquals(row.scheduled_status, null);
  assertEquals(row.scheduled_broadcast_at, null);
  assertEquals(row.scheduled_convert_at, null);
  assertEquals(row.is_scheduled, false);
});

Deno.test("Admin HELD: T−urgent convert list includes admin_held; Step 2 broadcast filter stays scheduled-only", async () => {
  assert(
    (NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES as readonly string[]).includes(
      "admin_held",
    ),
  );
  const dispatchSrc = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  // Marketplace auto-broadcast must not pick admin_held (still eq scheduled).
  assertStringIncludes(dispatchSrc, '.eq("scheduled_status", "scheduled")');
  assertStringIncludes(dispatchSrc, "NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES");
});

Deno.test("Admin HELD: bookingSSOT does not stamp marketplace broadcast at create", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/bookingSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, 'scheduledStatus = "admin_held"');
  assertStringIncludes(src, "scheduledBroadcastAt = null");
  assert(!/scheduledBroadcastAt = anchors\.scheduledBroadcastAt/.test(src));
});
