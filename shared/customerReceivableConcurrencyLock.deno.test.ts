/**
 * Lock: concurrent reserve cannot double-consume the same OPEN receivable.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  simulateConcurrentReserves,
  simulateUnsafeInterleavedReserve,
} from "./customerReceivableConcurrencySSOT.ts";

const OPEN = [
  {
    id: "r012",
    customer_id: "cust-a",
    outstanding_amount_pence: 30,
    status: "OPEN" as const,
  },
  {
    id: "r017",
    customer_id: "cust-a",
    outstanding_amount_pence: 6,
    status: "OPEN" as const,
  },
];

Deno.test("advisory+SKIP LOCKED model: second concurrent reserve gets zero", () => {
  const result = simulateConcurrentReserves({
    customer_id: "cust-a",
    open: OPEN,
  });
  assertEquals(result.first.reserved_ids.sort(), ["r012", "r017"]);
  assertEquals(result.first.total_pence, 36);
  assertEquals(result.second.reserved_ids, []);
  assertEquals(result.second.total_pence, 0);
  assertEquals(result.overlap_ids, []);
  assertEquals(result.final_status_by_id.r012, "RESERVED");
  assertEquals(result.final_status_by_id.r017, "RESERVED");
});

Deno.test("unsafe interleaved read shows double-consume race (why lock exists)", () => {
  const unsafe = simulateUnsafeInterleavedReserve({ open: OPEN });
  assertEquals(unsafe.overlap_ids.sort(), ["r012", "r017"]);
});

Deno.test("migration SQL documents advisory lock + SKIP LOCKED", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../supabase/migrations/20261127150000_customer_receivables_ssot.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("pg_advisory_xact_lock"), true);
  assertEquals(sql.includes("FOR UPDATE SKIP LOCKED"), true);
  assertEquals(sql.includes("customer_receivable_reserve_for_preauth"), true);
});
