/**
 * Waiting SSOT lock — MK-261002-004.
 *
 * A trusted-location pause followed by a re-open overwrote
 * pickup_waiting_counted_seconds with 0 (the "first open segment" shortcut),
 * and cancel-trip decided CANCELLED_NO_FEE from that cache although the
 * segments held 244.505 s. Counted waiting is the segment sum, evaluated at an
 * explicit timestamp; it never resets on re-open and an unreadable sum is
 * never 0.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  closeOpenWaitingSegments,
  finalizeWaitingSegmentsAtTerminal,
  resolveCanonicalWaitingSeconds,
  sumSegmentSecondsAt,
  syncWaitingGeofenceClock,
  WAITING_EVIDENCE_UNAVAILABLE,
  WaitingEvidenceUnavailableError,
} from "../../functions/_shared/waitingSegmentClock.ts";
import { createFakeDb, INCIDENT_CANCELLED_AT, INCIDENT_SEGMENTS } from "./waitingSsotFakeDb.ts";

const TRIP = "5ece2be1-dee0-4109-adef-ff9c49f9a004";
const DRIVER = "driver-mk261002004";
const PICKUP = { lat: 52.0406, lng: -0.7594 };
const TARGET = { lat: PICKUP.lat, lng: PICKUP.lng, radiusMeters: 150, radiusEnabled: true };

/** A fresh trusted driver_presence fix at `lat` (pickup lng). */
function presenceAt(lat: number, atIso: string) {
  return {
    driver_id: DRIVER,
    lat,
    lng: PICKUP.lng,
    last_gps_sample_at: atIso,
    last_location_at: null,
    last_heartbeat_at: null,
    updated_at: atIso,
  };
}

function seededDb(segments = INCIDENT_SEGMENTS, cached = 0, opts = {}) {
  return createFakeDb({
    trip_waiting_segments: segments.map((s, i) => ({
      id: `seg-${i + 1}`,
      trip_id: TRIP,
      location_type: "pickup",
      stop_id: null,
      ...s,
    })),
    trips: [{ id: TRIP, pickup_waiting_counted_seconds: cached, stop_waiting_counted_seconds: 0 }],
  }, opts);
}

const failSum = (table: string, cols: string) =>
  table === "trip_waiting_segments" && cols === "started_at, ended_at";

Deno.test("replay: incident segments sum to 244.505 s → canonical 244 at cancelled_at", async () => {
  const atMs = Date.parse(INCIDENT_CANCELLED_AT);
  assertEquals(sumSegmentSecondsAt(INCIDENT_SEGMENTS, atMs), 244);
  const db = seededDb(INCIDENT_SEGMENTS, 0);
  const r = await resolveCanonicalWaitingSeconds(db.client, {
    tripId: TRIP,
    locationType: "pickup",
    atIso: INCIDENT_CANCELLED_AT,
  });
  assert(r.ok);
  assertEquals(r.countedSeconds, 244);
  assertEquals(r.countedSeconds >= 180, true);
  assertEquals(r.segmentCount, 3);
  assertEquals(r.openSegmentCount, 1);
  // The cached counter (0) is not consulted.
  assertEquals(db.tables.trips[0].pickup_waiting_counted_seconds, 0);
});

Deno.test("resolver never counts time after the evaluation timestamp", () => {
  const atMs = Date.parse(INCIDENT_CANCELLED_AT);
  const withLater = [
    ...INCIDENT_SEGMENTS.slice(0, 2),
    { started_at: "2026-10-02T10:12:08.120Z", ended_at: "2026-10-02T10:20:00.000Z" },
    { started_at: "2026-10-02T10:13:00.000Z", ended_at: null },
  ];
  assertEquals(sumSegmentSecondsAt(withLater, atMs), 244);
  assertEquals(sumSegmentSecondsAt(withLater, Date.parse("2026-10-02T10:10:00.000Z")), 143);
});

Deno.test("resolver sums milliseconds before flooring (a pause never drops a partial second)", () => {
  const rows = [
    { started_at: "2026-10-02T09:00:00.000Z", ended_at: "2026-10-02T09:00:00.600Z" },
    { started_at: "2026-10-02T09:00:01.000Z", ended_at: "2026-10-02T09:00:01.600Z" },
  ];
  assertEquals(sumSegmentSecondsAt(rows, Date.parse("2026-10-02T09:01:00.000Z")), 1);
});

