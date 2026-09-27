/**
 * Chargeable terminal outcomes — classification, entitlement, idempotent TEN.
 * Historical trips are not mutated here.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  postTerminalEntitlementFromSettlement,
  TERMINAL_FEE_LEDGER_TYPE,
} from "../../functions/_shared/terminalOutcomeEntitlementSSOT.ts";
import {
  resolveTerminalEntitledDriverId,
  resolveTerminalOutcomeKind,
} from "../../functions/_shared/terminalFeeSettlementResumptionSSOT.ts";

const EVIDENCE = {
  payment_session_id: "ps-1",
  captured_pence: 400,
  provider_fee_pence: 24,
  provider_fee_confirmed: true,
};

type LedgerRow = {
  id: string;
  driver_id: string;
  related_trip_id: string;
  type: string;
  amount_pence: number;
};

function ledgerFake() {
  const rows: LedgerRow[] = [];
  let inserts = 0;
  const supabase = {
    from(table: string) {
      if (table !== "driver_wallet_ledger") {
        throw new Error(`unexpected table ${table}`);
      }
      const filters: Record<string, string> = {};
      const api = {
        select() {
          return api;
        },
        eq(key: string, value: string) {
          filters[key] = value;
          return api;
        },
        in() {
          const matched = rows.filter((row) => {
            if (filters.related_trip_id && row.related_trip_id !== filters.related_trip_id) return false;
            return true;
          });
          return Promise.resolve({ data: matched.map((row) => ({ type: row.type, id: row.id })) });
        },
        maybeSingle() {
          const matched = rows.find((row) =>
            row.related_trip_id === filters.related_trip_id && row.type === filters.type
          );
          return Promise.resolve({ data: matched ? { id: matched.id, type: matched.type } : null });
        },
        insert(row: Omit<LedgerRow, "id">) {
          inserts += 1;
          const duplicate = rows.some((existing) =>
            existing.related_trip_id === row.related_trip_id && existing.type === row.type
          );
          if (duplicate) return Promise.resolve({ error: { code: "23505" } });
          rows.push({ id: `row-${rows.length + 1}`, ...row });
          return Promise.resolve({ error: null });
        },
      };
      return api;
    },
  };
  return { supabase: supabase as never, rows, insertCount: () => inserts };
}

Deno.test("entitled driver survives after active assignment is cleared", () => {
  assertEquals(resolveTerminalEntitledDriverId({
    confirmed_driver_id: "driver-b",
    driver_id: "driver-b",
    previous_driver_id: "driver-a",
  }), "driver-b");
  assertEquals(resolveTerminalEntitledDriverId({
    confirmed_driver_id: null,
    driver_id: null,
    previous_driver_id: "driver-b",
  }), "driver-b");
});

Deno.test("CANCELLED_WITH_FEE is not late or arrival for settlement", () => {
  assertEquals(resolveTerminalOutcomeKind({
    financial_outcome: "CANCELLED_WITH_FEE",
    status: "cancelled",
    cancellation_fee_pence: 400,
    payment_status: "captured",
  }), null);
  assertEquals(resolveTerminalOutcomeKind({
    financial_outcome: "ARRIVAL_CANCELLATION",
    status: "cancelled",
  }), "ARRIVAL_CANCELLATION");
  assertEquals(resolveTerminalOutcomeKind({
    financial_outcome: "NO_SHOW",
    status: "no_show",
  }), "NO_SHOW");
  assertEquals(resolveTerminalOutcomeKind({
    financial_outcome: "LATE_PASSENGER_CANCELLATION",
    status: "cancelled",
  }), "LATE_PASSENGER_CANCELLATION");
  assertEquals(resolveTerminalOutcomeKind({
    financial_outcome: "COMPLETED",
    status: "completed",
  }), null);
  assertEquals(resolveTerminalOutcomeKind({
    financial_outcome: "CANCELLED_NO_FEE",
    status: "cancelled",
  }), null);
});

Deno.test("arrival, no-show and late each post one 376p TRIP_EARNING_NET", async () => {
  for (const outcome of ["ARRIVAL_CANCELLATION", "NO_SHOW", "LATE_PASSENGER_CANCELLATION"] as const) {
    const fake = ledgerFake();
    const first = await postTerminalEntitlementFromSettlement({
      supabase: fake.supabase,
      tripId: `trip-${outcome}`,
      driverId: "driver-b",
      outcome,
      currency: "GBP",
      evidence: EVIDENCE,
    });
    const second = await postTerminalEntitlementFromSettlement({
      supabase: fake.supabase,
      tripId: `trip-${outcome}`,
      driverId: "driver-b",
      outcome,
      currency: "GBP",
      evidence: EVIDENCE,
    });
    assertEquals(first.credited, true);
    assertEquals(first.entitlement_pence, 376);
    assertEquals(first.ledger_type, TERMINAL_FEE_LEDGER_TYPE);
    assertEquals(second.credited, true);
    assertEquals(fake.rows.filter((row) => row.type === "TRIP_EARNING_NET").length, 1);
    assertEquals(fake.rows.some((row) => row.type === "DRIVER_COMPENSATION_CREDIT"), false);
    assertEquals(fake.rows.some((row) => row.type === "NO_SHOW_FEE"), false);
    assertEquals(fake.rows[0].amount_pence, 376);
    assertEquals(fake.rows[0].driver_id, "driver-b");
  }
});

Deno.test("poster source does not insert the rejected no-show ledger types", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/terminalOutcomeEntitlementSSOT.ts", import.meta.url),
  );
  assertEquals(src.includes('type: "NO_SHOW_FEE"'), false);
  assertEquals(src.includes('? "DRIVER_COMPENSATION_CREDIT"'), false);
  assertEquals(src.includes("TERMINAL_FEE_LEDGER_TYPE"), true);
});

Deno.test("cancel-trip persists arrival outcome and previous driver before settlement", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/cancel-trip/index.ts", import.meta.url),
  );
  assertEquals(src.includes('financialOutcome = "ARRIVAL_CANCELLATION"'), true);
  assertEquals(src.includes('financialOutcome = "LATE_PASSENGER_CANCELLATION"'), true);
  assertEquals(src.includes("previous_driver_id"), true);
  assertEquals(src.includes("creditsDriverWallet"), false);
  assertEquals(src.includes("maybeResumeTerminalFeeSettlementAfterProviderFee"), true);
});
