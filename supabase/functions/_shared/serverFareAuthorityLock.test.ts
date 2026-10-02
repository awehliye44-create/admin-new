/**
 * Lock: the booking fare is SERVER-AUTHORITATIVE end to end.
 *
 *   calculate-route → route artifact (Mapbox distance/duration, server SA)
 *   calculate-fare  → fare artifact  (pricing-engine.ts on the route artifact)
 *   booking quote   → trip fare = artifact gross − server discount
 *                     + server buffer (+ folded receivable)
 *   create-preauth  → quote total; session fare_snapshot from server values
 *
 * Defect: customer-receivable-booking-quote froze `body.trip_fare_pence`, so a
 * client sending 1 got a Revolut order of 1 (251 with buffer) and a trip fare
 * of 1 captured at completion.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { issueServerAuthoritativeBookingQuote } from "./serverBookingQuoteIssue.ts";
import {
  buildFareArtifactInserts,
  buildOpaqueQuoteSessionFareSnapshot,
  buildRouteArtifactInsert,
  buildServerPreauthSessionFareSnapshot,
  buildServerRouteKey,
  type RouteArtifactRow,
  stripFareSnapshotMoneyKeys,
  validateRouteArtifactForFare,
  validateServerFareArtifactForQuote,
} from "./serverFareAuthoritySSOT.ts";
import {
  type BookingPaymentQuoteRow,
  resolvePreauthAmountsFromQuote,
  rowFromDb,
  validateBookingPaymentQuoteForPreauth,
} from "./bookingPaymentQuoteSSOT.ts";
import { planRevolutCompletionCapture } from "./revolutPaymentHoldSSOT.ts";

// ─── In-memory Supabase ───────────────────────────────────────

type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row[]> = {};
  rpcs: Record<string, (args: Row) => unknown> = {};
  private seq = 0;

  nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  rows(table: string): Row[] {
    this.tables[table] ??= [];
    return this.tables[table];
  }

  client() {
    // deno-lint-ignore no-this-alias
    const db = this;
    return {
      from: (table: string) => db.query(table),
      rpc: (name: string, args: Row) =>
        Promise.resolve({ data: db.rpcs[name] ? db.rpcs[name](args) : null, error: null }),
    };
  }

  query(table: string) {
    const db = this;
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let orderCol: string | null = null;
    let asc = true;
    let lim: number | null = null;
    let countMode = false;
    const exec = (): Promise<{ data: unknown; error: null; count?: number }> => {
      const all = db.rows(table);
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const inserted = list.map((r) => ({ id: db.nextId(), ...r }));
        all.push(...inserted);
        return Promise.resolve({ data: inserted, error: null });
      }
      let matched = all.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of matched) Object.assign(r, payload);
        return Promise.resolve({ data: matched, error: null });
      }
      if (op === "delete") {
        db.tables[table] = all.filter((r) => !matched.includes(r));
        return Promise.resolve({ data: matched, error: null });
      }
      if (orderCol) {
        const c = orderCol;
        matched = [...matched].sort((a, b) =>
          (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1)
        );
      }
      if (lim != null) matched = matched.slice(0, lim);
      if (countMode) return Promise.resolve({ data: null, error: null, count: matched.length });
      return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null });
    };
    const q = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) countMode = true;
        return q;
      },
      eq(c: string, v: unknown) {
        filters.push((r) => String(r[c]) === String(v));
        return q;
      },
      gt(c: string, v: unknown) {
        filters.push((r) => String(r[c]) > String(v));
        return q;
      },
      lte(c: string, v: unknown) {
        filters.push((r) => String(r[c]) <= String(v));
        return q;
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.map(String).includes(String(r[c])));
        return q;
      },
      is(c: string, v: unknown) {
        filters.push((r) => (r[c] ?? null) === v);
        return q;
      },
      or() {
        return q;
      },
      order(c: string, o?: { ascending?: boolean }) {
        orderCol = c;
        asc = o?.ascending !== false;
        return q;
      },
      limit(n: number) {
        lim = n;
        return q;
      },
      insert(p: Row | Row[]) {
        op = "insert";
        payload = p;
        return q;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return q;
      },
      delete() {
        op = "delete";
        return q;
      },
      maybeSingle() {
        return exec().then((r) => ({
          data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
          error: r.error,
        }));
      },
      single() {
        return q.maybeSingle();
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        return exec().then(res, rej);
      },
    };
    return q;
  }
}

// ─── Fixtures ─────────────────────────────────────────────────

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CUSTOMER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_CUSTOMER = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const MK = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";
const SA_252 = "29259edf-80eb-4c08-9089-352b8a305b81";
const VT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VT_EXEC = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ROUTE_ID = "11111111-2222-4333-8444-555555555555";
const FARE_ID = "66666666-7777-4888-8999-aaaaaaaaaaa1";
const FARE_EXEC_ID = "66666666-7777-4888-8999-aaaaaaaaaaa2";
const CA = "12345678-1234-4234-8234-123456789012";
const PICKUP = { lat: 52.041234, lng: -0.759876 };
const DROPOFF = { lat: 52.012345, lng: -0.734567 };
const GATE_OFF = { enabled: false, allowlist: new Set<string>() };

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const ROUTE_KEY = buildServerRouteKey({ pickup: PICKUP, dropoff: DROPOFF, stops: [] })!;

function fareArtifact(overrides: Row = {}): Row {
  return {
    id: FARE_ID,
    user_id: USER,
    route_quote_id: ROUTE_ID,
    route_key: ROUTE_KEY,
    service_area_id: MK,
    vehicle_type_id: VT,
    currency: "gbp",
    distance_km: 5.2,
    duration_min: 11,
    gross_fare_pence: 771,
    airport_charge_pence: 0,
    surge_multiplier: 1,
    surge_quote_id: null,
    fare_source: "metered",
    pricing_mode: "metered",
    minimum_applied: false,
    engine: "pricing-engine.ts",
    pricing_hash: "hash-771",
    schema_version: 1,
    created_at: iso(NOW - 60_000),
    expires_at: iso(NOW + 30 * 60_000),
    ...overrides,
  };
}

function seedDb(): FakeDb {
  const db = new FakeDb();
  db.tables.customers = [
    { id: CUSTOMER, user_id: USER },
    { id: OTHER_CUSTOMER, user_id: OTHER_USER },
  ];
  db.tables.service_areas = [
    { id: MK, is_active: true },
    { id: SA_252, is_active: true },
  ];
  db.tables.service_area_preauth_settings = [{
    service_area_id: MK,
    enable_preauth_buffer: true,
    buffer_type: "fixed",
    buffer_value: 2.5,
    min_hold_pence: null,
    max_hold_pence: null,
  }];
  db.tables.server_fare_quotes = [
    fareArtifact(),
    fareArtifact({
      id: FARE_EXEC_ID,
      vehicle_type_id: VT_EXEC,
      gross_fare_pence: 1290,
      pricing_hash: "hash-1290",
    }),
  ];
  db.tables.customer_personal_vouchers = [{
    id: "99999999-9999-4999-8999-999999999999",
    customer_id: CUSTOMER,
    code: "SAVE2",
    discount_type: "fixed",
    discount_value: 2,
    min_fare: 0,
    max_uses: 1,
    used_count: 0,
    expires_at: null,
    is_active: true,
  }];
  db.tables.offer_service_areas = [];
  db.tables.customer_receivables = [];
  db.tables.booking_payment_quotes = [];
  return db;
}

/** Shape the installed Customer build sends today. */
function customerBody(overrides: Row = {}): Row {
  return {
    client_action_id: CA,
    trip_fare_pence: 771,
    buffer_pence: 0,
    currency: "GBP",
    service_area_id: MK,
    vehicle_type_id: VT,
    ride_category: VT,
    pickup: PICKUP,
    dropoff: DROPOFF,
    stops: [],
    ...overrides,
  };
}

