/**
 * CTAP existence-first: return an already-finalized trip before gates / Revolut GET,
 * only to the passenger who owns it.
 * Run: deno test --allow-read supabase/tests/_shared/ctapExistenceFirstSSOT.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isTripOwnedByCaller,
  lookupCallerOwnedBookingTrip,
  pickCallerOwnedBookingTrip,
} from "../../functions/_shared/ctapExistenceFirstSSOT.ts";
import { createFakeSupabase } from "./fakeSupabaseForBookingFinalize.ts";

const ME = "cust-me";
const OTHER = "cust-other";
const USER = "user-me";

const trip = (over: Record<string, unknown> = {}) => ({
  id: "trip-1",
  trip_code: "MK-1",
  status: "searching",
  passenger_id: ME,
  client_action_id: "cai-1",
  provider_order_id: "ord-1",
  ...over,
});

Deno.test("ownership is trips.passenger_id ∈ caller customers", () => {
  assert(isTripOwnedByCaller({ passenger_id: ME }, [ME]));
  assert(!isTripOwnedByCaller({ passenger_id: OTHER }, [ME]));
  assert(!isTripOwnedByCaller({ passenger_id: null }, [ME]));
  assert(!isTripOwnedByCaller({ passenger_id: ME }, []));
});

Deno.test("pick: owned by client_action_id or provider order; foreign never exposes the trip", () => {
  assertEquals(pickCallerOwnedBookingTrip({ byClientAction: trip(), byProviderOrder: null, callerCustomerIds: [ME] }).kind, "owned");
  const byOrder = pickCallerOwnedBookingTrip({ byClientAction: null, byProviderOrder: trip(), callerCustomerIds: [ME] });
  assert(byOrder.kind === "owned" && byOrder.by === "provider_order_id");
  const foreign = pickCallerOwnedBookingTrip({
    byClientAction: trip({ passenger_id: OTHER }),
    byProviderOrder: null,
    callerCustomerIds: [ME],
  });
  assertEquals(foreign.kind, "foreign");
  assertEquals(Object.keys(foreign).sort(), ["by", "kind", "tripId"]);
  assertEquals(pickCallerOwnedBookingTrip({ byClientAction: null, byProviderOrder: null, callerCustomerIds: [ME] }).kind, "none");
});

Deno.test("lookup: lost client response → caller gets own trip; another customer does not", async () => {
  const fake = createFakeSupabase({
    tables: {
      customers: [{ id: ME, user_id: USER }, { id: OTHER, user_id: "user-other" }],
      trips: [trip()],
    },
  });
  const mine = await lookupCallerOwnedBookingTrip(fake.client, { userId: USER, clientActionId: "cai-1", providerOrderId: "ord-1" });
  assert(mine.kind === "owned" && mine.trip.id === "trip-1");
  const theirs = await lookupCallerOwnedBookingTrip(fake.client, { userId: "user-other", clientActionId: "cai-1", providerOrderId: "ord-1" });
  assertEquals(theirs.kind, "foreign");
  const none = await lookupCallerOwnedBookingTrip(fake.client, { userId: USER, clientActionId: "cai-2", providerOrderId: "ord-2" });
  assertEquals(none.kind, "none");
});

Deno.test("source lock: CTAP runs existence-first before booking gates and never selects trips.customer_id", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/create-trip-after-payment/index.ts", import.meta.url));
  const lookup = src.indexOf("lookupCallerOwnedBookingTrip(supabase");
  const gate = src.indexOf("assertCanBookRide(supabase, user.id)");
  const verify = src.indexOf("verifyRevolutHoldForTripCreateFast(supabase, {");
  assert(lookup > 0 && lookup < gate && lookup < verify, "existence-first must precede gates and provider GET");
  assert(src.includes('existing.kind === "owned"'));
  assert(!/select\("[^"]*\bcustomer_id\b[^"]*"\)\s*\n\s*\.eq\("(client_action_id|provider_order_id)"/.test(src));
  assert(src.includes('idempotentPick.kind === "owned"'), "post-gate short-circuit is ownership-gated");
});
