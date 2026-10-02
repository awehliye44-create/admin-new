/**
 * Integration: an Admin save of a booking dispatch wave radius persists through
 * production RLS and changes the radius BOTH dispatch paths use.
 *
 * Needs the disposable cluster from scripts/run-booking-dispatch-radius-isolated.sh
 * (real dispatch_trip_offers(uuid, text) + migration 20261204140000). Skipped otherwise.
 *
 *   SQL path  — real dispatch_trip_offers(uuid, text) (trip-insert Wave 1, emergency path)
 *   Edge path — real loadDispatchSettings + effectiveRadiusMeters (auto-dispatch Waves 2+)
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BookingDispatchRadiusConfigError,
  destinationMatchRadiusMeters,
  effectiveRadiusMeters,
  loadDispatchSettings,
} from "../../functions/_shared/dispatch-settings.ts";

const PGHOST = Deno.env.get("BOOKING_RADIUS_PGHOST");
const PGPORT = Deno.env.get("BOOKING_RADIUS_PGPORT");
const PG_BIN = Deno.env.get("PG_BIN") ?? "/opt/homebrew/opt/postgresql@17/bin";
const ADMIN_ID = "00000000-0000-4000-8000-0000000000ad";
const DRIVER_ID = "00000000-0000-4000-8000-0000000000d1";

async function psql(sql: string): Promise<string> {
  const out = await new Deno.Command(`${PG_BIN}/psql`, {
    args: ["-h", PGHOST!, "-p", PGPORT!, "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-X", "-q", "-At", "-c", sql],
  }).output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim());
  return stdout;
}

/** Same statement shape as the Admin page: update(...).eq('singleton', true).select(...). */
async function adminSave(
  userId: string,
  set: Record<string, number>,
): Promise<Record<string, number> | null> {
  const assignments = Object.entries(set).map(([k, v]) => `${k} = ${v}`).join(", ");
  const out = await psql(`
    SET ROLE authenticated;
    SELECT set_config('test.uid', '${userId}', false);
    UPDATE public.global_dispatch_settings SET ${assignments} WHERE singleton = true
    RETURNING json_build_object('start_radius_meters', start_radius_meters,
      'expand_radius_meters', expand_radius_meters, 'max_radius_meters', max_radius_meters);
  `);
  const lines = out.split("\n").filter((l) => l.startsWith("{"));
  return lines.length ? JSON.parse(lines[0]) : null;
}

async function globalRow(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await psql("SELECT row_to_json(g) FROM public.global_dispatch_settings g WHERE singleton"),
  );
}

/** Per-area dispatch_settings row with conflicting km radii — Edge must ignore it. */
const STALE_SERVICE_AREA_ROW = {
  service_area_id: "sa-1",
  search_radius_meters: 3000,
  search_radius_start_km: 3,
  search_radius_expand_km: 5,
  search_radius_max_km: 8,
};

function fakeClient(global: Record<string, unknown> | null) {
  return {
    from(table: string) {
      const row = table === "global_dispatch_settings" ? global : STALE_SERVICE_AREA_ROW;
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
      };
      return chain;
    },
  };
}

async function edgeSettings() {
  // deno-lint-ignore no-explicit-any
  return await loadDispatchSettings(fakeClient(await globalRow()) as any, "sa-1");
}

async function edgeRadii(): Promise<number[]> {
  const s = await edgeSettings();
  return [1, 2, 3, 4, 5, 6].map((seq) => effectiveRadiusMeters(s, seq));
}