async function quote(db: FakeDb, body: Row, userId = USER) {
  // deno-lint-ignore no-explicit-any
  return await issueServerAuthoritativeBookingQuote(db.client() as any, {
    userId,
    body,
    nowMs: NOW,
    gate: GATE_OFF,
  });
}

function assertMoney(
  res: { status: number; body: Row },
  trip: number,
  buffer: number,
  total: number,
) {
  assertEquals(res.status, 200, JSON.stringify(res.body));
  assertEquals(res.body.trip_fare_pence, trip);
  assertEquals(res.body.buffer_pence, buffer);
  assertEquals(res.body.total_authorisation_pence, total);
}

// ─── Tamper 1–3, 12–13: client fare / buffer have zero authority ──

Deno.test("T1. client trip_fare_pence 1 → server 771 + 250 = 1021 (never 251)", async () => {
  const res = await quote(seedDb(), customerBody({ trip_fare_pence: 1 }));
  assertMoney(res, 771, 250, 1021);
  assert(res.body.total_authorisation_pence !== 251);
  assertEquals(res.body.server_fare_quote_id, FARE_ID);
});

Deno.test("T2. client trip_fare_pence 100 → 1021", async () => {
  assertMoney(await quote(seedDb(), customerBody({ trip_fare_pence: 100 })), 771, 250, 1021);
});

