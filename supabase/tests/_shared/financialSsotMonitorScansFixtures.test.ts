/**
 * Fixture tests for the five financial-ssot-monitor invariant scans
 * (supabase/functions/_shared/financialSsotMonitorScans.ts):
 *
 *   1 offer_vs_committed          base fare + driver net vs the committed payable x commission
 *   2 airport_component_missing   trip has airport, newest offer snapshot has none (MK-007)
 *   3 driver_net_vs_breakdown     airport present: net != commissionable-after-commission + airport
 *   4 overlapping_waiting_open    >1 OPEN waiting segment per authoritative session
 *   5 invalid_assignment_ownership confirmed_driver_id IS DISTINCT FROM driver_id on a live trip
 *
 * Table-driven: every case is a (trip, offers) fixture with the EXACT rows expected. These are
 * pure evaluators (no DB, no network) so they run in CI without Postgres.
 *
 * Run: deno test --no-check --allow-read supabase/tests/_shared/financialSsotMonitorScansFixtures.test.ts
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateInvalidAssignmentOwnership,
  evaluateOfferInvariants,
  evaluateOverlappingWaitingOpen,
  type MonitorMismatchRow,
  type MonitorOfferRow,
  type MonitorTripRow,
} from "../../functions/_shared/financialSsotMonitorScans.ts";

const STAGES = new Set([
  "offer_vs_committed",
  "airport_component_missing",
  "driver_net_vs_breakdown",
  "overlapping_waiting_open",
  "invalid_assignment_ownership",
]);

/** The shape every row must have so the monitor can upsert on (trip_id, stage, field_name). */
function assertRowContract(rows: MonitorMismatchRow[]) {
  const keys = new Set<string>();
  for (const r of rows) {
    assert(STAGES.has(r.stage), `unknown stage ${r.stage}`);
    assert(typeof r.trip_id === "string" && r.trip_id.length > 0, "trip_id required");
    assert(typeof r.field_name === "string" && r.field_name.length > 0, "field_name required");
    assert(Number.isInteger(r.expected_pence) && Number.isInteger(r.actual_pence), "whole pence");
    const key = `${r.trip_id}|${r.stage}|${r.field_name}`;
    assert(!keys.has(key), `duplicate conflict key ${key}`);
    keys.add(key);
    const blob = JSON.stringify(r.details).toLowerCase();
    assert(!/phone|email|passenger|name/.test(blob), "details must carry no PII");
  }
}

const pick = (rows: MonitorMismatchRow[]) =>
  rows.map((r) => `${r.stage}/${r.field_name}:${r.expected_pence}->${r.actual_pence}`).sort();

function offer(over: Partial<MonitorOfferRow> & { id: string }): MonitorOfferRow {
  return {
    trip_id: "t1",
    status: "pending",
    effective_commission_percent: 10,
    offered_driver_net_pence: 432,
    offer_snapshot: { baseFarePence: 480 },
    created_at: "2026-11-13T10:00:00Z",
    ...over,
  };
}

const T480: MonitorTripRow = {
  id: "t1",
  trip_code: "MK-FIX-001",
  status: "searching",
  locked_base_fare_pence: 480,
  final_customer_fare_pence: 480,
  estimated_total_pence: 480,
};

// MK-007 Heathrow: customer payable 7300 incl. 700 airport. Driver total = (7300-700) x 0.9 + 700 = 6640.
const T_HEATHROW: MonitorTripRow = {
  ...T480,
  locked_base_fare_pence: 7300,
  final_customer_fare_pence: 7300,
  estimated_total_pence: 7300,
  airport_charge_pence: 700,
};

// Discounted MK-007: gross 7500, global_offer -200, committed payable 7300 (net of discount).
const T_HEATHROW_DISCOUNT: MonitorTripRow = {
  ...T_HEATHROW,
  locked_base_fare_pence: 7500,
  gross_fare_pence: 7500,
  discount_pence: 200,
  offer_discount_pence: 200,
  discount_source: "global_offer",
  final_customer_fare_pence: 7300,
};

type OfferCase = {
  name: string;
  trip: MonitorTripRow;
  offers: MonitorOfferRow[];
  expect: string[];
};