let tripCounter = 0;
async function sqlRadius(sequence: number): Promise<{ wave: number; radius: number }> {
  tripCounter += 1;
  const id = `00000000-0000-4000-9000-${String(tripCounter).padStart(12, "0")}`;
  const out = await psql(`
    INSERT INTO public.trips (id, trip_code, current_broadcast_round, searching_expires_at)
    VALUES ('${id}', 'IT-${tripCounter}', ${sequence - 1}, now() - interval '1 minute');
    SET ROLE service_role;
    SELECT public.dispatch_trip_offers('${id}'::uuid, 'integration_test')::text;
  `);
  const result = JSON.parse(out.split("\n").filter((l) => l.startsWith("{")).pop()!);
  assertEquals(result.status, "exhausted");
  return { wave: result.wave, radius: result.search_radius_meters };
}

async function sqlRadii(): Promise<number[]> {
  const out: number[] = [];
  for (const seq of [1, 2, 3, 4, 5, 6]) {
    const r = await sqlRadius(seq);
    assertEquals(r.wave, ((seq - 1) % 3) + 1);
    out.push(r.radius);
  }
  return out;
}

Deno.test({
  name: "Admin wave radius save persists and drives SQL + Edge dispatch",
  ignore: !PGHOST || !PGPORT,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await psql(`INSERT INTO public.user_roles(user_id, role) VALUES
      ('${ADMIN_ID}', 'admin'), ('${DRIVER_ID}', 'driver');`);

    // Baseline = live Admin values 13 / 17 / 29 km on both paths.
    const baseline = [13000, 17000, 29000, 13000, 17000, 29000];
    assertEquals(await sqlRadii(), baseline);
    assertEquals(await edgeRadii(), baseline, "Edge Wave 2 must be 17 km, not min(13+17, 29)");
    assertEquals(destinationMatchRadiusMeters(await edgeSettings()), 13000);

    // Admin edits Wave 2 → 20 km.
    assertEquals(await adminSave(ADMIN_ID, { expand_radius_meters: 20000 }), {
      start_radius_meters: 13000, expand_radius_meters: 20000, max_radius_meters: 29000,
    });
    const afterWave2 = [13000, 20000, 29000, 13000, 20000, 29000];
    assertEquals(await sqlRadii(), afterWave2);
    assertEquals(await edgeRadii(), afterWave2);

    // Admin edits Wave 1 → 9 km: towards-destination and Customer map radius stay put.
    await adminSave(ADMIN_ID, { start_radius_meters: 9000 });
    const afterWave1 = [9000, 20000, 29000, 9000, 20000, 29000];
    assertEquals(await sqlRadii(), afterWave1);
    assertEquals(await edgeRadii(), afterWave1);
    const s = await edgeSettings();
    assertEquals(destinationMatchRadiusMeters(s), 13000);
    const row = await globalRow();
    assertEquals(row.customer_nearby_drivers_radius_meters, 25000);
    assert(!afterWave1.includes(25000));

    // Admin edits Wave 3 → 40 km.
    await adminSave(ADMIN_ID, { max_radius_meters: 40000 });
    assertEquals(await edgeRadii(), [9000, 20000, 40000, 9000, 20000, 40000]);
    assertEquals((await sqlRadius(3)).radius, 40000);

    // Non-admin save: RLS returns no row and nothing changes.
    assertEquals(await adminSave(DRIVER_ID, { expand_radius_meters: 25000 }), null);
    assertEquals((await globalRow()).expand_radius_meters, 20000);

    // Invalid admin save (Wave 2 < Wave 1) is rejected by Postgres.
    let rejected = false;
    try {
      await adminSave(ADMIN_ID, { expand_radius_meters: 8000 });
    } catch (e) {
      rejected = /valid_radii/.test(String(e));
    }
    assert(rejected, "Wave 2 below Wave 1 must be rejected");
    assertEquals((await globalRow()).expand_radius_meters, 20000);

    // No global row → Edge fails closed (no schema-default radius).
    // deno-lint-ignore no-explicit-any
    const noGlobal = await loadDispatchSettings(fakeClient(null) as any, "sa-1");
    assertThrows(() => effectiveRadiusMeters(noGlobal, 1), BookingDispatchRadiusConfigError);
  },
});
