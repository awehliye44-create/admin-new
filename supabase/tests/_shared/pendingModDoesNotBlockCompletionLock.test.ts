/**
 * Pending/failed fare-increase mods must not block Driver completion, and must
 * not mutate trip route state until payment is confirmed + applied.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("pending unpaid fare increase does not count as unresolved for completion", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261127120000_pending_mod_does_not_block_completion.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "trip_has_unresolved_fare_increase_modification");
  assertStringIncludes(sql, "payment_confirmed");
  assertStringIncludes(sql, "'approved'");
  assertStringIncludes(sql, "'applied'");
  // Explicitly no longer block on payment_required / payment_pending alone.
  assertEquals(sql.includes("'payment_required'"), false);
  assertEquals(sql.includes("'payment_pending'"), false);
});

Deno.test("fare-increase payment failure returns tripUnchanged and never claims apply", async () => {
  const exec = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/executeFareIncreaseModificationPayment.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(exec, "tripUnchanged: true");
  assertStringIncludes(exec, "PAYMENT_AUTHORISATION_PENDING");
  assertStringIncludes(exec, "INSUFFICIENT_FUNDS");
  assertStringIncludes(exec, "PAYMENT_DECLINED");
  assertStringIncludes(exec, "claim_and_apply_fare_increase_modification");
  // mayApply false path must precede claim RPC.
  const failIdx = exec.indexOf("if (!gate.mayApply)");
  const claimIdx = exec.indexOf("claim_and_apply_fare_increase_modification");
  assertEquals(failIdx >= 0 && claimIdx > failIdx, true);

  const request = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  assertStringIncludes(request, "tripUnchanged: true");
  assertStringIncludes(request, "error_code");
  assertStringIncludes(request, "fareDeltaPence");
  // On payment failure, request must return before auto-apply broadcast.
  const failReturn = request.indexOf("if (!paymentResult.success)");
  const autoApply = request.indexOf("Auto-applied (no payment");
  assertEquals(failReturn >= 0 && autoApply > failReturn, true);
});

Deno.test("DB apply guard still blocks unpaid approved/applied increases", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261112182000_trip_change_driver_update_lock.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED");
  assertStringIncludes(sql, "cannot apply fare-increasing modification without confirmed payment");
});
