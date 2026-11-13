/**
 * OTA adoption telemetry — normalize + driver upsert field mapping + customer bind persistence.
 * Run: deno test --no-check --allow-read --allow-env supabase/functions/_shared/otaAdoptionTelemetry.execution.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDriverActiveDeviceUpsertRow,
  normalizeOtaAdoptionTelemetry,
} from "./otaAdoptionTelemetry.ts";
import { handleSaveCustomerPushToken } from "../save-customer-push-token/handler.ts";
import { createInMemorySupabase } from "./inMemorySupabaseFake.ts";

const NOW = "2026-11-13T12:00:00.000Z";

Deno.test("C1 normalize: full telemetry", () => {
  assertEquals(
    normalizeOtaAdoptionTelemetry(
      {
        loaded_update_id: "  7c1f2a9e-aaaa-bbbb-cccc-1234567890ab ",
        update_is_embedded: false,
        runtime_version: "1.4.0",
      },
      NOW,
    ),
    {
      loaded_update_id: "7c1f2a9e-aaaa-bbbb-cccc-1234567890ab",
      update_is_embedded: false,
      runtime_version: "1.4.0",
      loaded_update_registered_at: NOW,
    },
  );
});

Deno.test("C2 normalize: embedded launch has null update id but still registers", () => {
  const r = normalizeOtaAdoptionTelemetry(
    { loaded_update_id: null, update_is_embedded: true, runtime_version: "1.4.0" },
    NOW,
  );
  assertEquals(r.loaded_update_id, null);
  assertEquals(r.update_is_embedded, true);
  assertEquals(r.loaded_update_registered_at, NOW);
});

Deno.test("C3 normalize: older apps (nothing sent) → all null, never a registered timestamp", () => {
  for (const body of [{}, null, undefined, { app_version: "1.0.0" }]) {
    assertEquals(normalizeOtaAdoptionTelemetry(body as never, NOW), {
      loaded_update_id: null,
      update_is_embedded: null,
      runtime_version: null,
      loaded_update_registered_at: null,
    });
  }
});

Deno.test("C4 normalize: junk types are rejected, strings capped, booleans coerced", () => {
  const r = normalizeOtaAdoptionTelemetry(
    {
      loaded_update_id: 12345,
      update_is_embedded: "maybe",
      runtime_version: "x".repeat(500),
    },
    NOW,
  );
  assertEquals(r.loaded_update_id, null);
  assertEquals(r.update_is_embedded, null);
  assertEquals(r.runtime_version?.length, 64);
  assertEquals(normalizeOtaAdoptionTelemetry({ update_is_embedded: "true" }, NOW).update_is_embedded, true);
  assertEquals(normalizeOtaAdoptionTelemetry({ update_is_embedded: 0 }, NOW).update_is_embedded, false);
  assertEquals(normalizeOtaAdoptionTelemetry({ loaded_update_id: "   " }, NOW).loaded_update_id, null);
});

Deno.test("C5 driver upsert row maps every OTA column alongside client_capabilities", () => {
  const ota = normalizeOtaAdoptionTelemetry(
    { loaded_update_id: "upd-1", update_is_embedded: false, runtime_version: "2.0.0" },
    NOW,
  );
  const row = buildDriverActiveDeviceUpsertRow({
    driverId: "drv-1",
    installationId: "install-0001",
    platform: "android",
    nowIso: NOW,
    appVersion: "2.0.1",
    clientCapabilities: ["scheduled_departure_ack_v1"],
    ota,
  });
  assertEquals(row.driver_id, "drv-1");
  assertEquals(row.device_id, "install-0001");
  assertEquals(row.client_capabilities, ["scheduled_departure_ack_v1"]);
  assertEquals(row.client_capabilities_updated_at, NOW);
  assertEquals(row.loaded_update_id, "upd-1");
  assertEquals(row.update_is_embedded, false);
  assertEquals(row.runtime_version, "2.0.0");
  assertEquals(row.loaded_update_registered_at, NOW);
});

Deno.test("C6 driver upsert: older app rebind CLEARS previous OTA telemetry (replace, never merge)", () => {
  const sb = createInMemorySupabase({
    driver_active_devices: [{
      driver_id: "drv-1",
      device_id: "install-0001",
      loaded_update_id: "stale-update",
      update_is_embedded: false,
      runtime_version: "1.0.0",
      loaded_update_registered_at: "2026-11-01T00:00:00.000Z",
    }],
  });
  const row = buildDriverActiveDeviceUpsertRow({
    driverId: "drv-1",
    installationId: "install-0001",
    platform: "ios",
    nowIso: NOW,
    appVersion: null,
    clientCapabilities: [],
    ota: normalizeOtaAdoptionTelemetry({}, NOW),
  });
  // Upsert semantic: PostgREST replaces every column present in the payload.
  Object.assign(sb.db.driver_active_devices[0], row);
  const stored = sb.db.driver_active_devices[0];
  assertEquals(stored.loaded_update_id, null);
  assertEquals(stored.update_is_embedded, null);
  assertEquals(stored.runtime_version, null);
  assertEquals(stored.loaded_update_registered_at, null);
});

Deno.test("C7 bind-driver-device-token source: reads body OTA fields through the shared helper", async () => {
  const src = await Deno.readTextFile(
    new URL("../bind-driver-device-token/index.ts", import.meta.url),
  );
  assert(src.includes("normalizeOtaAdoptionTelemetry"));
  assert(src.includes("buildDriverActiveDeviceUpsertRow"));
  assert(src.includes("loaded_update_id"));
  assert(src.includes("update_is_embedded"));
  assert(src.includes("runtime_version"));
  // Telemetry only — never forces a reload.
  assert(!/reloadAsync|force_ota|forceReload/.test(src));
});

Deno.test("C8 migration adds all four nullable columns to BOTH active-device tables", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20270221120000_active_devices_ota_adoption_telemetry.sql",
      import.meta.url,
    ),
  );
  for (const table of ["driver_active_devices", "customer_active_devices"]) {
    for (
      const col of [
        "loaded_update_id text",
        "update_is_embedded boolean",
        "runtime_version text",
        "loaded_update_registered_at timestamptz",
      ]
    ) {
      assert(
        sql.includes(`ALTER TABLE public.${table}`) && sql.includes(`ADD COLUMN IF NOT EXISTS ${col}`),
        `${table} ${col}`,
      );
    }
    assert(sql.includes(`COMMENT ON COLUMN public.${table}.loaded_update_id`));
  }
  assert(!/NOT NULL/.test(sql));
});

// --- Customer bind (real handler, in-memory Supabase) ----------------------------------

const USER = "11111111-1111-1111-1111-111111111111";
const DEVICE = "install-device-0001";
const FCM = `fGx7Kp2LmNo:APA91b${"A".repeat(134)}`;

function customerClient(seed: Record<string, Record<string, unknown>[]>) {
  const sb = createInMemorySupabase(seed);
  const client = {
    auth: {
      getUser: (_jwt: string) =>
        Promise.resolve({ data: { user: { id: USER } }, error: null }),
    },
    // The handler uses upsert(); layer it over the fake with onConflict semantics.
    from(table: string) {
      const b = sb.from(table);
      b.upsert = (row: Record<string, unknown>, opts: { onConflict: string }) => {
        const rows = sb.db[table];
        const idx = rows.findIndex((r) => r[opts.onConflict] === row[opts.onConflict]);
        if (idx >= 0) Object.assign(rows[idx], row);
        else rows.push({ ...row });
        return Promise.resolve({ data: null, error: null });
      };
      return b;
    },
  };
  return { sb, client: client as never };
}

function post(body: Record<string, unknown>) {
  return new Request("https://example.supabase.co/functions/v1/save-customer-push-token", {
    method: "POST",
    headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("C9 customer bind persists OTA telemetry on customer_active_devices (claim)", async () => {
  const { sb, client } = customerClient({ customer_active_devices: [], customer_push_tokens: [] });
  const res = await handleSaveCustomerPushToken(
    post({
      token: FCM,
      platform: "android",
      device_id: DEVICE,
      claim: true,
      loaded_update_id: "cust-upd-9",
      update_is_embedded: false,
      runtime_version: "3.1.0",
    }),
    () => client,
  );
  assertEquals(res.status, 200);
  const row = sb.db.customer_active_devices[0];
  assertEquals(row.loaded_update_id, "cust-upd-9");
  assertEquals(row.update_is_embedded, false);
  assertEquals(row.runtime_version, "3.1.0");
  assert(typeof row.loaded_update_registered_at === "string");
});

Deno.test("C10 customer refresh bind by older app clears OTA telemetry; wrong device is rejected untouched", async () => {
  const { sb, client } = customerClient({
    customer_active_devices: [{
      user_id: USER,
      device_id: DEVICE,
      platform: "android",
      loaded_update_id: "cust-upd-9",
      update_is_embedded: false,
      runtime_version: "3.1.0",
      loaded_update_registered_at: "2026-11-01T00:00:00.000Z",
    }],
    customer_push_tokens: [],
  });

  const stranger = await handleSaveCustomerPushToken(
    post({ token: FCM, platform: "android", device_id: "install-device-9999", claim: false }),
    () => client,
  );
  assertEquals(stranger.status, 409);
  assertEquals(sb.db.customer_active_devices[0].loaded_update_id, "cust-upd-9");

  const older = await handleSaveCustomerPushToken(
    post({ token: FCM, platform: "android", device_id: DEVICE, claim: false }),
    () => client,
  );
  assertEquals(older.status, 200);
  const row = sb.db.customer_active_devices[0];
  assertEquals(row.loaded_update_id, null);
  assertEquals(row.update_is_embedded, null);
  assertEquals(row.runtime_version, null);
  assertEquals(row.loaded_update_registered_at, null);
});
