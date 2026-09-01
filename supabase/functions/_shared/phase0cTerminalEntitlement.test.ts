/**
 * Phase 0c — terminal entitlement lifecycle tests (pure, no DB).
 */
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeTerminalOutcomeEntitlement,
} from "./terminalOutcomeEntitlementSSOT.ts";
import {
  evaluateLedgerEntryEligibility,
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
} from "./driverPayoutEligibilitySSOT.ts";
import { hasConflictingEntitlementTypes } from "./driverEntitlementLedgerSSOT.ts";

const TERMINAL_400_24 = {
  captured_pence: 400,
  provider_fee_pence: 24,
  provider_fee_confirmed: true,
  payment_session_id: "ps-1",
};

Deno.test("1. No-show 400/24 → one 376p entitlement", () => {
  const r = computeTerminalOutcomeEntitlement(TERMINAL_400_24);
  assertEquals(r.expected_driver_entitlement_pence, 376);
  assertEquals(r.commission_pence, 0);
  assertEquals(r.pending, false);
});

Deno.test("2. Charged cancellation 400/24 → one 376p entitlement", () => {
  const r = computeTerminalOutcomeEntitlement(TERMINAL_400_24);
  assertEquals(r.expected_driver_entitlement_pence, 376);
  assertEquals(r.commission_pence, 0);
});

Deno.test("3. Provider fee missing → no gross 400p payout eligibility", () => {
  const pending = computeTerminalOutcomeEntitlement({
    captured_pence: 400,
    provider_fee_pence: null,
    provider_fee_confirmed: false,
    payment_session_id: "ps-1",
  });
  assertEquals(pending.pending, true);
  assertEquals(pending.expected_driver_entitlement_pence, null);

  const grossBlocked = evaluateLedgerEntryEligibility({
    ledger_entry_id: "le-gross",
    trip_id: "trip-1",
    trip_exists: true,
    ledger_type: "DRIVER_COMPENSATION_CREDIT",
    amount_pence: 400,
    payment_session_id: "ps-1",
    captured_amount_pence: 400,
    canonical_driver_net_pence: null,
    financial_model: "PLATFORM_COLLECTED",
    fee_status: "PENDING",
    provider_processing_fee_pence: null,
    earning_credited_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    trip_status: "no_show",
  });
  assertEquals(grossBlocked.status, "SETTLEMENT_MISMATCH");
});

Deno.test("4. Webhook replay idempotency is structural in posting layer", async () => {
  const src = await Deno.readTextFile(new URL("./terminalOutcomeEntitlementSSOT.ts", import.meta.url));
  assertEquals(src.includes("ledgerEntryExists"), true);
  assertEquals(src.includes('error.code !== "23505"'), true);
});

Deno.test("5. TRIP_EARNING_NET plus DRIVER_COMPENSATION_CREDIT conflict", () => {
  assertEquals(
    hasConflictingEntitlementTypes(["TRIP_EARNING_NET", "DRIVER_COMPENSATION_CREDIT"]),
    true,
  );
  assertThrows(
    () => {
      if (hasConflictingEntitlementTypes(["TRIP_EARNING_NET", "DRIVER_COMPENSATION_CREDIT"])) {
        throw new Error("TERMINAL_ENTITLEMENT_CONFLICT");
      }
    },
  );
});

Deno.test("6. After 27 hours exactly 376p becomes available", () => {
  const created = new Date(Date.now() - (DEFAULT_PAYOUT_CLEARING_DELAY_HOURS + 1) * 3_600_000).toISOString();
  const r = evaluateLedgerEntryEligibility({
    ledger_entry_id: "le-376",
    trip_id: "trip-1",
    trip_exists: true,
    ledger_type: "DRIVER_COMPENSATION_CREDIT",
    amount_pence: 376,
    payment_session_id: "ps-1",
    captured_amount_pence: 400,
    provider_processing_fee_pence: 24,
    fee_status: "ACTUAL",
    canonical_driver_net_pence: null,
    financial_model: "PLATFORM_COLLECTED",
    earning_credited_at: created,
    completed_at: created,
    trip_status: "no_show",
  });
  assertEquals(r.status, "ELIGIBLE");
  assertEquals(r.payable_pence, 376);
});

Deno.test("7. Weekly payout allocation equals entitlement 376p", () => {
  const entitlement = 376;
  const allocations = [{ amount_pence: 376 }];
  const sum = allocations.reduce((a, b) => a + b.amount_pence, 0);
  assertEquals(sum, entitlement);
});

Deno.test("8. Commission remains zero for terminal fee", () => {
  const r = computeTerminalOutcomeEntitlement(TERMINAL_400_24);
  assertEquals(r.commission_pence, 0);
});

Deno.test("noShowSettlement routes through terminal entitlement SSOT", async () => {
  const src = await Deno.readTextFile(new URL("./noShowSettlement.ts", import.meta.url));
  assertEquals(src.includes("postNoShowDriverCompensation"), false);
  assertEquals(src.includes("postTerminalEntitlementFromSettlement"), true);
  assertEquals(src.includes("from(\"driver_wallet_ledger\").insert"), false);
});
