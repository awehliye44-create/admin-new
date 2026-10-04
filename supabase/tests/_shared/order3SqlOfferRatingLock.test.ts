/**
 * Order 3 lock: database-dispatched offers carry the same aggregate customer
 * rating as Edge auto-dispatch, so the Driver offer card can show "★ 4.9" /
 * "New customer" on first-round offers too.
 *
 * First-round offers come from dispatch_trip_offers (trip-insert trigger), which
 * never stamped passenger_rating / passenger_rating_count.
 */
import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mapPassengerOfferRating,
  UNKNOWN_PASSENGER_OFFER_RATING,
} from "../../functions/_shared/passengerOfferRating.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

const mig = await read("../../migrations/20261210140000_ride_offer_passenger_rating_snapshot.sql");

const code = mig
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

function fnBody(name: string): string {
  const re = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\([^)]*\\)[\\s\\S]*?AS\\s+(\\$[A-Za-z_]*\\$)([\\s\\S]*?)\\1`,
    "i",
  );
  const m = code.match(re);
  assert(m, `${name} not defined`);
  return m[2];
}

const helper = fnBody("passenger_offer_rating");
const trigger = fnBody("tr_stamp_offer_passenger_rating_fn");

Deno.test("every ride_offers insert passes through the rating stamp (BEFORE INSERT, row level)", () => {
  assertMatch(
    code,
    /CREATE\s+TRIGGER\s+tr_stamp_offer_passenger_rating\s+BEFORE\s+INSERT\s+ON\s+public\.ride_offers\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\s+public\.tr_stamp_offer_passenger_rating_fn\(\)/i,
  );
});

Deno.test("same source as auto-dispatch: get_customer_trip_stats keyed by trips.passenger_id", () => {
  assertMatch(helper, /FROM\s+public\.get_customer_trip_stats\(p_passenger_id\)/i);
  assertMatch(trigger, /SELECT\s+t\.passenger_id\s+INTO\s+v_passenger_id\s+FROM\s+public\.trips\s+t\s+WHERE\s+t\.id\s*=\s*NEW\.trip_id/i);
  assertMatch(trigger, /public\.passenger_offer_rating\(v_passenger_id\)/);
});

Deno.test("same shape as mapPassengerOfferRating: rated / New customer / unknown", () => {
  assertMatch(helper, /IF\s+p_passenger_id\s+IS\s+NULL\s+THEN\s+RETURN\s+v_unknown/i);
  assertMatch(helper, /IF\s+v_count\s+IS\s+NULL\s+THEN\s+RETURN\s+v_unknown/i);
  assertMatch(
    helper,
    /IF\s+v_count\s*<=\s*0\s+THEN\s+RETURN\s+jsonb_build_object\('passenger_rating',\s*NULL,\s*'passenger_rating_count',\s*0\)/i,
  );
  assertMatch(helper, /v_avg\s+IS\s+NULL\s+OR\s+v_avg\s*<\s*1\s+OR\s+v_avg\s*>\s*5\s+THEN\s+RETURN\s+v_unknown/i);
  assertMatch(helper, /'passenger_rating',\s*round\(v_avg,\s*2\)::double precision/i);
  assertMatch(helper, /'passenger_rating_count',\s*v_count\)/i);

  assertEquals(mapPassengerOfferRating({ avg_rating: 4.67, rating_count: 3 }), {
    passenger_rating: 4.67,
    passenger_rating_count: 3,
  });
  assertEquals(mapPassengerOfferRating({ avg_rating: null, rating_count: 0 }), {
    passenger_rating: null,
    passenger_rating_count: 0,
  });
  assertEquals(mapPassengerOfferRating(null), UNKNOWN_PASSENGER_OFFER_RATING);
});

Deno.test("an offer already stamped (Edge auto-dispatch) is never overwritten", () => {
  assertMatch(
    trigger,
    /IF\s+COALESCE\(NEW\.offer_snapshot,\s*'\{\}'::jsonb\)\s*\?\s*'passenger_rating_count'\s+THEN\s+RETURN\s+NEW/i,
  );
  assertMatch(trigger, /NEW\.offer_snapshot\s*:=\s*COALESCE\(NEW\.offer_snapshot,\s*'\{\}'::jsonb\)\s*\|\|\s*v_rating/i);
});

Deno.test("fails soft: a rating failure never blocks or drops an offer", () => {
  assertMatch(helper, /EXCEPTION\s+WHEN\s+OTHERS\s+THEN[\s\S]*RETURN\s+v_unknown/i);
  assertMatch(trigger, /EXCEPTION\s+WHEN\s+OTHERS\s+THEN[\s\S]*'passenger_rating_count',\s*NULL\)/i);
  assert(!/RETURN\s+NULL/i.test(trigger), "rating stamp must never skip the insert");
  assert(!/RAISE\s+EXCEPTION/i.test(trigger + helper));
});

Deno.test("aggregate only: no customer identity in the offer payload", () => {
  for (const field of ["passenger_name", "passenger_phone", "phone", "email", "plate", "full_name", "first_name"]) {
    assert(!new RegExp(`\\b${field}\\b`, "i").test(helper + trigger), `must not read ${field}`);
  }
});

Deno.test("helper is service_role only", () => {
  assertMatch(code, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.passenger_offer_rating\(uuid\)\s+FROM\s+PUBLIC/i);
  assertMatch(code, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.passenger_offer_rating\(uuid\)\s+FROM\s+anon,\s*authenticated/i);
  assertMatch(code, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.passenger_offer_rating\(uuid\)\s+TO\s+service_role/i);
});

Deno.test("scope: no dispatcher, wave, TTL, radius, pricing, payment or eligibility change", () => {
  assert(!/FUNCTION\s+public\.dispatch_trip_offers/i.test(code));
  assert(!/FUNCTION\s+public\.tr_block_ineligible_ride_offer/i.test(code));
  assert(!/FUNCTION\s+public\.tr_stamp_offer_presets_fn/i.test(code));
  for (const token of [
    "expires_at", "radius", "dispatch_wave", "broadcast_round", "fare", "pence",
    "commission", "payment", "vehicle_type", "global_dispatch_settings", "economy",
  ]) {
    assert(!new RegExp(token, "i").test(code), `rating migration must not touch ${token}`);
  }
  assert(!/\bUPDATE\s+public\./i.test(code), "no row updates");
});