Deno.test("T3. client trip_fare_pence 999999 → 1021 (inflation also ignored)", async () => {
  assertMoney(await quote(seedDb(), customerBody({ trip_fare_pence: 999999 })), 771, 250, 1021);
});

Deno.test("T12. client buffer_pence 0 → server buffer 250", async () => {
  assertMoney(await quote(seedDb(), customerBody({ buffer_pence: 0 })), 771, 250, 1021);
});

Deno.test("T13. client buffer_pence 99999 with fare 1 → still 1021", async () => {
  assertMoney(
    await quote(seedDb(), customerBody({ buffer_pence: 99999, trip_fare_pence: 1 })),
    771,
    250,
    1021,
  );
});

Deno.test("T1b. persisted quote row carries server fare, artifact id and evidence", async () => {
  const db = seedDb();
  await quote(db, customerBody({ trip_fare_pence: 1 }));
  const row = db.rows("booking_payment_quotes")[0];
  assertEquals(row.trip_fare_pence, 771);
  assertEquals(row.total_authorisation_pence, 1021);
  assertEquals(row.server_fare_quote_id, FARE_ID);
  assert(String(row.pricing_fingerprint).includes(`sfq:${FARE_ID}`));
  const meta = row.metadata as Row;
  assertEquals(meta.fare_authority, "server_fare_quotes");
  assertEquals(meta.gross_fare_pence, 771);
  assertEquals(meta.client_claimed_trip_fare_pence, 1);
});

// ─── Tamper 4: distance ───────────────────────────────────────

Deno.test("T4. client distance has no effect on the quote; route artifact is the distance basis", async () => {
  assertMoney(
    await quote(seedDb(), customerBody({ estimated_distance_km: 0.1, distance_km: 0.1 })),
    771,
    250,
    1021,
  );
  const route: RouteArtifactRow = {
    id: ROUTE_ID,
    user_id: USER,
    route_key: ROUTE_KEY,
    distance_meters: 5200,
    duration_seconds: 660,
    distance_km: 5.2,
    duration_min: 11,
    provider: "mapbox_directions",
    service_area_id: MK,
    created_at: iso(NOW),
    expires_at: iso(NOW + 60_000),
    schema_version: 1,
  };
  const rows = await buildFareArtifactInserts({
    route,
    serviceAreaId: MK,
    currency: "GBP",
    isScheduled: false,
    fares: [{
      vehicleTypeId: VT,
      grossFarePence: 771,
      airportChargePence: 0,
      surgeMultiplier: 1,
      surgeQuoteId: null,
      fareSource: "metered",
      pricingMode: "metered",
      minimumApplied: false,
      evidence: { distance_km: 0.1 },
    }],
    nowMs: NOW,
  });
  assertEquals(rows[0].distance_km, 5.2);
  assertEquals(rows[0].route_quote_id, ROUTE_ID);
  assertEquals((rows[0].pricing_evidence as Row).route_quote_id, ROUTE_ID);

  const src = await Deno.readTextFile(new URL("../calculate-fare/index.ts", import.meta.url));
  assertStringIncludes(src, "distanceKm = routeArtifact.distance_km;");
  assertStringIncludes(src, "durationMin = routeArtifact.duration_min;");
  assertStringIncludes(src, "if (routeArtifact && fareArtifactInputs.length > 0)");
});

