import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  actualProviderFeePence,
  aggregatePaymentSessionsMoney,
} from "./adminPaymentSessionsMoneyAggregatesSSOT.ts";

type Row = Parameters<typeof aggregatePaymentSessionsMoney>[0][number];

function row(partial: Partial<Row>): Row {
  return {
    id: crypto.randomUUID(),
    status: null,
    provider_state: null,
    authorised_amount_pence: null,
    captured_amount_pence: null,
    released_amount_pence: null,
    refunded_amount_pence: null,
    provider_processing_fee_pence: null,
    fee_status: null,
    captured_at: null,
    released_at: null,
    refunded_at: null,
    service_area_id: "sa-1",
    ...partial,
  } as Row;
}

Deno.test("captured total counts only confirmed positive captures", () => {
  const agg = aggregatePaymentSessionsMoney([
    row({ captured_amount_pence: 500, captured_at: "2026-09-01T00:00:00Z" }),
    row({ captured_amount_pence: 1200, captured_at: "2026-09-02T00:00:00Z" }),
    // zero-amount capture stamp artefact
    row({ captured_amount_pence: 0, captured_at: "2026-09-03T00:00:00Z" }),
    row({ captured_amount_pence: null, captured_at: null }),
  ]);
  assertEquals(agg.captured_count, 2);
  assertEquals(agg.captured_total_pence, 1700);
});

Deno.test("released buffer excludes zero releases on fully captured sessions", () => {
  const agg = aggregatePaymentSessionsMoney([
    // buffer release after capture
    row({
      authorised_amount_pence: 1000,
      captured_amount_pence: 800,
      released_amount_pence: 200,
      released_at: "2026-09-02T00:00:00Z",
    }),
    // finalisation artefact: released_at stamped, nothing released
    row({
      authorised_amount_pence: 500,
      captured_amount_pence: 500,
      released_amount_pence: 0,
      released_at: "2026-09-02T00:00:00Z",
    }),
  ]);
  assertEquals(agg.released_count, 1);
  assertEquals(agg.released_buffer_total_pence, 200);
});

Deno.test("refunded total ignores zero refund stamps", () => {
  const agg = aggregatePaymentSessionsMoney([
    row({ refunded_amount_pence: 266, refunded_at: "2026-09-04T00:00:00Z" }),
    row({ refunded_amount_pence: 0, refunded_at: "2026-09-04T00:00:00Z" }),
  ]);
  assertEquals(agg.refunded_count, 1);
  assertEquals(agg.refunded_total_pence, 266);
});

Deno.test("provider fees only sum ACTUAL fee evidence", () => {
  assertEquals(actualProviderFeePence({ provider_processing_fee_pence: 55, fee_status: "ACTUAL" }), 55);
  assertEquals(actualProviderFeePence({ provider_processing_fee_pence: 55, fee_status: "ESTIMATED" }), null);
  assertEquals(actualProviderFeePence({ provider_processing_fee_pence: 0, fee_status: "ACTUAL" }), null);
  const agg = aggregatePaymentSessionsMoney([
    row({ provider_processing_fee_pence: 55, fee_status: "ACTUAL" }),
    row({ provider_processing_fee_pence: 40, fee_status: "PENDING" }),
    row({ provider_processing_fee_pence: 5, fee_status: "actual" }),
  ]);
  assertEquals(agg.provider_fees_total_pence, 60);
});

Deno.test("empty scope reports null totals, never invented zero", () => {
  const agg = aggregatePaymentSessionsMoney([]);
  assertEquals(agg.captured_total_pence, null);
  assertEquals(agg.released_buffer_total_pence, null);
  assertEquals(agg.refunded_total_pence, null);
  assertEquals(agg.provider_fees_total_pence, null);
  assertEquals(agg.captured_count, 0);
});
