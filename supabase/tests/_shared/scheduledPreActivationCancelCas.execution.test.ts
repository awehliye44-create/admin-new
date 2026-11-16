/**
 * Bug #22 — concurrent pre-activation cancel CAS (in-memory row CAS).
 * Mirrors SQL release_scheduled_assignment_for_driver_cancel predicates.
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemorySupabase } from "./support/inMemorySupabaseFake.ts";
import {
  buildScheduledMarketplaceRematchPatch,
  buildScheduledUrgentRematchPatch,
} from "../../functions/_shared/scheduledPreActivationReleaseSSOT.ts";

const TRIP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DRIVER_A = "11111111-1111-1111-1111-111111111111";
const DRIVER_B = "22222222-2222-2222-2222-222222222222";

function confirmedTrip(extra: Record<string, unknown> = {}) {
  return {
    id: TRIP_ID,
    is_scheduled: true,
    status: "scheduled",
    scheduled_status: "driver_assigned",
    dispatch_mode: "scheduled",
    confirmed_driver_id: DRIVER_A,
    driver_id: null,
    started_at: null,
    scheduled_at: "2099-11-15T18:00:00.000Z",
    scheduled_broadcast_at: "2026-11-15T10:00:00.000Z",
    broadcast_enabled: true,
    final_fare_pence: 1200,
    ...extra,
  };
}

async function preActivationCancelCas(
  sb: ReturnType<typeof createInMemorySupabase>,
  driverId: string,
  urgent: boolean,
) {
  const patch = urgent
    ? buildScheduledUrgentRematchPatch({
      nowIso: "2026-11-15T12:00:00.000Z",
      searchingExpiresAtIso: "2026-11-15T12:06:00.000Z",
      currentBroadcastEnabled: true,
    })
    : buildScheduledMarketplaceRematchPatch({
      nowIso: "2026-11-15T12:00:00.000Z",
      broadcastAtIso: "2026-11-15T10:00:00.000Z",
      broadcastEnabled: true,
      cancellationReason: "cannot_make_it",
    });
  return await sb
    .from("trips")
    .update({ ...patch, cancellation_reason: "cannot_make_it" })
    .eq("id", TRIP_ID)
    .eq("confirmed_driver_id", driverId)
    .is("driver_id", null)
    .is("started_at", null)
    .select("id")
    .maybeSingle();
}

async function jitActivateCas(
  sb: ReturnType<typeof createInMemorySupabase>,
  driverId: string,
) {
  return await sb
    .from("trips")
    .update({
      driver_id: driverId,
      status: "en_route_to_pickup",
      scheduled_status: "driver_en_route",
    })
    .eq("id", TRIP_ID)
    .eq("confirmed_driver_id", driverId)
    .is("driver_id", null)
    .is("started_at", null)
    .select("id")
    .maybeSingle();
}

async function replacementConfirmCas(
  sb: ReturnType<typeof createInMemorySupabase>,
  driverId: string,
) {
  return await sb
    .from("trips")
    .update({
      confirmed_driver_id: driverId,
      scheduled_status: "driver_assigned",
      status: "scheduled",
    })
    .eq("id", TRIP_ID)
    .is("confirmed_driver_id", null)
    .is("driver_id", null)
    .select("id")
    .maybeSingle();
}

Deno.test("CAS: cancel wins vs concurrent JIT activate — activate misses", async () => {
  const sb = createInMemorySupabase({ trips: [confirmedTrip()] });
  const [c, a] = await Promise.all([
    preActivationCancelCas(sb, DRIVER_A, false),
    jitActivateCas(sb, DRIVER_A),
  ]);
  const cancelHit = c.data != null;
  const activateHit = a.data != null;
  assertEquals(cancelHit !== activateHit, true);
  if (cancelHit) {
    assertEquals(sb.db.trips[0].confirmed_driver_id, null);
    assertEquals(sb.db.trips[0].driver_id, null);
    assertEquals(sb.db.trips[0].status, "scheduled");
    assertEquals(sb.db.trips[0].final_fare_pence, 1200);
  } else {
    assertEquals(sb.db.trips[0].driver_id, DRIVER_A);
    assertEquals(sb.db.trips[0].status, "en_route_to_pickup");
  }
});

Deno.test("CAS: JIT activate wins — stale cancel misses (ACTIVATED path)", async () => {
  const sb = createInMemorySupabase({ trips: [confirmedTrip()] });
  const act = await jitActivateCas(sb, DRIVER_A);
  assert(act.data != null);
  const cancel = await preActivationCancelCas(sb, DRIVER_A, false);
  assertEquals(cancel.data, null);
  assertEquals(sb.db.trips[0].driver_id, DRIVER_A);
  assertEquals(sb.db.trips[0].status, "en_route_to_pickup");
  assertEquals(sb.db.trips[0].final_fare_pence, 1200);
});

Deno.test("CAS: cancel then replacement confirm — B can take Requested booking", async () => {
  const sb = createInMemorySupabase({ trips: [confirmedTrip()] });
  const cancel = await preActivationCancelCas(sb, DRIVER_A, false);
  assert(cancel.data != null);
  assertEquals(sb.db.trips[0].status, "scheduled");
  const claim = await replacementConfirmCas(sb, DRIVER_B);
  assert(claim.data != null);
  assertEquals(sb.db.trips[0].confirmed_driver_id, DRIVER_B);
});

Deno.test("CAS: double cancel — single winner", async () => {
  const sb = createInMemorySupabase({ trips: [confirmedTrip()] });
  const [x, y] = await Promise.all([
    preActivationCancelCas(sb, DRIVER_A, false),
    preActivationCancelCas(sb, DRIVER_A, false),
  ]);
  const hits = [x, y].filter((r) => r.data != null);
  assertEquals(hits.length, 1);
});

Deno.test("CAS: urgent cancel stamps convert shape without touching fare", async () => {
  const sb = createInMemorySupabase({ trips: [confirmedTrip()] });
  const cancel = await preActivationCancelCas(sb, DRIVER_A, true);
  assert(cancel.data != null);
  assertEquals(sb.db.trips[0].dispatch_mode, "instant");
  assertEquals(sb.db.trips[0].scheduled_status, "converted_to_instant");
  assertEquals(sb.db.trips[0].status, "searching");
  assertEquals(sb.db.trips[0].final_fare_pence, 1200);
  assertEquals(sb.db.trips[0].scheduled_at, "2099-11-15T18:00:00.000Z");
});

Deno.test("CAS: wrong driver cancel misses", async () => {
  const sb = createInMemorySupabase({ trips: [confirmedTrip()] });
  const cancel = await preActivationCancelCas(sb, DRIVER_B, false);
  assertEquals(cancel.data, null);
  assertEquals(sb.db.trips[0].confirmed_driver_id, DRIVER_A);
});
