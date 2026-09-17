/**
 * MK-260916-038: get-active-trip / restore must not treat pre-STEP-2 scheduled
 * rows as the current live broadcasting trip.
 *
 * Run: deno test --allow-read supabase/tests/_shared/scheduledGetActiveTripSSOT.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateCustomerAssistantBusyFromRows,
  isCustomerAssistantBusy,
} from "../../functions/onecab-assistant/customerBusyGate.ts";

const GET_ACTIVE = new URL(
  "../../functions/get-active-trip/index.ts",
  import.meta.url,
);
const RESTORE = new URL(
  "../../functions/_shared/activeTripRestoreCore.ts",
  import.meta.url,
);
const CREATE_RIDE = new URL(
  "../../functions/create-ride/index.ts",
  import.meta.url,
);
const POST_COMMIT = new URL(
  "../../functions/_shared/bookingPostCommit.ts",
  import.meta.url,
);

Deno.test("get-active-trip future unassigned scheduled is not a live trip", async () => {
  const src = await Deno.readTextFile(GET_ACTIVE);
  assertStringIncludes(src, "function isCustomerLiveTrip");
  assertStringIncludes(src, "isScheduledUnassignedMarketplaceLive");
  const fn = src.slice(
    src.indexOf("function isCustomerLiveTrip"),
    src.indexOf("serveWithEdgeTiming(\"get-active-trip\""),
  );
  assert(
    fn.includes("hasDriver &&") && fn.includes("SCHEDULED_LIVE_STATES.includes(status)"),
    "assigned scheduled live trip still requires a driver plus a live status",
  );
  assert(
    fn.includes("scheduledDispatchWindowReached(row, nowMs)"),
    "assigned scheduled live trip still respects the canonical activation window",
  );
  assert(
    fn.includes("isScheduledHandoverOpenJobStatus(status)") &&
      fn.includes("isScheduledUnassignedMarketplaceLive"),
    "scheduled open-job search must still require STEP 2 marketplace live",
  );
});

Deno.test("restore does not hydrate honest scheduled_status=scheduled as live", async () => {
  const src = await Deno.readTextFile(RESTORE);
  assertStringIncludes(src, "isScheduledUnassignedMarketplaceLive");
  assertEquals(
    src.includes("scheduledDispatchWindowReached"),
    false,
    "unassigned scheduled must not restore from the timestamp window alone",
  );
  assert(
    src.includes("converted_to_instant"),
    "converted scheduled→instant must still restore as live",
  );
  assert(
    src.includes('if (hasDriver) return true'),
    "reserved/assigned scheduled may restore",
  );
});

Deno.test("Customer Assistant busy gate matches restore marketplace live", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/onecab-assistant/customerBusyGate.ts", import.meta.url),
  );
  assertStringIncludes(src, "isScheduledUnassignedMarketplaceLive");
  assertEquals(
    src.includes("scheduledDispatchWindowReached"),
    false,
    "Assistant must not treat broadcast_at alone as a live trip",
  );
});

Deno.test("scheduled booking must not stamp customers.active_trip_id", async () => {
  const createRide = await Deno.readTextFile(CREATE_RIDE);
  const postCommit = await Deno.readTextFile(POST_COMMIT);
  assertStringIncludes(createRide, "if (customerId && !isScheduled)");
  assertStringIncludes(postCommit, "if (!ctx.isScheduled)");
  assertStringIncludes(postCommit, "active_trip_id: ctx.tripId");
});

Deno.test("Customer Assistant is not busy for honest scheduled at broadcast_at", () => {
  const nowMs = Date.parse("2026-09-17T11:37:00.000Z");
  const busy = isCustomerAssistantBusy(
    evaluateCustomerAssistantBusyFromRows({
      trips: [
        {
          status: "scheduled",
          is_scheduled: true,
          dispatch_mode: "scheduled",
          scheduled_status: "scheduled",
          scheduled_at: "2026-09-17T12:00:00.000Z",
          scheduled_broadcast_at: "2026-09-17T11:37:00.000Z",
        },
      ],
      pendingRating: false,
      nowMs,
    }),
  );
  if (busy) throw new Error("pre-STEP-2 scheduled must not block Help & Support");
});

Deno.test("Customer Assistant is busy after STEP 2 marketplace open", () => {
  const nowMs = Date.parse("2026-09-17T11:37:00.000Z");
  const busy = isCustomerAssistantBusy(
    evaluateCustomerAssistantBusyFromRows({
      trips: [
        {
          status: "offered",
          is_scheduled: true,
          dispatch_mode: "scheduled",
          scheduled_status: "broadcasting",
          scheduled_at: "2026-09-17T12:00:00.000Z",
          scheduled_broadcast_at: "2026-09-17T11:37:00.000Z",
        },
      ],
      pendingRating: false,
      nowMs,
    }),
  );
  if (!busy) throw new Error("STEP 2 broadcasting must block Help while Finding Driver");
});