Deno.test("resolver fails closed: unreadable segments are not 0", async () => {
  const db = seededDb(INCIDENT_SEGMENTS, 0, { failSelect: failSum });
  const r = await resolveCanonicalWaitingSeconds(db.client, {
    tripId: TRIP,
    locationType: "pickup",
    atIso: INCIDENT_CANCELLED_AT,
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "segment_query_failed");
  const bad = await resolveCanonicalWaitingSeconds(db.client, {
    tripId: TRIP,
    locationType: "pickup",
    atIso: "not-a-time",
  });
  assertEquals(bad.ok, false);
});

Deno.test("monotonicity: 170 s → pause → re-open stays ≥ 170 s, never 0", async () => {
  const db = createFakeDb({
    trip_waiting_segments: [],
    trips: [{ id: TRIP, pickup_waiting_counted_seconds: 0 }],
  });
  const t0 = Date.parse("2026-10-02T09:00:00.000Z");
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  // Trusted presence drives inside/outside, as in production: a fresh fix
  // ~1.1 km from pickup is the trusted-location pause.
  const tick = (s: number, isInside: boolean) => {
    db.tables.driver_presence = [presenceAt(isInside ? PICKUP.lat : PICKUP.lat + 0.01, at(s))];
    return syncWaitingGeofenceClock(db.client, {
      tripId: TRIP,
      driverId: DRIVER,
      locationType: "pickup",
      target: TARGET,
      nowIso: at(s),
    });
  };

  const seen: number[] = [];
  const record = async (s: number, isInside: boolean) => {
    const r = await tick(s, isInside);
    assertEquals(r.evidenceComplete, true);
    seen.push(r.countedSeconds);
    assertEquals(db.tables.trips[0].pickup_waiting_counted_seconds, r.countedSeconds);
    return r;
  };

  await record(0, true);
  const before = await record(170, true);
  assertEquals(before.countedSeconds, 170);
  const paused = await record(172.5, false);
  assertEquals(paused.status, "paused");
  assertEquals(paused.countedSeconds, 172);
  const reopened = await record(190, true);
  assertEquals(reopened.status, "counting");
  assertEquals(db.tables.trip_waiting_segments.filter((r) => r.ended_at === null).length, 1);
  assertEquals(reopened.countedSeconds, 172);
  const later = await record(200, true);
  assertEquals(later.countedSeconds, 182);

  for (let i = 1; i < seen.length; i++) assert(seen[i] >= seen[i - 1], `decreased at ${i}: ${seen}`);
  assertEquals(db.tables.trip_waiting_segments.length, 2);
});

Deno.test("sync: unreadable sum keeps the cached counter (no 0 write) and flags evidence", async () => {
  const db = seededDb(INCIDENT_SEGMENTS.slice(0, 2), 241, { failSelect: failSum });
  db.tables.driver_presence = [presenceAt(PICKUP.lat, "2026-10-02T10:12:08.120Z")];
  const r = await syncWaitingGeofenceClock(db.client, {
    tripId: TRIP,
    driverId: DRIVER,
    locationType: "pickup",
    target: TARGET,
    nowIso: "2026-10-02T10:12:08.120Z",
  });
  assertEquals(r.inside, true);
  assertEquals(r.evidenceComplete, false);
  assertEquals(r.countedSeconds, 241);
  assertEquals(db.tables.trips[0].pickup_waiting_counted_seconds, 241);
  const counterWrites = db.writes.filter((w) =>
    w.table === "trips" && "pickup_waiting_counted_seconds" in w.payload
  );
  assertEquals(counterWrites.length, 0);
});

Deno.test("close: unreadable sum throws WAITING_EVIDENCE_UNAVAILABLE and writes no 0", async () => {
  const db = seededDb(INCIDENT_SEGMENTS, 241, { failSelect: failSum });
  const err = await assertRejects(
    () => closeOpenWaitingSegments(db.client, { tripId: TRIP, locationType: "pickup", nowIso: INCIDENT_CANCELLED_AT }),
    WaitingEvidenceUnavailableError,
  );
  assertEquals((err as WaitingEvidenceUnavailableError).code, WAITING_EVIDENCE_UNAVAILABLE);
  assertEquals(db.tables.trips[0].pickup_waiting_counted_seconds, 241);
});

Deno.test("terminal finalize: closes the open segment at cancelled_at, idempotent, no duplicates", async () => {
  const db = seededDb(INCIDENT_SEGMENTS, 0);
  const closedBefore = db.tables.trip_waiting_segments
    .filter((r) => r.ended_at != null)
    .map((r) => ({ ...r }));

  const first = await finalizeWaitingSegmentsAtTerminal(db.client, {
    tripId: TRIP,
    locationType: "pickup",
    atIso: INCIDENT_CANCELLED_AT,
  });
  assert(first.ok);
  assertEquals(first.closedSegments, 1);
  assertEquals(first.countedSeconds, 244);
  assertEquals(db.tables.trip_waiting_segments.find((r) => r.id === "seg-3")?.ended_at, INCIDENT_CANCELLED_AT);
  assertEquals(db.tables.trips[0].pickup_waiting_counted_seconds, 244);

  const second = await finalizeWaitingSegmentsAtTerminal(db.client, {
    tripId: TRIP,
    locationType: "pickup",
    atIso: "2026-10-02T10:30:00.000Z",
  });
  assert(second.ok);
  assertEquals(second.closedSegments, 0);
  assertEquals(db.tables.trip_waiting_segments.length, 3);
  assertEquals(db.tables.trip_waiting_segments.find((r) => r.id === "seg-3")?.ended_at, INCIDENT_CANCELLED_AT);
  for (const row of closedBefore) {
    assertEquals(db.tables.trip_waiting_segments.find((r) => r.id === row.id), row);
  }
  assertEquals(db.writes.filter((w) => w.op === "insert").length, 0);
});

Deno.test("terminal finalize: a segment opened after the decision is clamped (time-order check)", async () => {
  const db = seededDb([
    INCIDENT_SEGMENTS[0],
    { started_at: "2026-10-02T10:12:20.000Z", ended_at: null },
  ], 0);
  const r = await finalizeWaitingSegmentsAtTerminal(db.client, {
    tripId: TRIP,
    locationType: "pickup",
    atIso: INCIDENT_CANCELLED_AT,
  });
  assert(r.ok);
  const late = db.tables.trip_waiting_segments.find((s) => s.id === "seg-2")!;
  assertEquals(late.ended_at, "2026-10-02T10:12:20.000Z");
  assertEquals(r.countedSeconds, 196);
});

Deno.test("terminal finalize: unreadable segments fail closed without touching the cache", async () => {
  const db = seededDb(INCIDENT_SEGMENTS, 0, {
    failSelect: (t: string, c: string) => t === "trip_waiting_segments" && c === "id, started_at",
  });
  const r = await finalizeWaitingSegmentsAtTerminal(db.client, {
    tripId: TRIP,
    locationType: "pickup",
    atIso: INCIDENT_CANCELLED_AT,
  });
  assertEquals(r.ok, false);
  assertEquals(db.writes.length, 0);
});

Deno.test("source lock: re-open shortcut and error-blind sums are absent", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/waitingSegmentClock.ts", import.meta.url),
  );
  assertEquals(/openedFresh\s*&&\s*!open/.test(src), false);
  assertEquals(/countedSeconds\s*=\s*segmentDurationSeconds\(\s*nowIso\s*,\s*null/.test(src), false);
  assertEquals(/const\s*\{\s*data:\s*allSegs\s*\}\s*=\s*await\s+sumQuery/.test(src), false);
  assertEquals(src.includes("resolveCanonicalWaitingSeconds"), true);
});

