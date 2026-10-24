import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { handlePresetOffers } from "./index.ts";

const tripId = "11111111-1111-4111-8111-111111111111";
const areaId = "22222222-2222-4222-8222-222222222222";

function fakeClient(options: {
  offer?: Partial<{ driver_id: string; trip_id: string; status: string; expires_at: string }>;
  trip?: Record<string, unknown>;
  signedIn?: boolean;
  queryError?: boolean;
} = {}) {
  const queried: string[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    trips: [{ customer_id: "rider", service_area_id: areaId, ...options.trip }],
    customers: [], user_roles: [], drivers: [{ id: "driver", user_id: "user" }],
    ride_offers: [{ id: "offer", driver_id: "driver", trip_id: tripId,
      status: "pending", expires_at: "2099-01-01T00:00:00Z", ...options.offer }],
    service_areas: [{ id: areaId, timezone: "UTC" }],
    preset_offer_configs: [{ id: "config", is_enabled: true, schedule_enabled: false }],
    preset_offers: [{ id: "preset", fixed_amount_pence: 500 }],
  };
  const client = {
    auth: { getUser: () => Promise.resolve({ data: { user: options.signedIn === false ? null : { id: "user" } }, error: null }) },
    from(table: string) {
      queried.push(table);
      let selected = rows[table] ?? [];
      const query = {
        select: () => query,
        eq(field: string, value: unknown) {
          // Fixture trip/preset rows omit only fields immaterial to these cases.
          selected = selected.filter((r) => !(field in r) || r[field] === value);
          return query;
        },
        gt(field: string, value: string) {
          selected = selected.filter((r) => typeof r[field] === "string" && String(r[field]) > value);
          return query;
        },
        limit: () => query, order: () => query,
        maybeSingle: () => Promise.resolve({ data: selected[0] ?? null, error: null }),
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: selected, error: options.queryError && table === "ride_offers" ? new Error("lookup failed") : null }).then(resolve);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, queried };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(options: Parameters<typeof fakeClient>[0] = {}, withArea = false) {
  const { client, queried } = fakeClient(options);
  const response = await handlePresetOffers(new Request("https://example.test", {
    method: "POST", headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
    body: JSON.stringify({ trip_id: tripId, ...(withArea ? { service_area_id: areaId } : {}) }),
  }), client);
  return { status: response.status, body: await response.json(), queried };
}

Deno.test("incoming driver gets preset buttons using trip_id alone", async () => {
  const result = await request();
  assert(result.status === 200 && result.body.offers_allowed_now === true, "Live driver offer must be allowed");
  assert(result.body.offers[0]?.fixed_amount_pence === 500, "Configured offer must be returned");
});

for (const [name, offer] of Object.entries({
  "unrelated driver": { driver_id: "other" },
  "wrong trip": { trip_id: "other" },
  "expired offer": { expires_at: "2000-01-01T00:00:00Z" },
  "accepted offer": { status: "accepted" },
})) {
  Deno.test(`${name} cannot downgrade trip request to area offers`, async () => {
    const result = await request({ offer }, true);
    assert(result.status === 403, "Unrelated/inactive offers must not grant trip access");
    assert(!result.queried.includes("preset_offer_configs"), "Denied request must not fetch general offers");
  });
}

for (const [reason, trip] of Object.entries({
  INELIGIBLE_SCHEDULED: { is_scheduled: true },
  INELIGIBLE_CORPORATE: { corporate_account_id: "company" },
  INELIGIBLE_WHATSAPP: { booking_source: "whatsapp_booking" },
  NEGOTIATION_DISABLED: { negotiation_disabled: true },
})) {
  Deno.test(`authorized driver still respects ${reason}`, async () => {
    const result = await request({ trip }, true);
    assert(result.status === 200 && result.body.reason === reason, "Existing trip gate must run");
    assert(result.body.offers_allowed_now === false && result.body.offers.length === 0, "Ineligible trip must have no buttons");
  });
}

Deno.test("invalid session cannot access trip offers", async () => {
  const result = await request({ signedIn: false });
  assert(result.status === 401, "Missing validated user must be denied");
});

Deno.test("offer lookup failure fails closed", async () => {
  const result = await request({ queryError: true });
  assert(result.status === 500 && !result.queried.includes("preset_offer_configs"), "Query failure must never grant offers");
});