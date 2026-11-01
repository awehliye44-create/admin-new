/**
 * LOCK — accept_scheduled_ride must refuse new accepts when live Europe/London
 * document eligibility fails (check_driver_documents_approved).
 *
 * Instant accept-offer already uses this SSOT; scheduled accept previously did not.
 * Already-accepted / in-progress work is intentionally not cancelled by this gate.
 *
 * Run: deno test --allow-read supabase/tests/_shared/acceptScheduledRideDocumentEligibilityLock.test.ts
 */

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261224120000_accept_scheduled_ride_live_document_eligibility.sql",
  import.meta.url,
);

const EDGE = new URL(
  "../../functions/scheduled-ride-action/index.ts",
  import.meta.url,
);

Deno.test("accept_scheduled_ride migration gates on check_driver_documents_approved", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.accept_scheduled_ride");
  assertStringIncludes(sql, "check_driver_documents_approved(v_driver_id)");
  assertStringIncludes(sql, "DOCUMENTS_NOT_APPROVED");
  // Gate must run before the trip UPDATE that stamps confirmed_driver_id.
  const docsIdx = sql.indexOf("check_driver_documents_approved(v_driver_id)");
  const updateIdx = sql.indexOf("confirmed_driver_id = v_driver_id");
  assertEquals(docsIdx > 0, true);
  assertEquals(updateIdx > docsIdx, true);
});

Deno.test("scheduled-ride-action accept path also checks live document eligibility", async () => {
  const src = await Deno.readTextFile(EDGE);
  assertStringIncludes(src, 'action === "accept"');
  assertStringIncludes(src, "check_driver_documents_approved");
  assertStringIncludes(src, "DOCUMENTS_NOT_APPROVED");
  assertStringIncludes(src, 'rpc("accept_scheduled_ride"');
  const docsIdx = src.indexOf("check_driver_documents_approved");
  const rpcIdx = src.indexOf('rpc("accept_scheduled_ride"');
  assertEquals(docsIdx > 0, true);
  assertEquals(rpcIdx > docsIdx, true);
});

Deno.test("scheduled activation / check-in is not cancelled by the accept docs gate", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  // Policy: keep existing assignments; migration must not DELETE/UPDATE confirmed trips.
  assertEquals(/DELETE\s+FROM\s+public\.trips/i.test(sql), false);
  assertEquals(/confirmed_driver_id\s*=\s*NULL/i.test(sql), false);
  assertStringIncludes(
    sql,
    "Does not interrupt already-accepted or in-progress assignments",
  );
});
