/**
 * Lock: FR receivable position — outstanding, recovered, unresolved shortfalls,
 * approved write-offs; pre-ledger shortfalls kept separate.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCustomerReceivablePosition } from "./customerReceivablePositionSSOT.ts";

Deno.test("production shape: 36p recovered, 587p pre-ledger, nothing unresolved", () => {
  const pos = buildCustomerReceivablePosition({
    receivables: [
      { id: "r1", source_trip_id: "mk012", status: "SETTLED", original_amount_pence: 30, outstanding_amount_pence: 0 },
      { id: "r2", source_trip_id: "mk017", status: "SETTLED", original_amount_pence: 6, outstanding_amount_pence: 0 },
    ],
    exceptions: [],
    shortfallSessions: [
      { trip_id: "mk012", status: "captured", created_at: "2026-09-23T10:00:00Z", metadata: { shortfall_pence: 30 } },
      { trip_id: "mk017", status: "PARTIAL_CAPTURE_ONLY", created_at: "2026-09-23T11:00:00Z", metadata: { shortfall_pence: 6 } },
      ...[50, 139, 50, 50, 50, 50, 111, 87].map((p, i) => ({
        trip_id: `aug-${i}`,
        status: "captured",
        provider_state: "CAPTURED",
        created_at: "2026-08-08T10:00:00Z",
        metadata: { shortfall_pence: p },
      })),
      { trip_id: "cancelled", status: "cancelled", provider_state: "CANCELLED", created_at: "2026-07-16T10:00:00Z", metadata: { shortfall_pence: 299 } },
    ],
  });
  assertEquals(pos.outstanding_pence, 0);
  assertEquals(pos.recovered_pence, 36);
  assertEquals(pos.recovered_count, 2);
  assertEquals(pos.unresolved_shortfall_pence, 0);
  assertEquals(pos.written_off_pence, 0);
  assertEquals(pos.legacy_pre_ledger_shortfall_pence, 587);
  assertEquals(pos.legacy_pre_ledger_shortfall_count, 8);
});

Deno.test("outstanding, manual review and partial recovery", () => {
  const pos = buildCustomerReceivablePosition({
    receivables: [
      { id: "a", source_trip_id: "t1", status: "OPEN", original_amount_pence: 40, outstanding_amount_pence: 40 },
      { id: "b", source_trip_id: "t2", status: "RESERVED", original_amount_pence: 25, outstanding_amount_pence: 25 },
      { id: "c", source_trip_id: "t3", status: "MANUAL_REVIEW", original_amount_pence: 50, outstanding_amount_pence: 20 },
    ],
    exceptions: [],
    shortfallSessions: [],
  });
  assertEquals(pos.outstanding_pence, 65);
  assertEquals(pos.outstanding_count, 2);
  assertEquals(pos.manual_review_pence, 20);
  assertEquals(pos.recovered_pence, 30);
});

Deno.test("open exception and unrecorded in-ledger marker are unresolved; resolved exception is not double counted", () => {
  const pos = buildCustomerReceivablePosition({
    receivables: [
      { id: "r", source_trip_id: "t-resolved", status: "OPEN", original_amount_pence: 12, outstanding_amount_pence: 12 },
    ],
    exceptions: [
      { id: "e1", trip_id: "t-open", status: "OPEN", shortfall_pence: 40 },
      { id: "e2", trip_id: "t-resolved", status: "RESOLVED_RECEIVABLE_RECORDED", shortfall_pence: 12, receivable_id: "r" },
    ],
    shortfallSessions: [
      { trip_id: "t-open", created_at: "2026-10-14T10:00:00Z", metadata: { shortfall_pence: 40 } },
      { trip_id: "t-resolved", created_at: "2026-10-14T10:00:00Z", metadata: { shortfall_pence: 12 } },
      { trip_id: "t-lost", created_at: "2026-10-14T10:00:00Z", metadata: { shortfall_pence: 9 } },
      { trip_id: "t-lost", created_at: "2026-10-14T10:05:00Z", metadata: { shortfall_pence: 9 } },
    ],
  });
  assertEquals(pos.unresolved_shortfall_pence, 49);
  assertEquals(pos.unresolved_shortfall_count, 2);
  assertEquals(pos.unresolved_shortfall_trip_ids, ["t-lost", "t-open"]);
  assertEquals(pos.outstanding_pence, 12);
});

Deno.test("approved write-offs: written-off exceptions and waived receivables", () => {
  const pos = buildCustomerReceivablePosition({
    receivables: [
      { id: "w", source_trip_id: "t1", status: "WAIVED", original_amount_pence: 15, outstanding_amount_pence: 0 },
    ],
    exceptions: [{ id: "e", trip_id: "t2", status: "WRITTEN_OFF", shortfall_pence: 40 }],
    shortfallSessions: [{ trip_id: "t2", created_at: "2026-10-14T10:00:00Z", metadata: { shortfall_pence: 40 } }],
  });
  assertEquals(pos.written_off_pence, 55);
  assertEquals(pos.written_off_count, 2);
  const doubled = buildCustomerReceivablePosition({
    receivables: [
      { id: "w", source_trip_id: "t1", status: "WAIVED", original_amount_pence: 15, outstanding_amount_pence: 0 },
    ],
    exceptions: [{ id: "e", trip_id: "t1", status: "WRITTEN_OFF", shortfall_pence: 15 }],
    shortfallSessions: [],
  });
  assertEquals(doubled.written_off_pence, 15);
  assertEquals(doubled.written_off_count, 1);
  assertEquals(pos.unresolved_shortfall_pence, 0);
  assertEquals(pos.recovered_pence, 0);
});

Deno.test("exceptions table unavailable: flagged, markers still detected", () => {
  const pos = buildCustomerReceivablePosition({
    receivables: [],
    exceptions: null,
    shortfallSessions: [{ trip_id: "t", created_at: "2026-10-14T10:00:00Z", metadata: { shortfall_pence: 7 } }],
  });
  assertEquals(pos.exceptions_ledger_available, false);
  assertEquals(pos.unresolved_shortfall_pence, 7);
});