const OFFER_CASES: OfferCase[] = [
  {
    name: "clean committed offer -> nothing",
    trip: T480,
    offers: [offer({ id: "o1" })],
    expect: [],
  },
  {
    name: "scan 1: stale base 500 beside committed 480 AND stale net",
    trip: T480,
    offers: [offer({ id: "o1", offered_driver_net_pence: 450, offer_snapshot: { baseFarePence: 500 } })],
    expect: ["offer_vs_committed/base_fare_pence:480->500", "offer_vs_committed/driver_net_pence:432->450"],
  },
  {
    name: "scan 1: only the net is wrong (base fine)",
    trip: T480,
    offers: [offer({ id: "o1", offered_driver_net_pence: 480 })],
    expect: ["offer_vs_committed/driver_net_pence:432->480"],
  },
  {
    name: "scan 1: +/-1p tolerance on base and net",
    trip: T480,
    offers: [offer({ id: "o1", offered_driver_net_pence: 433, offer_snapshot: { baseFarePence: 481 } })],
    expect: [],
  },
  {
    name: "scan 1: 2p over tolerance is flagged",
    trip: T480,
    offers: [offer({ id: "o1", offer_snapshot: { baseFarePence: 482 } })],
    expect: ["offer_vs_committed/base_fare_pence:480->482"],
  },
  {
    name: "scan 1: base key spellings (base_fare_pence / final_trip_fare_pence)",
    trip: T480,
    offers: [
      offer({ id: "o1", offer_snapshot: { base_fare_pence: 500 } }),
    ],
    expect: ["offer_vs_committed/base_fare_pence:480->500"],
  },
  {
    name: "scan 1: no commission stored -> base checked, net not",
    trip: T480,
    offers: [offer({ id: "o1", effective_commission_percent: null, offered_driver_net_pence: 999, offer_snapshot: { baseFarePence: 500 } })],
    expect: ["offer_vs_committed/base_fare_pence:480->500"],
  },
  {
    name: "scan 1: breakdown-only trip (nothing committed) is not judged",
    trip: { id: "t1", status: "searching", fare_breakdown: { final_fare_pence: 500 } },
    offers: [offer({ id: "o1", offer_snapshot: { baseFarePence: 123 } })],
    expect: [],
  },
  {
    name: "scan 1: closed offers (expired / revoked / declined) are never scanned",
    trip: T480,
    offers: [
      offer({ id: "o1", status: "expired", offer_snapshot: { baseFarePence: 999 } }),
      offer({ id: "o2", status: "revoked", offer_snapshot: { baseFarePence: 999 } }),
      offer({ id: "o3", status: "declined", offer_snapshot: { baseFarePence: 999 } }),
    ],
    expect: [],
  },
  {
    name: "scan 1: accepted offer on a trip with a folded modification lags legitimately",
    trip: { ...T480, customer_modification_charge_pence: 120 },
    offers: [offer({ id: "o1", status: "accepted", offer_snapshot: { baseFarePence: 480 }, offered_driver_net_pence: 432 })],
    expect: [],
  },
  {
    name: "scan 1: pending offer on a modified trip IS still judged",
    trip: { ...T480, customer_modification_charge_pence: 120, final_customer_fare_pence: 600, locked_base_fare_pence: 480 },
    offers: [offer({ id: "o1", offer_snapshot: { baseFarePence: 480 }, offered_driver_net_pence: 432 })],
    expect: ["offer_vs_committed/base_fare_pence:600->480", "offer_vs_committed/driver_net_pence:540->432"],
  },
  {
    name: "scan 1: one row per (stage, field) even with several bad offers",
    trip: T480,
    offers: [
      offer({ id: "o1", offer_snapshot: { baseFarePence: 500 }, created_at: "2026-11-13T10:01:00Z" }),
      offer({ id: "o2", offer_snapshot: { baseFarePence: 520 }, created_at: "2026-11-13T10:00:00Z" }),
    ],
    expect: ["offer_vs_committed/base_fare_pence:480->500"], // newest offer wins the (stage, field) slot
  },
  {
    name: "scan 2+3 (MK-007): offer net ignored the airport and the snapshot lost it",
    trip: T_HEATHROW,
    offers: [offer({ id: "o1", offered_driver_net_pence: 6570, offer_snapshot: { baseFarePence: 7300 } })],
    expect: [
      "airport_component_missing/offer_snapshot_airport_charge_pence:700->0",
      "driver_net_vs_breakdown/offered_driver_net_pence:6640->6570",
      "offer_vs_committed/driver_net_pence:6640->6570",
    ],
  },
  {
    name: "scan 2+3 (MK-007): correct airport offer -> nothing",
    trip: T_HEATHROW,
    offers: [offer({
      id: "o1",
      offered_driver_net_pence: 6640,
      offer_snapshot: { baseFarePence: 7300, airport_charge_pence: 700, airport_charge_state: "present" },
    })],
    expect: [],
  },
  {
    name: "scan 3: airport double-counted in the net (6640 + 700)",
    trip: T_HEATHROW,
    offers: [offer({
      id: "o1",
      offered_driver_net_pence: 7340,
      offer_snapshot: { baseFarePence: 7300, airport_charge_pence: 700, airport_charge_state: "present" },
    })],
    expect: ["driver_net_vs_breakdown/offered_driver_net_pence:6640->7340", "offer_vs_committed/driver_net_pence:6640->7340"],
  },
  {
    name: "scan 2: state=present without an amount is not 'missing'",
    trip: T_HEATHROW,
    offers: [offer({
      id: "o1",
      offered_driver_net_pence: 6640,
      offer_snapshot: { baseFarePence: 7300, airport_charge_state: "present" },
    })],
    expect: [],
  },
  {
    name: "scan 2: only the NEWEST offer is judged for a missing airport",
    trip: T_HEATHROW,
    offers: [
      offer({ id: "old", created_at: "2026-11-13T09:00:00Z", offered_driver_net_pence: 6640,
        offer_snapshot: { baseFarePence: 7300 } }),
      offer({ id: "new", created_at: "2026-11-13T10:00:00Z", offered_driver_net_pence: 6640,
        offer_snapshot: { baseFarePence: 7300, airport_charge_pence: 700, airport_charge_state: "present" } }),
    ],
    expect: [],
  },
  {
    name: "MK-007 discounted: correct driver total 6640 on payable 7300 (commissionable 6600) -> nothing",
    trip: T_HEATHROW_DISCOUNT,
    offers: [offer({
      id: "o1",
      offered_driver_net_pence: 6640,
      offer_snapshot: { baseFarePence: 7300, airport_charge_pence: 700, airport_charge_state: "present" },
    })],
    expect: [],
  },
  {
    name: "MK-007 discounted: commissionable stamped on the ungrossed ride (6800) is flagged",
    trip: T_HEATHROW_DISCOUNT,
    offers: [offer({
      id: "o1",
      offered_driver_net_pence: 6820, // (7500 - 700) x 0.9 + 700
      offer_snapshot: { baseFarePence: 7300, airport_charge_pence: 700, airport_charge_state: "present" },
    })],
    expect: ["driver_net_vs_breakdown/offered_driver_net_pence:6640->6820", "offer_vs_committed/driver_net_pence:6640->6820"],
  },
];

