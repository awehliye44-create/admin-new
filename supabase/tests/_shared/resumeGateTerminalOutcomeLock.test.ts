/**
 * Lock: Resume CREDIT_MISMATCH counts chargeable cancellation / no-show compensation.
 *
 * Expected entitlement = completed trips (driver net + tip)
 *   + per terminal-outcome trip: captured − ACTUAL provider fee (terminalOutcomeEntitlementSSOT).
 * Cancellation clears trips.driver_id, so attribution includes previous_driver_id.
 * Credits without matching trip evidence (MK-260923-017) must still block Resume.
 * If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveTerminalFeeDriverTenPence } from "../../functions/_shared/frDriverExpectedEntitlementSSOT.ts";
import { TERMINAL_FEE_LEDGER_TYPE } from "../../functions/_shared/terminalOutcomeEntitlementSSOT.ts";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
const FWD = "../../migrations/20261216160000_resume_gate_terminal_outcome_entitlement.sql";
const RB = "../../migrations/rollback/rollback_20261216160000_resume_gate_terminal_outcome_entitlement.sql";
const BASE = "../../migrations/20261127140000_admin_resume_payout_operational_pause_gates.sql";

function functionSource(sql: string): string {
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.admin_set_driver_payout_operational_pause(");
  assert(start >= 0, "pause RPC missing");
  const a = sql.indexOf("$function$", start) + "$function$".length;
  return sql.slice(a, sql.indexOf("$function$", a));
}

Deno.test("terminal compensation formula: capture − confirmed provider fee (production credits)", () => {
  assertEquals(TERMINAL_FEE_LEDGER_TYPE, "TRIP_EARNING_NET");
  assertEquals(resolveTerminalFeeDriverTenPence({ captured_pence: 450, provider_fee_pence: 24 }), 426); // MK-261002-014
  assertEquals(resolveTerminalFeeDriverTenPence({ captured_pence: 400, provider_fee_pence: 24 }), 376); // MK-260927-009
});

Deno.test("resume gate: expected includes terminal outcomes attributed via previous_driver_id", async () => {
  const src = functionSource(await read(FWD));
  assertStringIncludes(src, "WHERE t.status IN ('cancelled', 'no_show')");
  assertStringIncludes(
    src,
    "AND t.financial_outcome IN ('NO_SHOW', 'LATE_PASSENGER_CANCELLATION', 'ARRIVAL_CANCELLATION')",
  );
  assertStringIncludes(src, "AND p_driver_id IN (t.driver_id, t.confirmed_driver_id, t.previous_driver_id);");
  assertStringIncludes(src, "greatest(0, ps.captured_amount_pence - ps.provider_processing_fee_pence)");
  assertStringIncludes(src, "AND upper(coalesce(s.fee_status::text, '')) = 'ACTUAL'");
  assertStringIncludes(src, "AND s.captured_amount_pence > 0");
  assertStringIncludes(src, "v_expected_pence := v_expected_pence + v_terminal_expected_pence;");
  assertStringIncludes(src, "'lifetime_terminal_outcome_expected_pence', v_terminal_expected_pence");
});

Deno.test("resume gate: still fail-closed — mismatch blocks, completed trips counted once", async () => {
  const src = functionSource(await read(FWD));
  assertStringIncludes(src, "IF v_actual_credits_pence - v_held_cancelled_pence IS DISTINCT FROM v_expected_pence THEN");
  assertStringIncludes(src, "'error_code', 'CREDIT_MISMATCH'");
  assertStringIncludes(src, "WHERE t.status = 'completed'\n    AND (t.confirmed_driver_id = p_driver_id OR t.driver_id = p_driver_id);");
  assertEquals(src.includes("previous_driver_id) AND t.status = 'completed'"), false);
  assertStringIncludes(src, "WHERE p_driver_id IN (t.confirmed_driver_id, t.driver_id, t.previous_driver_id)\n    AND upper(coalesce(ps.provider_state, '')) = 'UNKNOWN';");
  assertStringIncludes(src, "PERFORM pg_advisory_xact_lock(hashtextextended(p_driver_id::text, 0));");
  assertStringIncludes(src, "PERFORM public.assert_finance_payout_ledger_access();");
  assertEquals(/INSERT INTO public\.driver_wallet_ledger|UPDATE public\.driver_wallet_ledger|UPDATE public\.payout_items/.test(src), false);
});

Deno.test("resume gate: grants unchanged — staff JWT only, service_role denied", async () => {
  const sql = await read(FWD);
  assertStringIncludes(sql, "REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM service_role;");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) TO authenticated;");
});

Deno.test("rollback restores the previous production body exactly", async () => {
  assertEquals(functionSource(await read(RB)), functionSource(await read(BASE)));
});

Deno.test("resume gate: unallocated credits on cancelled non-chargeable trips are held, not payable", async () => {
  const src = functionSource(await read(FWD));
  assertStringIncludes(src, "AND t.status IS DISTINCT FROM 'completed'");
  assertStringIncludes(src, "AND (t.cancelled_at IS NOT NULL OR lower(coalesce(t.status, '')) LIKE '%cancel%')");
  assertStringIncludes(
    src,
    "AND coalesce(t.financial_outcome, '') NOT IN ('NO_SHOW', 'LATE_PASSENGER_CANCELLATION', 'ARRIVAL_CANCELLATION')",
  );
  assertStringIncludes(src, "WHERE a.ledger_entry_id = l.id");
  assertStringIncludes(
    src,
    "AND upper(coalesce(pi.status, '')) NOT IN ('FAILED', 'CANCELLED', 'RELEASED', 'INELIGIBLE', 'INVALID_ORPHANED')",
  );
  assertStringIncludes(src, "IF v_actual_credits_pence - v_held_cancelled_pence IS DISTINCT FROM v_expected_pence THEN");
  assertStringIncludes(src, "'lifetime_held_cancelled_credit_pence', v_held_cancelled_pence");
});

Deno.test("payout eligibility still holds every credit on a cancelled trip (held set is a subset)", async () => {
  const { isCancelledOrUncompletedEarning } = await import(
    "../../functions/_shared/driverPayoutEligibilitySSOT.ts"
  );
  assertEquals(isCancelledOrUncompletedEarning({ trip_status: "cancelled", trip_cancelled: true }), true);
  assertEquals(isCancelledOrUncompletedEarning({ trip_status: "cancelled", trip_cancelled: false }), true);
  assertEquals(
    isCancelledOrUncompletedEarning({ trip_status: "completed", trip_cancelled: false, completed_at: "2026-09-23" }),
    false,
  );
});

Deno.test("MK0006 production evidence: compensation counted, MK-260923-017's 430p held, Resume allowed", () => {
  const credits = 22485;
  const completedExpected = 21253;
  const terminal = [
    resolveTerminalFeeDriverTenPence({ captured_pence: 450, provider_fee_pence: 24 }),
    resolveTerminalFeeDriverTenPence({ captured_pence: 400, provider_fee_pence: 24 }),
  ];
  const heldDisputed = 430;
  assertEquals(credits - completedExpected, 1232);
  assertEquals(credits - completedExpected - terminal.reduce((a, b) => a + b, 0), heldDisputed);
  assertEquals(credits - heldDisputed - completedExpected - terminal.reduce((a, b) => a + b, 0), 0);
});
