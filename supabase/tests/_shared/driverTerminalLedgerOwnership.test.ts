/**
 * Driver history may show TRIP_EARNING_NET only for the authenticated driver.
 * related_trip_id alone is not ownership.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

type LedgerRow = {
  tripId: string;
  driverId: string;
  type: string;
  amount: number;
};

type HistoryPayable = {
  payable: number | null;
  source: "terminal_ledger" | "trip_stamp" | "offer_snapshot" | null;
};

function isChargeableTerminal(trip: {
  financialOutcome?: string | null;
  arrivalApplied?: boolean;
  status?: string | null;
}): boolean {
  const outcome = String(trip.financialOutcome ?? "").toUpperCase();
  const status = String(trip.status ?? "").toLowerCase();
  return outcome === "ARRIVAL_CANCELLATION"
    || outcome === "NO_SHOW"
    || outcome === "LATE_PASSENGER_CANCELLATION"
    || trip.arrivalApplied === true
    || status === "no_show";
}

/** Same rule as both payable CASE branches in the unapplied history migration. */
function resolveDriverHistoryPayable(args: {
  requesterId: string;
  trip: {
    id: string;
    financialOutcome?: string | null;
    arrivalApplied?: boolean;
    status?: string | null;
  };
  ledger: LedgerRow[];
  nonTerminalFallback: HistoryPayable;
}): HistoryPayable {
  const own = args.ledger.find((row) =>
    row.tripId === args.trip.id
    && row.driverId === args.requesterId
    && row.type === "TRIP_EARNING_NET"
  );
  if (isChargeableTerminal(args.trip)) {
    if (!own) return { payable: null, source: null };
    return { payable: own.amount, source: "terminal_ledger" };
  }
  return args.nonTerminalFallback;
}

const T1 = {
  id: "T1",
  financialOutcome: "ARRIVAL_CANCELLATION",
  arrivalApplied: true,
  status: "cancelled",
};

const LEDGER: LedgerRow[] = [
  { tripId: "T1", driverId: "A", type: "TRIP_EARNING_NET", amount: 376 },
  { tripId: "T1", driverId: "B", type: "ADJUSTMENT", amount: 999 },
];

Deno.test("A. entitled driver sees own 376 terminal_ledger", () => {
  assertEquals(resolveDriverHistoryPayable({
    requesterId: "A",
    trip: T1,
    ledger: LEDGER,
    nonTerminalFallback: { payable: 425, source: "offer_snapshot" },
  }), { payable: 376, source: "terminal_ledger" });
});

Deno.test("B. revoked-offer driver does not receive the entitled driver's earning", () => {
  const seen = resolveDriverHistoryPayable({
    requesterId: "B",
    trip: T1,
    ledger: LEDGER,
    nonTerminalFallback: { payable: 425, source: "offer_snapshot" },
  });
  assertEquals(seen.payable, null);
  assertEquals(seen.source, null);
  assertEquals(seen.payable === 376, false);
});

Deno.test("C. rematched driver in cancelled_driver_ids does not receive the later earning", () => {
  const seen = resolveDriverHistoryPayable({
    requesterId: "B",
    trip: T1,
    ledger: LEDGER,
    nonTerminalFallback: { payable: 425, source: "trip_stamp" },
  });
  assertEquals(seen, { payable: null, source: null });
});

Deno.test("D. another driver's non-terminal row does not surface the 376 earning", () => {
  assertEquals(resolveDriverHistoryPayable({
    requesterId: "A",
    trip: T1,
    ledger: LEDGER,
    nonTerminalFallback: { payable: 425, source: "trip_stamp" },
  }), { payable: 376, source: "terminal_ledger" });
  assertEquals(resolveDriverHistoryPayable({
    requesterId: "B",
    trip: T1,
    ledger: LEDGER,
    nonTerminalFallback: { payable: 425, source: "trip_stamp" },
  }), { payable: null, source: null });
});

Deno.test("E. historical access without own TRIP_EARNING_NET is not terminal_ledger", () => {
  const seen = resolveDriverHistoryPayable({
    requesterId: "B",
    trip: T1,
    ledger: [{ tripId: "T1", driverId: "A", type: "TRIP_EARNING_NET", amount: 376 }],
    nonTerminalFallback: { payable: 425, source: "offer_snapshot" },
  });
  assertEquals(seen.source === "terminal_ledger", false);
  assertEquals(seen.payable, null);
  assertEquals(seen.payable === 425, false);
});

Deno.test("migration payable lookups are driver-scoped and terminal_ledger requires that row", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260927230000_chargeable_terminal_outcome_driver_preserve.sql", import.meta.url),
  );
  const lookups = [...sql.matchAll(/FROM public\.driver_wallet_ledger l[\s\S]*?LIMIT 1/g)].map((m) => m[0]);
  assertEquals(lookups.length, 4);
  for (const lookup of lookups) {
    assertEquals(lookup.includes("l.related_trip_id = t.id"), true);
    assertEquals(lookup.includes("l.driver_id = v_driver_id"), true);
    assertEquals(lookup.includes("l.type = 'TRIP_EARNING_NET'"), true);
  }
  assertEquals((sql.match(/THEN 'terminal_ledger'/g) ?? []).length, 2);
  assertEquals((sql.match(/IS NOT NULL\s+THEN 'terminal_ledger'/g) ?? []).length, 2);
  assertEquals(sql.includes("v_driver_id uuid := public.current_driver_id()"), true);
  assertEquals(sql.includes("WHERE l.related_trip_id = t.id\n                      AND l.type = 'TRIP_EARNING_NET'"), false);
});
