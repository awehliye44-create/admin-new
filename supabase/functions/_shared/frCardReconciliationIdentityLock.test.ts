/**
 * Lock: FR composition/recovery card identity (display only).
 * Canonical fixtures MK-003 / MK-012 / MK-017 — Overview residual must be 0, not +6.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifySourceTripReceivableRecovery,
  FR_RESOLVED_BY_RECEIVABLE_RECOVERY,
} from "./frCaptureCompositionIdentitySSOT.ts";
import {
  computeCardReconciliationIdentityAggregate,
  computeTripCardReconciliationResidual,
  resolveCurrentOutstandingFromReceivables,
  sumProviderProvenSettledReceivableAllocationPence,
} from "./frCardReconciliationIdentitySSOT.ts";
import {
  FINANCE_RECONCILIATION_TRIP_TERMINAL_OR,
  tripHasFrFinancialEvidence,
  tripQualifiesForFinanceReconciliationAudit,
} from "./financeReconciliationTripQuery.ts";
import type { PaymentSessionMoneyByTrip, TripSSOTRow } from "./financialReconciliationSSOT.ts";

const MK003 = "0e582a2e-afd4-42ce-99d4-9c3d9292232b";
const MK012 = "2799bb97-cabf-47e1-a570-fe225e6b06b1";
const MK017 = "174df647-2417-4da3-9e55-7261a4e7d3e7";
const RECOVERY_SESSION = "6d86b1e6-4b02-4059-8da4-753717721ffe";

const mk003Session: PaymentSessionMoneyByTrip = {
  payment_session_id: RECOVERY_SESSION,
  captured_amount_pence: 740,
  authorised_amount_pence: 740,
  released_amount_pence: 0,
  refunded_amount_pence: 0,
  provider_processing_fee_pence: null,
  fee_status: null,
  provider_state: "COMPLETED",
  provider_state_verified_at: null,
  release_evidence_status: null,
  payment_method: "GOOGLE_PAY",
  status: "CAPTURED",
  trip_fare_component_pence: 704,
  tip_component_pence: 0,
  receivable_component_pence: 36,
  buffer_pence: 0,
  provider_capture_target_pence: 740,
  purpose: "RIDE_BOOKING",
};

Deno.test("MK-003 recovery session: 740 − 704 − 36 = 0 (not +36 vs fare liabilities)", () => {
  const r = computeTripCardReconciliationResidual({
    trip: {
      id: MK003,
      driver_net_pence: 598,
      commission_pence: 106,
      tip_pence: 0,
      airport_charge_pence: 0,
    },
    captured_pence: 740,
    session: mk003Session,
    receivables: [],
  });
  assertEquals(r.kind, "recovery_session");
  assertEquals(r.composition_residual_pence, 0);
  assertEquals(r.fare_leg_capture_pence, 704);
  assertEquals(r.settled_receivable_allocation_pence, 0);
  assertEquals(r.residual_pence, 0);
  assertEquals(r.fail_closed, false);
});

Deno.test("MK-012 source: 549 + 30 − 492 − 87 = 0 (not −30)", () => {
  const receivables = [{
    source_trip_id: MK012,
    status: "SETTLED",
    outstanding_amount_pence: 0,
    original_amount_pence: 30,
    reserved_payment_session_id: RECOVERY_SESSION,
  }];
  assertEquals(sumProviderProvenSettledReceivableAllocationPence(receivables, MK012), 30);
  const r = computeTripCardReconciliationResidual({
    trip: {
      id: MK012,
      driver_net_pence: 492,
      commission_pence: 87,
      tip_pence: 0,
      airport_charge_pence: 0,
    },
    captured_pence: 549,
    session: null,
    receivables,
  });
  assertEquals(r.kind, "source_trip");
  assertEquals(r.settled_receivable_allocation_pence, 30);
  assertEquals(r.residual_pence, 0);
  // Do not zero merely from label — math must hold.
  const cls = classifySourceTripReceivableRecovery(receivables, MK012);
  assertEquals(cls.status, FR_RESOLVED_BY_RECEIVABLE_RECOVERY);
  assertEquals(cls.settled_original_pence, 30);
});

Deno.test("MK-017 source: 500 + 6 − 430 − 76 = 0 (not −6)", () => {
  const receivables = [{
    source_trip_id: MK017,
    status: "SETTLED",
    outstanding_amount_pence: 0,
    original_amount_pence: 6,
    reserved_payment_session_id: RECOVERY_SESSION,
  }];
  const r = computeTripCardReconciliationResidual({
    trip: {
      id: MK017,
      driver_net_pence: 430,
      commission_pence: 76,
      tip_pence: 0,
      airport_charge_pence: 0,
    },
    captured_pence: 500,
    session: null,
    receivables,
  });
  assertEquals(r.residual_pence, 0);
  assertEquals(r.kind, "source_trip");
});

Deno.test("Aggregate MK-003+012+017 = 0, not +6", () => {
  const receivables = [
    {
      source_trip_id: MK012,
      status: "SETTLED",
      outstanding_amount_pence: 0,
      original_amount_pence: 30,
      reserved_payment_session_id: RECOVERY_SESSION,
    },
    {
      source_trip_id: MK017,
      status: "SETTLED",
      outstanding_amount_pence: 0,
      original_amount_pence: 6,
      reserved_payment_session_id: RECOVERY_SESSION,
    },
  ];
  const trips: TripSSOTRow[] = [
    {
      id: MK003,
      commission_pence: 106,
      provider_fee_pence: 0,
      onecab_net_pence: 106,
      driver_net_pence: 598,
      gross_fare_pence: 704,
      final_fare_pence: 704,
      commissionable_fare_pence: 704,
      capture_amount_pence: 740,
      tip_pence: 0,
      airport_charge_pence: 0,
    },
    {
      id: MK012,
      commission_pence: 87,
      provider_fee_pence: 0,
      onecab_net_pence: 87,
      driver_net_pence: 492,
      gross_fare_pence: 579,
      final_fare_pence: 579,
      commissionable_fare_pence: 579,
      capture_amount_pence: 549,
      tip_pence: 0,
      airport_charge_pence: 0,
    },
    {
      id: MK017,
      commission_pence: 76,
      provider_fee_pence: 0,
      onecab_net_pence: 76,
      driver_net_pence: 430,
      gross_fare_pence: 506,
      final_fare_pence: 506,
      commissionable_fare_pence: 506,
      capture_amount_pence: 500,
      tip_pence: 0,
      airport_charge_pence: 0,
    },
  ];
  const paymentByTrip = new Map([
    [MK003, 740],
    [MK012, 549],
    [MK017, 500],
  ]);
  const sessionByTrip = new Map([[MK003, mk003Session]]);
  const agg = computeCardReconciliationIdentityAggregate({
    trips,
    paymentByTrip,
    sessionByTrip,
    receivables,
  });
  assertEquals(agg.fail_closed, false);
  assertEquals(agg.variance_pence, 0);
  assertEquals(agg.balanced, true);
  assertEquals(agg.status, "BALANCED");
  // Legacy false decomposition was +36 − 30 = +6 (017 absent).
  assertEquals(agg.variance_pence === 6, false);
});

Deno.test("OPEN 6p remains unresolved; SETTLED 6p resolves to 0", () => {
  const openRows = [{
    source_trip_id: MK017,
    status: "OPEN",
    outstanding_amount_pence: 6,
    original_amount_pence: 6,
  }];
  const openResidual = computeTripCardReconciliationResidual({
    trip: { id: MK017, driver_net_pence: 430, commission_pence: 76 },
    captured_pence: 500,
    receivables: openRows,
  });
  assertEquals(openResidual.residual_pence, -6);
  assertEquals(openResidual.open_receivable_outstanding_pence, 6);
  assertEquals(
    resolveCurrentOutstandingFromReceivables({
      receivablesLedgerAvailable: true,
      receivables: openRows,
      sourceTripId: MK017,
    }).outstanding_pence,
    6,
  );

  const settledRows = [{
    source_trip_id: MK017,
    status: "SETTLED",
    outstanding_amount_pence: 0,
    original_amount_pence: 6,
    reserved_payment_session_id: RECOVERY_SESSION,
  }];
  const settledResidual = computeTripCardReconciliationResidual({
    trip: { id: MK017, driver_net_pence: 430, commission_pence: 76 },
    captured_pence: 500,
    receivables: settledRows,
  });
  assertEquals(settledResidual.residual_pence, 0);
  assertEquals(
    resolveCurrentOutstandingFromReceivables({
      receivablesLedgerAvailable: true,
      receivables: settledRows,
      sourceTripId: MK017,
    }).outstanding_pence,
    0,
  );
});

Deno.test("Partial recovery counts only provider-proven settled allocation", () => {
  const rows = [
    {
      source_trip_id: MK012,
      status: "SETTLED",
      outstanding_amount_pence: 0,
      original_amount_pence: 20,
      reserved_payment_session_id: RECOVERY_SESSION,
    },
    {
      source_trip_id: MK012,
      status: "OPEN",
      outstanding_amount_pence: 10,
      original_amount_pence: 10,
    },
  ];
  assertEquals(sumProviderProvenSettledReceivableAllocationPence(rows, MK012), 20);
  const r = computeTripCardReconciliationResidual({
    trip: { id: MK012, driver_net_pence: 492, commission_pence: 87 },
    captured_pence: 549,
    receivables: rows,
  });
  // 549 + 20 − 579 = −10 remaining unresolved
  assertEquals(r.residual_pence, -10);
  assertEquals(r.open_receivable_outstanding_pence, 10);
});

Deno.test("Cross-period: recovery session residual 0 without rewriting source capture; no double-count", () => {
  // Sep 25 cash attribution — MK-003 only
  const sep25 = computeCardReconciliationIdentityAggregate({
    trips: [{
      id: MK003,
      commission_pence: 106,
      provider_fee_pence: 0,
      onecab_net_pence: 106,
      driver_net_pence: 598,
      gross_fare_pence: 704,
      final_fare_pence: 704,
      commissionable_fare_pence: 704,
      capture_amount_pence: 740,
    }],
    paymentByTrip: new Map([[MK003, 740]]),
    sessionByTrip: new Map([[MK003, mk003Session]]),
    receivables: [], // source allocations attributed economically to source trips
  });
  assertEquals(sep25.variance_pence, 0);

  // Sep 23 economic attribution — sources with settled alloc; original captures unchanged
  const sep23 = computeCardReconciliationIdentityAggregate({
    trips: [
      {
        id: MK012,
        commission_pence: 87,
        provider_fee_pence: 0,
        onecab_net_pence: 87,
        driver_net_pence: 492,
        gross_fare_pence: 579,
        final_fare_pence: 579,
        commissionable_fare_pence: 579,
        capture_amount_pence: 549,
      },
      {
        id: MK017,
        commission_pence: 76,
        provider_fee_pence: 0,
        onecab_net_pence: 76,
        driver_net_pence: 430,
        gross_fare_pence: 506,
        final_fare_pence: 506,
        commissionable_fare_pence: 506,
        capture_amount_pence: 500,
      },
    ],
    paymentByTrip: new Map([[MK012, 549], [MK017, 500]]),
    receivables: [
      {
        source_trip_id: MK012,
        status: "SETTLED",
        outstanding_amount_pence: 0,
        original_amount_pence: 30,
        reserved_payment_session_id: RECOVERY_SESSION,
      },
      {
        source_trip_id: MK017,
        status: "SETTLED",
        outstanding_amount_pence: 0,
        original_amount_pence: 6,
        reserved_payment_session_id: RECOVERY_SESSION,
      },
    ],
  });
  assertEquals(sep23.variance_pence, 0);
  // Source original captures not rewritten to include recovery cash
  assertEquals(sep23.trip_residuals.find((t) => t.trip_id === MK012)?.fare_leg_capture_pence, 549);
  assertEquals(sep23.trip_residuals.find((t) => t.trip_id === MK017)?.fare_leg_capture_pence, 500);
});

Deno.test("Missing composition evidence fails closed", () => {
  const r = computeTripCardReconciliationResidual({
    trip: { id: MK003, driver_net_pence: 598, commission_pence: 106 },
    captured_pence: 740,
    session: {
      ...mk003Session,
      trip_fare_component_pence: null,
      tip_component_pence: null,
      receivable_component_pence: null,
      provider_capture_target_pence: null,
      buffer_pence: null,
      purpose: "PAYMENT_RECOVERY",
      metadata: { purpose: "PAYMENT_RECOVERY" },
    },
    receivables: [],
  });
  assertEquals(r.fail_closed, true);
  assertEquals(r.residual_pence, null);

  const agg = computeCardReconciliationIdentityAggregate({
    trips: [{
      id: MK003,
      commission_pence: 106,
      provider_fee_pence: 0,
      onecab_net_pence: 106,
      driver_net_pence: 598,
      gross_fare_pence: 704,
      final_fare_pence: 704,
      commissionable_fare_pence: 704,
      capture_amount_pence: 740,
    }],
    paymentByTrip: new Map([[MK003, 740]]),
    sessionByTrip: new Map([[MK003, {
      ...mk003Session,
      trip_fare_component_pence: null,
      tip_component_pence: null,
      receivable_component_pence: null,
      provider_capture_target_pence: null,
      purpose: "PAYMENT_RECOVERY",
      metadata: { purpose: "PAYMENT_RECOVERY" },
    }]]),
  });
  assertEquals(agg.fail_closed, true);
  assertEquals(agg.balanced, false);
  assertEquals(agg.status, "RECONCILIATION_MISMATCH");
});

Deno.test("Genuine unrelated mismatch remains visible", () => {
  const r = computeTripCardReconciliationResidual({
    trip: { id: "other", driver_net_pence: 40, commission_pence: 50 },
    captured_pence: 100,
    receivables: [],
  });
  assertEquals(r.residual_pence, 10);
  assertEquals(r.fail_closed, false);
});

Deno.test("Historical decline evidence remains immutable RESOLVED_BY_RECEIVABLE_RECOVERY", () => {
  const cls = classifySourceTripReceivableRecovery(
    [{
      source_trip_id: MK017,
      status: "SETTLED",
      outstanding_amount_pence: 0,
      original_amount_pence: 6,
      reserved_payment_session_id: RECOVERY_SESSION,
    }],
    MK017,
  );
  assertEquals(cls.resolved_by_receivable_recovery, true);
  assertEquals(cls.settled_original_pence, 6);
  assertEquals(cls.status, FR_RESOLVED_BY_RECEIVABLE_RECOVERY);
});

Deno.test("Cancelled with fare evidence qualifies; bare cancelled without evidence does not", () => {
  assertEquals(
    tripQualifiesForFinanceReconciliationAudit({
      status: "cancelled",
      driver_net_pence: 430,
      commission_pence: 76,
      final_fare_pence: 506,
      capture_amount_pence: 500,
    }),
    true,
  );
  assertEquals(
    tripHasFrFinancialEvidence({ final_fare_pence: 506 }),
    true,
  );
  assertEquals(
    tripQualifiesForFinanceReconciliationAudit({
      status: "cancelled",
    }),
    false,
  );
  assertEquals(
    FINANCE_RECONCILIATION_TRIP_TERMINAL_OR.includes("cancelled"),
    true,
  );
});

Deno.test("payment-state outstanding from receivable ledger, never fare−capture", () => {
  assertEquals(
    resolveCurrentOutstandingFromReceivables({
      receivablesLedgerAvailable: true,
      receivables: [{
        source_trip_id: MK017,
        status: "SETTLED",
        outstanding_amount_pence: 0,
        original_amount_pence: 6,
      }],
      sourceTripId: MK017,
    }).outstanding_pence,
    0,
  );
  // Legacy 506−500=6 must not be used when ledger says SETTLED.
  assertEquals(506 - 500, 6);
});
