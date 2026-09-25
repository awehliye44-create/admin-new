/**
 * Lock: FR capture composition + receivable recovery classification (display only).
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifySourceTripReceivableRecovery,
  evaluateFrCaptureCompositionIdentity,
  FR_RESOLVED_BY_RECEIVABLE_RECOVERY,
  sumOpenReservedReceivableOutstandingPence,
} from "./frCaptureCompositionIdentitySSOT.ts";

Deno.test("3. Recovery capture 740 with components 704+36 → FR variance 0", () => {
  const identity = evaluateFrCaptureCompositionIdentity({
    session: {
      trip_fare_component_pence: 704,
      tip_component_pence: 0,
      receivable_component_pence: 36,
      provider_capture_target_pence: 740,
      captured_amount_pence: 740,
      metadata: {},
    },
    actual_captured_pence: 740,
  });
  assertEquals(identity?.expected_provider_capture_pence, 740);
  assertEquals(identity?.capture_variance_pence, 0);
  assertEquals(identity?.settlement_identity_balanced, true);
  assertEquals(identity?.receivable_component_pence, 36);
  assertEquals(identity?.trip_fare_component_pence, 704);
});

Deno.test("6. Historical decline remains visible as resolved evidence", () => {
  const cls = classifySourceTripReceivableRecovery(
    [{
      source_trip_id: "2799bb97-cabf-47e1-a570-fe225e6b06b1",
      status: "SETTLED",
      outstanding_amount_pence: 0,
      original_amount_pence: 30,
      reserved_payment_session_id: "6d86b1e6-4b02-4059-8da4-753717721ffe",
    }],
    "2799bb97-cabf-47e1-a570-fe225e6b06b1",
  );
  assertEquals(cls.resolved_by_receivable_recovery, true);
  assertEquals(cls.status, FR_RESOLVED_BY_RECEIVABLE_RECOVERY);
  assertEquals(cls.settled_original_pence, 30);
  assertEquals(cls.open_outstanding_pence, 0);
  assertEquals(cls.recovery_payment_session_id, "6d86b1e6-4b02-4059-8da4-753717721ffe");
});

Deno.test("7/8. OPEN shows outstanding; SETTLED does not", () => {
  const open = sumOpenReservedReceivableOutstandingPence(
    [{
      source_trip_id: "t1",
      status: "OPEN",
      outstanding_amount_pence: 30,
      original_amount_pence: 30,
    }],
    "t1",
  );
  assertEquals(open, 30);
  const settled = sumOpenReservedReceivableOutstandingPence(
    [{
      source_trip_id: "t1",
      status: "SETTLED",
      outstanding_amount_pence: 0,
      original_amount_pence: 30,
    }],
    "t1",
  );
  assertEquals(settled, 0);
});

Deno.test("9. No double-count: fare component stays on recovery trip; recv on source", () => {
  const mk003 = evaluateFrCaptureCompositionIdentity({
    session: {
      trip_fare_component_pence: 704,
      tip_component_pence: 0,
      receivable_component_pence: 36,
      provider_capture_target_pence: 740,
      captured_amount_pence: 740,
    },
    actual_captured_pence: 740,
  });
  assertEquals(mk003?.trip_fare_component_pence, 704);
  assertEquals(mk003?.receivable_component_pence, 36);
  assertEquals(
    (mk003?.trip_fare_component_pence ?? 0) + (mk003?.receivable_component_pence ?? 0),
    740,
  );
});
