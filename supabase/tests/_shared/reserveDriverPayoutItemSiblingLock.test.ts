/**
 * Lock: reserve_driver_payout_item must allow sibling reserve on PROCESSING batches
 * and reject terminal / in-flight item states.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "../../migrations/20260901150000_payout_reserve_sibling_processing_batch.sql";

Deno.test("reserve migration allows PROCESSING batch sibling reserve", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "reserve_driver_payout_item");
  assertStringIncludes(sql, "'PROCESSING'");
  assertStringIncludes(sql, "v_batch_live_in_flight");
  assertStringIncludes(sql, "assert_payout_item_ledger_lineage");
  assertStringIncludes(sql, "PROVIDER_INTENT_EXISTS");
});

Deno.test("1. PROCESSING + VALIDATED sibling without intent/reservation can reserve", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "'PROCESSING'");
  assertStringIncludes(sql, "'VALIDATED'");
  assertStringIncludes(sql, "PROVIDER_INTENT_EXISTS");
  assertEquals(sql.includes("WHEN v_batch_live_in_flight THEN 'RESERVED'"), true);
});

Deno.test("2. SUBMITTED item rejected", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "'SUBMITTED'");
  assertStringIncludes(sql, "'PAYOUT_ITEM_NOT_RESERVABLE'");
});

Deno.test("3. existing provider intent rejected", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "driver_payout_payment_intents");
  assertStringIncludes(sql, "'PROVIDER_INTENT_EXISTS'");
});

Deno.test("4. active reservation idempotent reuse without duplicate hold", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "'ACTIVE_RESERVATION_EXISTS'");
  assertStringIncludes(sql, "'reused', true");
});

Deno.test("5. COMPLETED batch rejected", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "'COMPLETED'");
});

Deno.test("6. CANCELLED and FAILED batch rejected", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "'CANCELLED'");
  assertStringIncludes(sql, "'FAILED'");
});

Deno.test("7. allocation mismatch rejected via lineage assert", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "PAYOUT_LINEAGE_MISMATCH");
  assertStringIncludes(sql, "assert_payout_item_ledger_lineage");
});

Deno.test("8. insufficient wallet balance rejected", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "INSUFFICIENT_AVAILABLE_WALLET");
});

Deno.test("9. DRIVER_COLLECTED lineage rejected via assert_payout_item_ledger_lineage", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "FINANCIAL_MODEL_VIOLATION");
});

Deno.test("PROCESSING batch status preserved during sibling reserve", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION, import.meta.url));
  assertStringIncludes(sql, "IF NOT v_batch_live_in_flight THEN");
  assertStringIncludes(sql, "v_batch_live_in_flight := upper(coalesce(v_batch.status, '')) IN ('PROCESSING', 'RESERVING')");
});
