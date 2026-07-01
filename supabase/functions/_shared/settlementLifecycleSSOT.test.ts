import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFifoSettlementAllocations,
  deriveSettlementLifecycleStatus,
  SETTLEMENT_LIFECYCLE,
} from "./settlementLifecycleSSOT.ts";

Deno.test("deriveSettlementLifecycleStatus: CREATED when new row", () => {
  assertEquals(
    deriveSettlementLifecycleStatus({}),
    SETTLEMENT_LIFECYCLE.CREATED,
  );
});

Deno.test("deriveSettlementLifecycleStatus: TRANSFERRED after SCT", () => {
  assertEquals(
    deriveSettlementLifecycleStatus({ stripe_transfer_id: "tr_123" }),
    SETTLEMENT_LIFECYCLE.TRANSFERRED_TO_CONNECT,
  );
});

Deno.test("deriveSettlementLifecycleStatus: INCLUDED_IN_PAYOUT when partially allocated", () => {
  assertEquals(
    deriveSettlementLifecycleStatus({
      allocated_amount_pence: 200,
      ledger_amount_pence: 500,
    }),
    SETTLEMENT_LIFECYCLE.INCLUDED_IN_PAYOUT,
  );
});

Deno.test("deriveSettlementLifecycleStatus: PAID when payout item linked", () => {
  assertEquals(
    deriveSettlementLifecycleStatus({
      paid_in_payout_item_id: "pi_1",
      paid_at: "2026-06-18T00:00:00Z",
    }),
    SETTLEMENT_LIFECYCLE.PAID,
  );
});

Deno.test("buildFifoSettlementAllocations consumes oldest first when pre-sorted", () => {
  const lines = buildFifoSettlementAllocations(
    [
      {
        settlement_id: "s1",
        ledger_entry_id: "l1",
        amount_pence: 300,
        ledger_created_at: "2026-06-13T00:00:00Z",
      },
      {
        settlement_id: "s2",
        ledger_entry_id: "l2",
        amount_pence: 400,
        ledger_created_at: "2026-06-16T00:00:00Z",
      },
    ],
    500,
  );
  assertEquals(lines.length, 2);
  assertEquals(lines[0].ledger_entry_id, "l1");
  assertEquals(lines[0].amount_pence, 300);
  assertEquals(lines[1].ledger_entry_id, "l2");
  assertEquals(lines[1].amount_pence, 200);
});