for (const c of OFFER_CASES) {
  Deno.test(`offer scans: ${c.name}`, () => {
    const rows = evaluateOfferInvariants(c.trip, c.offers);
    assertRowContract(rows);
    assertEquals(pick(rows), [...c.expect].sort());
  });
}

Deno.test("offer scans: rows carry trip identity + offer id and no PII", () => {
  const rows = evaluateOfferInvariants(T_HEATHROW, [offer({
    id: "o-77", offered_driver_net_pence: 6570, offer_snapshot: { baseFarePence: 7300 },
  })]);
  assert(rows.length > 0);
  for (const r of rows) {
    assertEquals(r.trip_id, "t1");
    assertEquals(r.trip_code, "MK-FIX-001");
    assertEquals(r.details.offer_id, "o-77");
    assertEquals(r.details.trip_status, "searching");
  }
});

// --------------------------------------------------------------------------- scan 4
Deno.test("scan 4 overlapping_waiting_open: table of segment fixtures", () => {
  const cases: Array<{ name: string; segs: Parameters<typeof evaluateOverlappingWaitingOpen>[0]; expect: string[] }> = [
    { name: "one open pickup", segs: [{ trip_id: "t1", location_type: "pickup", ended_at: null }], expect: [] },
    {
      name: "two open pickup segments",
      segs: [{ trip_id: "t1", location_type: "pickup", ended_at: null }, { trip_id: "t1", location_type: "pickup", ended_at: null }],
      expect: ["t1|open_segments:pickup|2"],
    },
    {
      name: "three open pickup segments",
      segs: [1, 2, 3].map(() => ({ trip_id: "t1", location_type: "pickup", ended_at: null })),
      expect: ["t1|open_segments:pickup|3"],
    },
    {
      name: "pickup + stop sessions are separate sessions (one open each is fine)",
      segs: [
        { trip_id: "t1", location_type: "pickup", ended_at: null },
        { trip_id: "t1", location_type: "stop", stop_id: "s1", ended_at: null },
        { trip_id: "t1", location_type: "stop", stop_id: "s2", ended_at: null },
      ],
      expect: [],
    },
    {
      name: "two open on the SAME stop",
      segs: [
        { trip_id: "t1", location_type: "stop", stop_id: "s1", ended_at: null },
        { trip_id: "t1", location_type: "stop", stop_id: "s1", ended_at: null },
      ],
      expect: ["t1|open_segments:stop:s1|2"],
    },
    {
      name: "closed segments never count",
      segs: [
        { trip_id: "t1", location_type: "pickup", ended_at: "2026-11-13T10:00:00Z" },
        { trip_id: "t1", location_type: "pickup", ended_at: "2026-11-13T10:05:00Z" },
        { trip_id: "t1", location_type: "pickup", ended_at: null },
      ],
      expect: [],
    },
    {
      name: "different trips never merge",
      segs: [{ trip_id: "t1", location_type: "pickup", ended_at: null }, { trip_id: "t2", location_type: "pickup", ended_at: null }],
      expect: [],
    },
    {
      name: "stop without id groups under stop:none",
      segs: [{ trip_id: "t1", location_type: "stop", ended_at: null }, { trip_id: "t1", location_type: "stop", ended_at: null }],
      expect: ["t1|open_segments:stop:none|2"],
    },
  ];
  for (const c of cases) {
    const rows = evaluateOverlappingWaitingOpen(c.segs);
    assertRowContract(rows);
    assertEquals(
      rows.map((r) => `${r.trip_id}|${r.field_name}|${r.actual_pence}`).sort(),
      c.expect,
      c.name,
    );
    for (const r of rows) {
      assertEquals(r.stage, "overlapping_waiting_open");
      assertEquals(r.expected_pence, 1);
    }
  }
});

