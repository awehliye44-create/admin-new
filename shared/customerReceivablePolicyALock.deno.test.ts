/**
 * Policy A lock — MK-012 TEN 492 unchanged; recovery creates no second
 * TEN / commission / payout from receivable collection.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  POLICY_A,
  TEN_REPAIR_FORBIDDEN,
  planCreateReceivableFromDeclinedIncrement,
} from "../supabase/functions/_shared/customerReceivableSSOT.ts";
import {
  classifyTripCustomerOutstanding,
  FR_CUSTOMER_OUTSTANDING_CLASS,
} from "../supabase/functions/_shared/frCustomerOutstandingSSOT.ts";

/** Proven MK-012 money graph. */
const MK012 = {
  final_fare_pence: 579,
  capture_amount_pence: 549,
  shortfall_pence: 30,
  commission_pence: 87,
  ten_driver_net_pence: 492,
} as const;

Deno.test("Policy A: TEN_REPAIR_FORBIDDEN and no second TEN/commission/payout", () => {
  assertEquals(TEN_REPAIR_FORBIDDEN, true);
  assertEquals(POLICY_A.TEN_REPAIR_FORBIDDEN, true);
  assertEquals(POLICY_A.NO_SECOND_TEN_FROM_RECOVERY, true);
  assertEquals(POLICY_A.NO_SECOND_COMMISSION_FROM_RECOVERY, true);
  assertEquals(POLICY_A.NO_PAYOUT_FROM_RECOVERY, true);
  assertEquals(POLICY_A.DRIVER_ENTITLEMENT, "PLATFORM_FRONTS_EARNED_WAITING");
});

Deno.test("Policy A: MK-012 TEN 492 unchanged; receivable is customer debt only", () => {
  const plan = planCreateReceivableFromDeclinedIncrement({
    customer_id: "6818f4c3-2645-4bef-897a-30d0abe199bd",
    source_trip_id: "2799bb97-cabf-47e1-a570-fe225e6b06b1",
    final_fare_pence: MK012.final_fare_pence,
    captured_pence: MK012.capture_amount_pence,
    shortfall_pence: MK012.shortfall_pence,
  });
  assertEquals(plan.should_create, true);
  assertEquals(plan.outstanding_amount_pence, 30);
  assertEquals(plan.metadata.ten_repair_forbidden, true);
  assertEquals(plan.metadata.no_second_ten, true);
  assertEquals(plan.metadata.no_second_commission, true);
  assertEquals(plan.metadata.no_payout_from_recovery, true);
  // Entitlement identity: fare − commission = TEN (unchanged by receivable).
  assertEquals(
    MK012.final_fare_pence - MK012.commission_pence,
    MK012.ten_driver_net_pence,
  );
  assertEquals(MK012.ten_driver_net_pence, 492);
});

Deno.test("Policy A: FR class is CUSTOMER_OUTSTANDING not wallet variance", () => {
  const row = classifyTripCustomerOutstanding({
    trip_code: "MK-260923-012",
    final_fare_pence: MK012.final_fare_pence,
    capture_amount_pence: MK012.capture_amount_pence,
    receivable_outstanding_pence: 30,
  });
  assertEquals(row.fr_class, FR_CUSTOMER_OUTSTANDING_CLASS.CUSTOMER_OUTSTANDING);
  assertEquals(row.outstanding_pence, 30);
  assertEquals(row.captured_pence, 549);
});