Deno.test("T4b. haversine estimates are never persisted as route artifacts", () => {
  const base = {
    userId: USER,
    pickup: PICKUP,
    dropoff: DROPOFF,
    stops: [],
    distanceMeters: 5200,
    durationSeconds: 660,
    profile: "driving",
    departureAt: null,
    serviceAreaId: MK,
    nowMs: NOW,
  };
  assertEquals(buildRouteArtifactInsert({ ...base, provider: "haversine" }), null);
  const ok = buildRouteArtifactInsert({ ...base, provider: "mapbox_directions" })!;
  assertEquals(ok.distance_km, 5.2);
  assertEquals(ok.duration_min, 11);
  assertEquals(ok.route_key, ROUTE_KEY);
  assertEquals(ok.service_area_id, MK);
});

// ─── Tamper 5: service area ───────────────────────────────────

Deno.test("T5. client service_area_id ≠ server SA → SERVICE_AREA_MISMATCH, no quote", async () => {
  const db = seedDb();
  const res = await quote(db, customerBody({ service_area_id: SA_252 }));
  assertEquals(res.status, 409);
  assertEquals(res.body.code, "SERVICE_AREA_MISMATCH");
  assertEquals(db.rows("booking_payment_quotes").length, 0);

  const fare = await Deno.readTextFile(new URL("../calculate-fare/index.ts", import.meta.url));
  assertStringIncludes(fare, "routeArtifact.service_area_id !== service_area_id");
  const preauth = await Deno.readTextFile(
    new URL("../create-preauth-payment-intent/index.ts", import.meta.url),
  );
  assertStringIncludes(preauth, "pickupSa.serviceAreaId !== resolvedServiceAreaId");
  const route = await Deno.readTextFile(new URL("../calculate-route/index.ts", import.meta.url));
  assertStringIncludes(route, "resolveServiceAreaIdForPickup(admin, {");
});

// ─── Tamper 6: vehicle ────────────────────────────────────────