Deno.test("scan 4: trip codes are attached from the lookup map", () => {
  const rows = evaluateOverlappingWaitingOpen(
    [{ trip_id: "t1", location_type: "pickup", ended_at: null }, { trip_id: "t1", location_type: "pickup", ended_at: null }],
    new Map([["t1", "MK-FIX-009"]]),
  );
  assertEquals(rows[0].trip_code, "MK-FIX-009");
});

// --------------------------------------------------------------------------- scan 5
Deno.test("scan 5 invalid_assignment_ownership: table of trip fixtures", () => {
  const live = ["assigned", "en_route", "arrived", "in_progress"];
  for (const status of live) {
    const rows = evaluateInvalidAssignmentOwnership([
      { id: "x", status, driver_id: "d1", confirmed_driver_id: "d2" },
      { id: "y", status, driver_id: null, confirmed_driver_id: "d2" },
      { id: "z", status, driver_id: "d1", confirmed_driver_id: null },
      { id: "ok1", status, driver_id: "d1", confirmed_driver_id: "d1" },
      { id: "ok2", status, driver_id: null, confirmed_driver_id: null },
    ]);
    assertRowContract(rows);
    assertEquals(rows.map((r) => r.trip_id).sort(), ["x", "y", "z"], `status ${status}`);
  }
  const notLive = ["searching", "searching_new_driver", "negotiating", "completed", "cancelled", "customer_cancelled", "scheduled"];
  for (const status of notLive) {
    assertEquals(
      evaluateInvalidAssignmentOwnership([{ id: "x", status, driver_id: "d1", confirmed_driver_id: "d2" }]),
      [],
      `status ${status} must not be scanned`,
    );
  }
});

Deno.test("scan 5: row shape carries presence flags only (no driver ids / PII)", () => {
  const [row] = evaluateInvalidAssignmentOwnership([
    { id: "x", trip_code: "MK-FIX-005", status: "assigned", driver_id: "driver-secret-1", confirmed_driver_id: "driver-secret-2" },
  ]);
  assertEquals(row.stage, "invalid_assignment_ownership");
  assertEquals(row.field_name, "confirmed_driver_id_vs_driver_id");
  assertEquals(row.trip_code, "MK-FIX-005");
  assertEquals(row.details, { trip_status: "assigned", confirmed_driver_id_present: true, driver_id_present: true });
  assert(!JSON.stringify(row).includes("driver-secret"));
});

Deno.test("all five stages together: rows from one pass stay unique on (trip_id, stage, field_name)", () => {
  const rows = [
    ...evaluateOfferInvariants(T_HEATHROW, [offer({ id: "o1", offered_driver_net_pence: 6570, offer_snapshot: { baseFarePence: 7300 } })]),
    ...evaluateOverlappingWaitingOpen([
      { trip_id: "t1", location_type: "pickup", ended_at: null },
      { trip_id: "t1", location_type: "pickup", ended_at: null },
    ]),
    ...evaluateInvalidAssignmentOwnership([{ id: "t1", status: "assigned", driver_id: "a", confirmed_driver_id: "b" }]),
  ];
  assertRowContract(rows);
  assertEquals(new Set(rows.map((r) => r.stage)), STAGES);
});
