/**
 * Order 3 lock (SQL side): every database offer writer enforces the booked
 * vehicle category and the Pet-Friendly toggle, matching Edge auto-dispatch.
 *
 * MK-261004-002…005: dispatch_trip_offers (trip-insert trigger) offered
 * Comfort/Premium trips to drivers with no such assignment.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

const gate = await read("../../migrations/20261210130000_dispatch_vehicle_category_gate.sql");
const liveText = await read(
  "../../migrations/20261203120000_dispatch_online_gate_intent_or_is_online_mk260926004.sql",
);
const liveOverloads = await read(
  "../../migrations/20261028270000_dispatch_location_frozen_degraded_mk260904003.sql",
);

type Kind = "text" | "bool" | "uuid";

function dispatcherBodies(sql: string): Map<Kind, string> {
  const re =
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.dispatch_trip_offers\s*\(([^)]*)\)[\s\S]*?AS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\2/gi;
  const out = new Map<Kind, string>();
  for (const m of sql.matchAll(re)) {
    const args = m[1];
    const kind: Kind = args.includes("p_trigger_reason")
      ? "text"
      : args.includes("p_internal")
        ? "bool"
        : "uuid";
    out.set(kind, m[3]);
  }
  return out;
}

const GATE_CALL = "public.driver_vehicle_category_reject_reason(d.id, p_trip_id)";

function stripGate(body: string): string {
  return body
    .replace(
      "           at.started_at AS active_started_at,\n           -- Order 3: booked category / Pet-Friendly toggle (parity with Edge auto-dispatch).\n           public.driver_vehicle_category_reject_reason(d.id, p_trip_id) AS vehicle_category_reject\n",
      "           at.started_at AS active_started_at\n",
    )
    .replace("      WHEN f.vehicle_category_reject IS NOT NULL THEN f.vehicle_category_reject\n", "")
    .replace(`      AND ${GATE_CALL} IS NULL\n`, "")
    .replace(`    AND ${GATE_CALL} IS NULL\n`, "");
}

Deno.test("gate SSOT: default open, others need enabled assignment, Pet-Friendly also needs the toggle", () => {
  assert(gate.includes("CREATE OR REPLACE FUNCTION public.driver_vehicle_category_reject_reason("));
  for (const reason of [
    "'default_vehicle_category_disabled'",
    "'missing_required_vehicle_category'",
    "'pet_friendly_toggle_off'",
    "'unknown_vehicle_category'",
  ]) {
    assert(gate.includes(reason), reason);
  }
  assert(gate.includes("dvc.is_enabled = true"));
  assert(gate.includes("dvc.is_enabled = false"));
  assert(gate.includes("d.is_pet_friendly"));
  assert(gate.includes("driver_controllable"));
  // Legacy rows: slug from the old text column, else the catalog default row.
  assert(gate.includes("WHERE vt.slug = NULLIF(btrim(t.vehicle_type), '')"));
  assert(gate.includes("WHERE vt.is_default LIMIT 1"));
  assert(!/\bvt\.name\b|'ONECAB GO'/.test(gate), "category identity must come from ids/flags, never names");
  assert(!/economy/i.test(gate), "ONECAB GO is identified by vehicle_types.is_default, never the 'economy' slug");
});

Deno.test("gate helper is not callable by app users", () => {
  assert(gate.includes(
    "REVOKE ALL ON FUNCTION public.driver_vehicle_category_reject_reason(uuid, uuid) FROM anon, authenticated;",
  ));
  assert(!/GRANT[^;]*driver_vehicle_category_reject_reason[^;]*TO[^;]*(anon|authenticated|PUBLIC)/i.test(gate));
});

Deno.test("all three dispatch_trip_offers overloads apply the gate", () => {
  const bodies = dispatcherBodies(gate);
  assertEquals([...bodies.keys()].sort(), ["bool", "text", "uuid"]);
  for (const [kind, body] of bodies) assert(body.includes(GATE_CALL), kind);
  const text = bodies.get("text")!;
  assert(text.includes("AS vehicle_category_reject"));
  assert(/CASE\s+WHEN f\.vehicle_category_reject IS NOT NULL THEN f\.vehicle_category_reject\s+WHEN f\.distance_m > v_radius/.test(text));
});

Deno.test("dispatcher bodies are the live definitions with only the gate added", () => {
  const patched = dispatcherBodies(gate);
  const live = new Map<Kind, string>([
    ["text", dispatcherBodies(liveText).get("text")!],
    ["bool", dispatcherBodies(liveOverloads).get("bool")!],
    ["uuid", dispatcherBodies(liveOverloads).get("uuid")!],
  ]);
  for (const kind of ["text", "bool", "uuid"] as Kind[]) {
    assertEquals(stripGate(patched.get(kind)!), live.get(kind)!, kind);
  }
});

Deno.test("ride_offers insert guard blocks out-of-category offers from any writer", () => {
  const guard = gate.slice(gate.indexOf("FUNCTION public.tr_block_ineligible_ride_offer()"));
  assert(guard.includes("public.accept_ride_offer_eligibility_guard(NEW.driver_id)"));
  assert(guard.includes("public.driver_vehicle_category_reject_reason(NEW.driver_id, NEW.trip_id)"));
  assert(guard.includes("'offer_blocked_vehicle_category'"));
  assert(/IF v_category_reject IS NOT NULL THEN[\s\S]*?RETURN NULL;/.test(guard));
});

Deno.test("drivers can no longer edit their own category assignments", () => {
  assert(gate.includes('DROP POLICY IF EXISTS "Drivers can update their own vehicle categories"'));
  assert(!/CREATE POLICY[^;]*driver_vehicle_categories[^;]*FOR UPDATE/i.test(gate));
});
