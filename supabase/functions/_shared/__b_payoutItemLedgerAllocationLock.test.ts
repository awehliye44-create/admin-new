/**
 * Lock: Payout Ledger consumes only eligible PLATFORM_COLLECTED DWL entries.
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  PAYOUT_ALLOCATION_ELIGIBLE_CREDIT_TYPES,
  isAllocatableWalletLedgerType,
  payoutItemStatusReleasesLedgerAllocation,
} from "./payoutAllocationEligibilitySSOT.ts";
import {
  PAYOUT_ELIGIBLE_LEDGER_TYPES,
  PAYOUT_ELIGIBILITY_STATUS,
  evaluateLedgerEntryEligibility,
} from "./driverPayoutEligibilitySSOT.ts";
import { planPayoutItemFromEligibleEntries } from "./payoutLedgerHandoffSSOT.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

Deno.test("payout allocation types match payout-eligible DWL credits only", () => {
  assertEquals(
    [...PAYOUT_ALLOCATION_ELIGIBLE_CREDIT_TYPES].sort(),
    [...PAYOUT_ELIGIBLE_LEDGER_TYPES].sort(),
  );
  assertEquals(isAllocatableWalletLedgerType("TRIP_EARNING_NET"), true);
  assertEquals(isAllocatableWalletLedgerType("DRIVER_COMPENSATION_CREDIT"), true);
  assertEquals(isAllocatableWalletLedgerType("CASH_TRIP_EARNING"), false);
  assertEquals(isAllocatableWalletLedgerType("CASH_COMMISSION_DEBT"), false);
  assertEquals(isAllocatableWalletLedgerType("BONUS"), false);
  assertEquals(isAllocatableWalletLedgerType("PLATFORM_COMMISSION"), false);
});

Deno.test("failed/reversed payouts keep audit rows but release ledger for retry", () => {
  assertEquals(payoutItemStatusReleasesLedgerAllocation("FAILED"), true);
  assertEquals(payoutItemStatusReleasesLedgerAllocation("REVERSED"), true);
  assertEquals(payoutItemStatusReleasesLedgerAllocation("failed"), true);
  assertEquals(payoutItemStatusReleasesLedgerAllocation("COMPLETED"), false);
  assertEquals(payoutItemStatusReleasesLedgerAllocation("RESERVED"), false);
  assertEquals(payoutItemStatusReleasesLedgerAllocation("PAID"), false);
});

Deno.test("planPayoutItemFromEligibleEntries amount equals allocated ledger credits", () => {
  const planned = planPayoutItemFromEligibleEntries({
    eligible_entries: [
      { ledger_entry_id: "ten-1", amount_pence: 400 },
      { ledger_entry_id: "ten-2", amount_pence: 200 },
    ],
    available_balance_pence: 500,
  });
  assertEquals(planned?.amount_pence, 500);
  assertEquals(planned?.allocations, [
    { ledger_entry_id: "ten-1", amount_pence: 400 },
    { ledger_entry_id: "ten-2", amount_pence: 100 },
  ]);
});

Deno.test("trip-linked payout eligibility requires PLATFORM_COLLECTED", () => {
  const base = {
    ledger_entry_id: "ten-unstamped",
    trip_id: "trip-null-model",
    ledger_type: "TRIP_EARNING_NET",
    amount_pence: 408,
    trip_exists: true,
    payment_session_id: "ps-1",
    captured_amount_pence: 480,
    canonical_driver_net_pence: 408,
    fr_trip_status: "BALANCED",
    refunded_amount_pence: 0,
    des_present: false,
    captured_at: "2020-01-01T00:00:00.000Z",
    earning_credited_at: "2020-01-01T00:00:00.000Z",
    provider_available_on: "2020-01-01T00:00:00.000Z",
  };
  const missing = evaluateLedgerEntryEligibility(base);
  assertEquals(missing.payable_pence, 0);
  assertEquals(missing.status, PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR);
  const platform = evaluateLedgerEntryEligibility({
    ...base,
    financial_model: "PLATFORM_COLLECTED",
  });
  assertEquals(platform.payable_pence, 408);
  const driverCollected = evaluateLedgerEntryEligibility({
    ...base,
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
  });
  assertEquals(driverCollected.payable_pence, 0);
});

Deno.test("payout ledger allocation lineage lock", async () => {
  const migration = await read(
    "supabase/migrations/20260927180200_payout_item_ledger_allocation_lineage.sql",
  );
  const dbTest = await read(
    "supabase/tests/payout_item_ledger_allocation_lineage.sql",
  );
  const scheduler = await read(
    "supabase/functions/admin-weekly-payout-scheduler/index.ts",
  );
  const execute = await read(
    "supabase/functions/admin-execute-weekly-payout-occurrence/index.ts",
  );
  const withdraw = await read("supabase/functions/driver-withdraw/index.ts");
  const allocSsot = await read(
    "supabase/functions/_shared/payoutAllocationEligibilitySSOT.ts",
  );
  const lifecycle = await read(
    "supabase/functions/_shared/settlementLifecycleSSOT.ts",
  );
  const reserve = await read(
    "supabase/functions/admin-reserve-driver-payout-batch/index.ts",
  );
  const submit = await read(
    "supabase/functions/admin-submit-driver-payout-payment/index.ts",
  );
  const manual = await read(
    "supabase/functions/admin-mark-manual-payout-paid/index.ts",
  );

  const finalize = await read(
    "supabase/functions/admin-finalize-driver-payout-completion/index.ts",
  );
  const ledgerSync = await read(
    "supabase/functions/_shared/payoutLedgerSync.ts",
  );

  const write = await read(
    "supabase/functions/_shared/payoutItemLedgerAllocationWrite.ts",
  );

  assert(migration.includes("assert_payout_item_ledger_lineage"));
  assert(migration.includes("PAYOUT_LINEAGE_MISSING"));
  assert(migration.includes("DRIVER_COLLECTED_COMMISSION_WALLET"));
  assert(migration.includes("PLATFORM_COLLECTED"));
  assert(migration.includes("payout_item_ledger_allocations cannot be updated or deleted"));
  assert(migration.includes("BEFORE INSERT OR UPDATE OF status, execution_status"));
  assert(migration.includes("GRANT EXECUTE ON FUNCTION public.assert_payout_item_ledger_lineage"));
  assert(migration.includes("REVOKE ALL ON FUNCTION public.assert_payout_item_ledger_lineage"));
  assert(dbTest.includes("payout without allocations rejected"));
  assert(dbTest.includes("PAYOUT_LINEAGE_MISSING"));
  assert(dbTest.includes("ineligible ledger type was allocated"));
  assert(dbTest.includes("failed payout lost auditable allocation rows"));
  assert(dbTest.includes("same earning was allocated to a second"));
  assert(dbTest.includes("lineage test ineligible type"));
  assert(!dbTest.includes("SKIP: no cash/commission DWL row"));
  assert(!dbTest.includes("SKIP: no PLATFORM_COLLECTED payout-eligible DWL"));
  assert(dbTest.includes("Driver-Collected / unstamped trip earning was allocated"));

  assert(write.includes("await assertPayoutItemLedgerLineage"));
  assert(write.includes('rpc("assert_payout_item_ledger_lineage"'));
  assert(scheduler.includes("planPayoutItemFromEligibleEntries"));
  assert(!scheduler.includes("computeLedgerWalletBalancePence"));
  assert(execute.includes("persistPayoutItemLedgerAllocations"));
  assert(execute.includes("assertPayoutItemLedgerLineage"));
  assert(!execute.includes("computeLedgerWalletBalancePence"));
  assert(withdraw.includes("persistPayoutItemLedgerAllocations"));
  assert(withdraw.includes("assertPayoutItemLedgerLineage"));
  assert(!withdraw.includes("early_cash_out_requested_pence"));
  assert(!allocSsot.includes('"CASH_TRIP_EARNING"'));
  assert(lifecycle.includes("PAYOUT_LINEAGE_MISSING"));
  assert(!lifecycle.includes("fetchUnsettledSettlementCandidates"));
  assert(submit.includes("assertPayoutItemLedgerLineage"));
  assert(manual.includes("assertPayoutItemLedgerLineage"));
  assert(reserve.includes("assertPayoutItemLedgerLineage"));
  assert(finalize.includes("assertPayoutItemLedgerLineage"));
  assert(ledgerSync.includes("invokeAutomatedPayoutCompletion"));
  assert(ledgerSync.includes("invokeManualExternalPayoutCompletion"));
  assert(!ledgerSync.includes('from("driver_wallet_ledger").insert'));
  assert(allocSsot.includes('"FAILED"'));
});
