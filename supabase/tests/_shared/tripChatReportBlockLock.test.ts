/**
 * Lock: in-trip chat Report message + Block user (App Review Guideline 1.2).
 *
 * Reports land in the existing admin Complaints queue; a block in either
 * direction stops chat between the pair and stops future offers matching
 * them. Callers are resolved from auth.uid(); no payment/fare/wallet state.
 */
import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

const mig = await Deno.readTextFile(
  new URL("../../migrations/20261212120000_trip_chat_report_and_block.sql", import.meta.url),
);
const code = mig
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

const DEFINERS = [
  "customer_driver_pair_blocked",
  "trip_chat_participant",
  "block_trip_counterparty",
  "report_trip_chat_message",
  "tr_trip_messages_reject_blocked_pair",
  "tr_block_ineligible_ride_offer",
];

Deno.test("no BEGIN/COMMIT; every function is SECURITY DEFINER with pinned search_path", () => {
  assert(!/^\s*BEGIN\s*;/im.test(code));
  assert(!/^\s*COMMIT\s*;/im.test(code));
  for (const fn of DEFINERS) {
    const re = new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]*?SECURITY DEFINER\\s+SET search_path TO 'public'`,
    );
    assertMatch(code, re, fn);
  }
});

Deno.test("blocks table: unique per direction, RLS on, clients read-only", () => {
  assertMatch(code, /CREATE TABLE IF NOT EXISTS public\.customer_driver_blocks/);
  assertMatch(code, /blocked_by text NOT NULL CHECK \(blocked_by IN \('customer', 'driver'\)\)/);
  assertMatch(code, /UNIQUE \(customer_id, driver_id, blocked_by\)/);
  assertMatch(code, /ALTER TABLE public\.customer_driver_blocks ENABLE ROW LEVEL SECURITY;/);
  assertMatch(code, /GRANT SELECT ON public\.customer_driver_blocks TO authenticated;/);
  assert(!/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*customer_driver_blocks/i.test(code));
});

Deno.test("caller identity comes from auth.uid(), never from client-passed ids", () => {
  assertMatch(code, /v_uid uuid := auth\.uid\(\)/);
  assertMatch(code, /RAISE EXCEPTION 'NOT_AUTHENTICATED'/);
  assertMatch(code, /RAISE EXCEPTION 'NOT_TRIP_PARTICIPANT'/);
  assertMatch(code, /FUNCTION public\.block_trip_counterparty\(p_trip_id uuid\)/);
  assertMatch(
    code,
    /FUNCTION public\.report_trip_chat_message\(\s*p_trip_id uuid,\s*p_message_id uuid,\s*p_reason text,\s*p_details text DEFAULT NULL\s*\)/,
  );
});

Deno.test("report: whitelisted reasons, other party's message only, deduped and rate limited", () => {
  assertMatch(code, /v_reason NOT IN \('harassment', 'offensive', 'spam', 'safety', 'other'\)/);
  assertMatch(code, /RAISE EXCEPTION 'MESSAGE_NOT_FOUND'/);
  assertMatch(code, /RAISE EXCEPTION 'CANNOT_REPORT_OWN_MESSAGE'/);
  assertMatch(code, /'duplicate', true/);
  assertMatch(code, /RAISE EXCEPTION 'REPORT_RATE_LIMITED'/);
});

Deno.test("report lands in the admin Complaints queue as new, safety is urgent", () => {
  assertMatch(code, /INSERT INTO public\.complaints \(/);
  assertMatch(code, /'In-trip chat'/);
  assertMatch(code, /CASE WHEN v_reason = 'safety' THEN 'urgent' ELSE 'high' END/);
  assertMatch(code, /'new'/);
});

Deno.test("block enforcement: chat insert rejected and blocked pair skipped from offers", () => {
  assertMatch(code, /RAISE EXCEPTION 'CHAT_BLOCKED' USING ERRCODE = 'P0001'/);
  assertMatch(
    code,
    /CREATE TRIGGER tr_trip_messages_reject_blocked_pair\s+BEFORE INSERT ON public\.trip_messages/,
  );
  assertMatch(code, /IF public\.customer_driver_pair_blocked\(v_passenger_id, NEW\.driver_id\) THEN/);
  assertMatch(code, /'offer_blocked_user_block',\s*'customer_driver_blocked'/);
  const offerFn = code.slice(code.indexOf("FUNCTION public.tr_block_ineligible_ride_offer()"));
  assertEquals((offerFn.match(/RETURN NULL;/g) ?? []).length, 3);
  assertMatch(offerFn, /accept_ride_offer_eligibility_guard\(NEW\.driver_id\)/);
  assertMatch(offerFn, /driver_vehicle_category_reject_reason\(NEW\.driver_id, NEW\.trip_id\)/);
});

Deno.test("grants: only the two user actions are callable, by authenticated only", () => {
  assertMatch(code, /GRANT EXECUTE ON FUNCTION public\.block_trip_counterparty\(uuid\) TO authenticated;/);
  assertMatch(
    code,
    /GRANT EXECUTE ON FUNCTION public\.report_trip_chat_message\(uuid, uuid, text, text\) TO authenticated;/,
  );
  assertEquals((code.match(/GRANT EXECUTE/g) ?? []).length, 2);
  assertMatch(code, /REVOKE ALL ON FUNCTION public\.customer_driver_pair_blocked\(uuid, uuid\) FROM PUBLIC, anon, authenticated;/);
  assertMatch(code, /REVOKE ALL ON FUNCTION public\.trip_chat_participant\(uuid\) FROM PUBLIC, anon, authenticated;/);
});

Deno.test("no payment, fare, wallet or dispatch-state mutation", () => {
  for (const forbidden of [
    /UPDATE\s+public\./i,
    /DELETE\s+FROM/i,
    /INSERT\s+INTO\s+public\.(?!customer_driver_blocks|complaints)/i,
    /payment|fare|commission|wallet|payout/i,
  ]) {
    assert(!forbidden.test(code), `forbidden token ${forbidden}`);
  }
});