Deno.test("source lock: every bundle carrying the waiting clock imports the one patched file", async () => {
  const fnRoot = new URL("../../functions/", import.meta.url);
  const clockPath = new URL("_shared/waitingSegmentClock.ts", fnRoot).pathname;
  const importRe = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;
  const closure = async (entry: URL): Promise<Set<string>> => {
    const seen = new Set<string>();
    const stack = [entry.pathname];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      let text: string;
      try {
        text = await Deno.readTextFile(p);
      } catch {
        continue;
      }
      seen.add(p);
      for (const m of text.matchAll(importRe)) {
        stack.push(new URL(m[1], `file://${p}`).pathname);
      }
    }
    return seen;
  };

  const carriers: string[] = [];
  for await (const entry of Deno.readDir(fnRoot)) {
    if (!entry.isDirectory || entry.name.startsWith("_")) continue;
    const index = new URL(`${entry.name}/index.ts`, fnRoot);
    try {
      await Deno.stat(index);
    } catch {
      continue;
    }
    if ((await closure(index)).has(clockPath)) carriers.push(entry.name);
  }
  for (const fn of ["stop-workflow", "tick-pickup-waiting-charge", "pickup-no-show", "tick-waiting-charge"]) {
    assert(carriers.includes(fn), `${fn} must bundle _shared/waitingSegmentClock.ts (got ${carriers})`);
  }

  // No vendored copy of the clock anywhere under supabase/functions.
  const copies: string[] = [];
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      const child = new URL(e.isDirectory ? `${e.name}/` : e.name, dir);
      if (e.isDirectory) await walk(child);
      else if (e.name.endsWith(".ts")) {
        const t = await Deno.readTextFile(child);
        if (/export\s+async\s+function\s+syncWaitingGeofenceClock\b/.test(t)) copies.push(child.pathname);
      }
    }
  };
  await walk(fnRoot);
  assertEquals(copies, [clockPath]);
});
