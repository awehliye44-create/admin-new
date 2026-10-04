/**
 * Lock: Driver ride-offer alert proof log RPC.
 *
 * The phone reports what it did with an offer push (shown / full screen /
 * suppressed / stopped) into booking_delivery_log beside the server phases.
 * It must stay logging-only, owner-scoped, whitelisted and bounded.
 */
import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

const mig = await Deno.readTextFile(
  new URL("../../migrations/20261211120000_record_offer_alert_event.sql", import.meta.url),
);
const code = mig
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

Deno.test("is SECURITY DEFINER with a pinned search_path and no BEGIN/COMMIT", () => {
  assertMatch(code, /FUNCTION public\.record_offer_alert_event\(\s*p_offer_id uuid,\s*p_phase text,\s*p_detail jsonb/);
  assertMatch(code, /SECURITY DEFINER\s+SET search_path TO 'public'/);
  assert(!/^\s*BEGIN\s*;/im.test(code));
  assert(!/^\s*COMMIT\s*;/im.test(code));
});

Deno.test("whitelists exactly the four device phases and prefixes them", () => {
  assertMatch(
    code,
    /p_phase NOT IN \('push_received', 'alert_shown', 'alert_suppressed', 'alert_stopped'\)/,
  );
  assertMatch(code, /v_phase := 'device_' \|\| p_phase;/);
});

Deno.test("caller must be the driver who owns the offer", () => {
  assertMatch(code, /v_uid uuid := auth\.uid\(\)/);
  assertMatch(code, /FROM public\.drivers WHERE user_id = v_uid/);
  assertMatch(code, /WHERE id = p_offer_id AND driver_id = v_driver_id/);
});

Deno.test("is bounded per offer and caps detail size", () => {
  assertMatch(code, /IF v_count >= 40 THEN/);
  assertMatch(code, /length\(p_detail::text\) <= 2048/);
});

Deno.test("writes only through record_booking_delivery — no business-state mutation", () => {
  assertMatch(code, /PERFORM public\.record_booking_delivery\(/);
  for (const forbidden of [
    /UPDATE\s+public\./i,
    /DELETE\s+FROM/i,
    /INSERT\s+INTO\s+public\.(?!booking_delivery_log)/i,
    /payment|fare|commission|wallet|dispatch_trip_offers/i,
  ]) {
    assert(!forbidden.test(code), `forbidden token ${forbidden}`);
  }
});

Deno.test("grants: authenticated + service_role only", () => {
  assertMatch(code, /REVOKE ALL ON FUNCTION public\.record_offer_alert_event\(uuid, text, jsonb\) FROM PUBLIC;/);
  assertMatch(code, /REVOKE ALL ON FUNCTION public\.record_offer_alert_event\(uuid, text, jsonb\) FROM anon;/);
  assertMatch(code, /GRANT EXECUTE ON FUNCTION public\.record_offer_alert_event\(uuid, text, jsonb\) TO authenticated;/);
  assertEquals((code.match(/GRANT EXECUTE/g) ?? []).length, 2);
});
