/**
 * Trip cancellation reaches only the driver who had the trip.
 *
 * notify_offer_drivers_on_trip_terminal must push only to offers it revokes
 * (still pending/countered at trip terminal), never cancellation-flavoured.
 * Declined/expired offer holders get nothing — a declining driver once saw
 * Trip Cancelled for trip ccf3c09f… that was never theirs.
 * Run: deno test --allow-read supabase/tests/_shared/tripTerminalOfferStopOnlyLiveOffersLock.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  new URL("../../migrations/20261215120000_offer_stop_push_only_live_offers.sql", import.meta.url),
);
const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.notify_offer_drivers_on_trip_terminal()"));

Deno.test("push loop iterates only the offers this trigger revokes", () => {
  assert(/FOR v_row IN\s+UPDATE public\.ride_offers ro/.test(body));
  assert(body.includes("AND ro.status IN ('pending', 'countered')\n    RETURNING ro.id AS offer_id, ro.driver_id"));
  assertEquals(body.includes("SELECT DISTINCT ro.driver_id"), false);
  assertEquals(/FROM public\.ride_offers ro\s+WHERE ro\.trip_id = NEW\.id\s+AND ro\.driver_id IS NOT NULL/.test(body), false);
});

Deno.test("assigned driver is excluded — cancellation stays on the assigned-driver path", () => {
  assert(body.includes("NEW.driver_id, NEW.confirmed_driver_id, OLD.driver_id, OLD.confirmed_driver_id"));
  assert(body.includes("v_row.driver_id IS NOT DISTINCT FROM v_assigned_driver_id"));
});

Deno.test("offer-holder push is never cancellation-flavoured", () => {
  assert(body.includes("WHEN v_stop_reason = 'customer_cancelled' THEN 'revoked'"));
  assert(body.includes("'stopReason', v_offer_stop_reason"));
  assert(body.includes("'stop_reason', v_offer_stop_reason"));
  assertEquals(body.includes("'stopReason', v_stop_reason"), false);
  assertEquals(body.includes("'trip_status'"), false);
  assertEquals(body.includes("The customer cancelled this ride"), false);
  assertEquals(/'event',\s*'trip_cancelled'/.test(body), false);
});