Deno.test("T6. vehicle change prices from that vehicle's artifact; cross-vehicle id rejected", async () => {
  assertMoney(
    await quote(seedDb(), customerBody({ vehicle_type_id: VT_EXEC, ride_category: VT_EXEC, trip_fare_pence: 771 })),
    1290,
    250,
    1540,
  );
  const cross = await quote(
    seedDb(),
    customerBody({ vehicle_type_id: VT_EXEC, ride_category: VT_EXEC, server_fare_quote_id: FARE_ID }),
  );
  assertEquals(cross.status, 409);
  assertEquals(cross.body.code, "FARE_QUOTE_CHANGED");
  assertEquals(cross.body.note, "fare_artifact_vehicle_mismatch");
  const unknown = await quote(
    seedDb(),
    customerBody({ vehicle_type_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
  );
  assertEquals(unknown.status, 409);
  assertEquals(unknown.body.code, "FARE_QUOTE_UNAVAILABLE");
});

// ─── Tamper 7: voucher add / remove / change ──────────────────

Deno.test("T7. voucher add/remove re-quotes from server state; never reused", async () => {
  const db = seedDb();
  const plain = await quote(db, customerBody());
  assertMoney(plain, 771, 250, 1021);

  const withVoucher = await quote(db, customerBody({ personal_voucher_code: "save2" }));
  assertMoney(withVoucher, 571, 250, 821);
  assertEquals(withVoucher.body.reused, false);
  assert(withVoucher.body.quote_id !== plain.body.quote_id);
  const rows = db.rows("booking_payment_quotes");
  assertEquals(rows.find((r) => r.id === plain.body.quote_id)?.state, "CANCELLED");
  const vMeta = rows.find((r) => r.id === withVoucher.body.quote_id)!.metadata as Row;
  assertEquals(vMeta.discount_source, "personal_voucher");
  assertEquals(vMeta.applied_personal_voucher_code, "SAVE2");

  const removed = await quote(db, customerBody());
  assertMoney(removed, 771, 250, 1021);
  assertEquals(removed.body.reused, false);
});

Deno.test("T7b. client voucher_id / discounted client fare have no pricing effect", async () => {
  assertMoney(
    await quote(seedDb(), customerBody({ voucher_id: "v-client", trip_fare_pence: 571 })),
    771,
    250,
    1021,
  );
});

Deno.test("T7c. invalid / foreign voucher fails closed (no quote)", async () => {
  const db = seedDb();
  const bad = await quote(db, customerBody({ personal_voucher_code: "NOPE" }));
  assertEquals(bad.status, 422);
  assertEquals(bad.body.code, "VOUCHER_INVALID");
  const foreign = await quote(db, customerBody({ personal_voucher_code: "SAVE2" }), OTHER_USER);
  assertEquals(foreign.status, 409);
  assertEquals(db.rows("booking_payment_quotes").length, 0);
});

Deno.test("T7d. create-preauth rejects a voucher not bound into the opaque quote", async () => {
  const src = await Deno.readTextFile(
    new URL("../create-preauth-payment-intent/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "if (boundCode !== requestCode) {");
  assertStringIncludes(src, 'note: "voucher_not_bound_to_quote"');
  const opaqueIdx = src.indexOf('if (fareSettled.kind === "opaque" && fareSettled.row) {');
  const elseIdx = src.indexOf("} else if (body.personal_voucher_code?.trim()) {", opaqueIdx);
  assert(opaqueIdx > 0 && elseIdx > opaqueIdx);
  assertEquals(src.slice(opaqueIdx, elseIdx).includes("resolvePersonalVoucherForTrip"), false);
});

// ─── Tamper 8–9: server fare / route changed ─────────────────

Deno.test("T8. newer server fare artifact → new quote at the new fare (no stale reuse)", async () => {
  const db = seedDb();
  const first = await quote(db, customerBody());
  assertMoney(first, 771, 250, 1021);
  const again = await quote(db, customerBody());
  assertEquals(again.body.reused, true);
  assertEquals(again.body.quote_id, first.body.quote_id);

  db.rows("server_fare_quotes").push(fareArtifact({
    id: "66666666-7777-4888-8999-aaaaaaaaaaa3",
    gross_fare_pence: 820,
    pricing_hash: "hash-820",
    created_at: iso(NOW - 1_000),
  }));
  const repriced = await quote(db, customerBody({ trip_fare_pence: 771 }));
  assertMoney(repriced, 820, 250, 1070);
  assertEquals(repriced.body.reused, false);
});

Deno.test("T9. route changed → no artifact for the new route; explicit old id rejected", async () => {
  const moved = { lat: 52.1, lng: -0.7 };
  const res = await quote(seedDb(), customerBody({ dropoff: moved }));
  assertEquals(res.status, 409);
  assertEquals(res.body.code, "FARE_QUOTE_UNAVAILABLE");
  const explicit = await quote(seedDb(), customerBody({ dropoff: moved, server_fare_quote_id: FARE_ID }));
  assertEquals(explicit.status, 409);
  assertEquals(explicit.body.code, "FARE_QUOTE_CHANGED");
  assertEquals(explicit.body.note, "fare_artifact_route_mismatch");
  const withStop = await quote(seedDb(), customerBody({ stops: [{ lat: 52.03, lng: -0.75 }] }));
  assertEquals(withStop.body.code, "FARE_QUOTE_UNAVAILABLE");
});

// ─── Tamper 10–11: expiry / ownership ─────────────────────────

Deno.test("T10. expired artifacts fail closed", async () => {
  const db = seedDb();
  for (const r of db.rows("server_fare_quotes")) r.expires_at = iso(NOW - 1);
  assertEquals((await quote(db, customerBody())).body.code, "FARE_QUOTE_UNAVAILABLE");
  assertEquals(
    (await quote(db, customerBody({ server_fare_quote_id: FARE_ID }))).body.code,
    "FARE_QUOTE_EXPIRED",
  );
  const route = validateRouteArtifactForFare({
    id: ROUTE_ID,
    user_id: USER,
    route_key: ROUTE_KEY,
    distance_meters: 5200,
    duration_seconds: 660,
    distance_km: 5.2,
    duration_min: 11,
    provider: "mapbox_directions",
    service_area_id: MK,
    created_at: iso(NOW - 2),
    expires_at: iso(NOW - 1),
    schema_version: 1,
  }, { userId: USER, routeKey: ROUTE_KEY, nowMs: NOW });
  assertEquals(route.ok ? null : route.reason, "expired");
});

Deno.test("T11. another customer cannot use the artifact (id or lookup)", async () => {
  const db = seedDb();
  const byId = await quote(db, customerBody({ server_fare_quote_id: FARE_ID }), OTHER_USER);
  assertEquals(byId.status, 409);
  assertEquals(byId.body.code, "FARE_QUOTE_UNAVAILABLE");
  const byLookup = await quote(db, customerBody(), OTHER_USER);
  assertEquals(byLookup.body.code, "FARE_QUOTE_UNAVAILABLE");
  assertEquals(db.rows("booking_payment_quotes").length, 0);
  const owner = validateServerFareArtifactForQuote(rowFromDbFare(fareArtifact()), {
    userId: OTHER_USER,
    routeKey: ROUTE_KEY,
    vehicleTypeId: VT,
    serviceAreaId: MK,
    nowMs: NOW,
  });
  assertEquals(owner.ok ? null : owner.note, "fare_artifact_owner_mismatch");
});

// deno-lint-ignore no-explicit-any
function rowFromDbFare(r: Row): any {
  return { ...r, gross_fare_pence: Number(r.gross_fare_pence) };
}

// ─── Buffer invariants on the server fare ─────────────────────

Deno.test("B1. disabled buffer → 0; percentage ceil; min/max clamp — all on the server fare", async () => {
  const db = seedDb();
  const s = db.rows("service_area_preauth_settings")[0];
  s.enable_preauth_buffer = false;
  assertMoney(await quote(db, customerBody({ trip_fare_pence: 1 })), 771, 0, 771);

  const pct = seedDb();
  Object.assign(pct.rows("service_area_preauth_settings")[0], {
    buffer_type: "percentage",
    buffer_value: 12.5,
  });
  assertMoney(await quote(pct, customerBody({ trip_fare_pence: 1 })), 771, 97, 868);

  const minHold = seedDb();
  minHold.rows("service_area_preauth_settings")[0].min_hold_pence = 1500;
  assertMoney(await quote(minHold, customerBody({ trip_fare_pence: 1 })), 771, 729, 1500);

  const maxHold = seedDb();
  maxHold.rows("service_area_preauth_settings")[0].max_hold_pence = 900;
  assertMoney(await quote(maxHold, customerBody()), 771, 129, 900);
});

Deno.test("B2. completion captures 771 and releases the 250 buffer", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 771,
    authorisedHoldPence: 1021,
    bufferPence: 250,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 771);
    assertEquals(plan.release_remainder_pence, 250);
  }
});

// ─── Preauth admission + session snapshot ─────────────────────

function quoteRow(overrides: Partial<BookingPaymentQuoteRow> = {}): BookingPaymentQuoteRow {
  return rowFromDb({
    id: "q-1",
    customer_id: CUSTOMER,
    user_id: USER,
    client_action_id: CA,
    service_area_id: MK,
    ride_category: VT,
    route_fingerprint: "fp",
    currency: "gbp",
    trip_fare_pence: 771,
    buffer_pence: 250,
    receivable_pence: 0,
    total_authorisation_pence: 1021,
    fold_eligible: false,
    consent_version: 1,
    state: "ISSUED",
    consumed_payment_session_id: null,
    issued_at: iso(NOW),
    expires_at: iso(NOW + 60_000),
    metadata: {},
    server_fare_quote_id: FARE_ID,
    pricing_fingerprint: "pf1|x",
    ...overrides,
  });
}

Deno.test("P1. preauth rejects a quote not priced from a server fare artifact", async () => {
  const base = {
    customer_id: CUSTOMER,
    client_action_id: CA,
    route_fingerprint: "fp",
    currency: "gbp",
    open_receivable_pence: 0,
    gate_enabled: false,
    require_server_fare_artifact: true,
  };
  const legacy = validateBookingPaymentQuoteForPreauth({
    ...base,
    quote: quoteRow({ server_fare_quote_id: null, pricing_fingerprint: null, trip_fare_pence: 1, total_authorisation_pence: 251 }),
  });
  assertEquals(legacy.ok ? null : legacy.note, "quote_missing_server_fare_artifact");
  const good = validateBookingPaymentQuoteForPreauth({ ...base, quote: quoteRow() });
  assertEquals(good.ok, true);
  const amounts = resolvePreauthAmountsFromQuote(quoteRow());
  assertEquals(amounts.total_authorisation_pence, 1021);

  const revolut = await Deno.readTextFile(new URL("./revolutPreauth.ts", import.meta.url));
  assertStringIncludes(revolut, "require_server_fare_artifact: true,");
  assertStringIncludes(
    revolut,
    "fareSnapshot = buildOpaqueQuoteSessionFareSnapshot(fareSnapshot, opaqueQuote);",
  );
});

Deno.test("P2. opaque session fare_snapshot: client money keys replaced by quote values", () => {
  const tampered = {
    estimated_total_pence: 1,
    authorised_amount_pence: 1,
    buffer_pence: 0,
    gross_fare_pence: 1,
    final_fare_pence: 1,
    offer_discount_pence: 0,
    discount_amount_pence: 5000,
    booking_source: "customer_app",
    client_action_id: CA,
  };
  const snap = buildOpaqueQuoteSessionFareSnapshot(tampered, quoteRow());
  assertEquals(snap.estimated_total_pence, 771);
  assertEquals(snap.final_fare_pence, 771);
  assertEquals(snap.gross_fare_pence, 771);
  assertEquals(snap.offer_discount_pence, 0);
  assertEquals(snap.buffer_pence, 250);
  assertEquals(snap.authorised_amount_pence, 1021);
  assertEquals("discount_amount_pence" in snap, false);
  assertEquals(snap.booking_source, "customer_app");
  assertEquals(snap.server_fare_quote_id, FARE_ID);
});

Deno.test("P3. create-preauth session fare_snapshot never forwards client money", async () => {
  const snap = buildServerPreauthSessionFareSnapshot({
    estimatedTotalPence: 771,
    authorisedAmountPence: 1021,
    bufferPence: 250,
    metadataExtra: { gross_fare_pence: "771", offer_discount_pence: "0", final_fare_pence: "771" },
    clientFareSnapshot: { final_fare_pence: 1, gross_fare_pence: 1, booking_source: "customer_app" },
  });
  assertEquals(snap.estimated_total_pence, 771);
  assertEquals(snap.final_fare_pence, "771");
  assertEquals(snap.booking_source, "customer_app");
  assertEquals(Object.keys(stripFareSnapshotMoneyKeys({ tip_pence: 1, booking_source: "x" })), [
    "booking_source",
  ]);
  const src = await Deno.readTextFile(
    new URL("../create-preauth-payment-intent/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "fareSnapshot: buildServerPreauthSessionFareSnapshot({");
  assertEquals(/fareSnapshot:\s*\n?\s*body\.fare_snapshot/.test(src), false);
});

// ─── Route identity + engine isolation ────────────────────────

Deno.test("R1. one route key for calculate-route, calculate-fare and the quote", () => {
  const stops = [{ lat: 52.03, lng: -0.75 }];
  const k = buildServerRouteKey({ pickup: PICKUP, dropoff: DROPOFF, stops });
  assertEquals(
    k,
    buildServerRouteKey({
      pickup: { lat: PICKUP.lat + 1e-7, lng: PICKUP.lng },
      dropoff: DROPOFF,
      stops,
    }),
  );
  assert(k !== buildServerRouteKey({ pickup: PICKUP, dropoff: DROPOFF, stops: [] }));
  assert(k !== buildServerRouteKey({ pickup: DROPOFF, dropoff: PICKUP, stops }));
  assertEquals(buildServerRouteKey({ pickup: PICKUP, dropoff: null, stops: [] }), null);
});

Deno.test("R2. calculate-fare prices with pricing-engine.ts only", async () => {
  const src = await Deno.readTextFile(new URL("../calculate-fare/index.ts", import.meta.url));
  assertStringIncludes(src, 'from "../_shared/pricing-engine.ts"');
  for (const forbidden of ["estimate-fare", "fareEngine.ts", "serverFareQuote.ts", "maps.googleapis", "api.mapbox.com"]) {
    assertEquals(src.includes(forbidden), false, forbidden);
  }
  const quoteSrc = await Deno.readTextFile(new URL("./serverBookingQuoteIssue.ts", import.meta.url));
  assertEquals(quoteSrc.includes("api.mapbox.com"), false);
  assertEquals(/fields\.trip_fare_pence|body\.trip_fare_pence/.test(quoteSrc), false);
});

Deno.test("R3. calculate-route persists Mapbox measurements only, never cached ids across users", async () => {
  const src = await Deno.readTextFile(new URL("../calculate-route/index.ts", import.meta.url));
  assertStringIncludes(src, 'if (!ctx || result.source !== "mapbox_directions") {');
  assertStringIncludes(src, "userId: callerGate.userId,");
  const writeIdx = src.indexOf("writeRouteCache(cacheKey, result);");
  const attachIdx = src.indexOf("return await respondRoute(result, profile);");
  assert(writeIdx > 0 && attachIdx > writeIdx);
});
