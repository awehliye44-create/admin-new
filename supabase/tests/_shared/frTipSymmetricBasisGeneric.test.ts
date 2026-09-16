/**
 * FR tip symmetric-basis — GENERIC contract (no trip/driver/amount hardcoding).
 *
 * The shared SSOT must compare expected entitlement components against the
 * matching actual wallet entitlement components for every PLATFORM_COLLECTED
 * trip: TRIP_EARNING_NET + settlement corrections + trip-linked
 * DRIVER_TIP_CREDIT, always using the ledger row amount.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeFrDriverReconciliation,
  sumActualWalletTripCreditsPence,
  sumExpectedPayablePence,
} from "../../functions/_shared/frDriverReconciliationSSOT.ts";
import {
  resolveFrDriverExpectedEntitlement,
  type FrDriverSettlementTripForReconciliation,
} from "../../functions/_shared/frDriverExpectedEntitlementSSOT.ts";

type LedgerRow = { type: string; amount_pence: number; related_trip_id?: string | null };

function trip(input: {
  trip_id: string;
  driver_net_pence: number | null;
  tip_pence?: number;
  commission_pence?: number;
  airport_charge_pence?: number;
  financial_model?: string;
  completed_at?: string;
}): FrDriverSettlementTripForReconciliation {
  const resolved = resolveFrDriverExpectedEntitlement({
    trip_id: input.trip_id,
    driver_net_pence: input.driver_net_pence,
    tip_pence: input.tip_pence ?? 0,
    commission_pence: input.commission_pence ?? null,
    airport_charge_pence: input.airport_charge_pence ?? 0,
    financial_model: input.financial_model ?? "PLATFORM_COLLECTED",
    completed_at: input.completed_at ?? "2026-09-12T18:52:08.060Z",
  });
  return {
    trip_id: input.trip_id,
    driver_net_pence: input.driver_net_pence,
    expected_entitlement_pence: resolved.expected_entitlement_pence,
    expected_stamp_status: resolved.expected_stamp_status,
    financial_settled_at: resolved.financial_settled_at,
  };
}

function recon(args: {
  ledger: LedgerRow[];
  settledTrips: FrDriverSettlementTripForReconciliation[];
  finance_cleared_pence?: number;
}) {
  return computeFrDriverReconciliation({
    ledger: args.ledger,
    // deno-lint-ignore no-explicit-any
    settledTrips: args.settledTrips as any,
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: args.finance_cleared_pence ?? 0,
    provider_account_balance_pence: 0,
    provider_account_balance_status: "AVAILABLE",
  });
}

/** G1 — any tip value reconciles from the ledger amount, never an assumed 100p. */
for (const tip_pence of [1, 50, 100, 250, 500]) {
  Deno.test(`G1. tip ${tip_pence}p reconciles to zero difference from ledger amount`, () => {
    const net = 425;
    const row = recon({
      ledger: [
        { type: "TRIP_EARNING_NET", amount_pence: net, related_trip_id: "t1" },
        { type: "DRIVER_TIP_CREDIT", amount_pence: tip_pence, related_trip_id: "t1" },
      ],
      settledTrips: [trip({ trip_id: "t1", driver_net_pence: net, tip_pence })],
    });
    assertEquals(row.expected_payable_pence, net + tip_pence);
    assertEquals(row.actual_wallet_trip_credits_pence, net + tip_pence);
    assertEquals(row.wallet_variance_pence, 0);
    assertEquals(row.driver_credit_status, "DRIVER_CREDIT_OK");
  });
}

/** G2 — ledger amount wins when it disagrees with an assumed value. */
Deno.test("G2. ledger tip amount is authoritative (no 100p assumption)", () => {
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 700, related_trip_id: "t1" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 250, related_trip_id: "t1" },
    ],
    settledTrips: [trip({ trip_id: "t1", driver_net_pence: 700, tip_pence: 250 })],
  });
  assertEquals(row.actual_wallet_trip_credits_pence, 950);
  assertEquals(row.wallet_variance_pence, 0);
});

/** G3 — multiple trips for the same driver, mixed tipped and untipped. */
Deno.test("G3. same driver, many trips, mixed tips — all counted exactly once", () => {
  const ledger: LedgerRow[] = [
    { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
    { type: "DRIVER_TIP_CREDIT", amount_pence: 50, related_trip_id: "t1" },
    { type: "TRIP_EARNING_NET", amount_pence: 900, related_trip_id: "t2" },
    { type: "TRIP_EARNING_NET", amount_pence: 1200, related_trip_id: "t3" },
    { type: "DRIVER_TIP_CREDIT", amount_pence: 500, related_trip_id: "t3" },
  ];
  const settledTrips = [
    trip({ trip_id: "t1", driver_net_pence: 425, tip_pence: 50 }),
    trip({ trip_id: "t2", driver_net_pence: 900 }),
    trip({ trip_id: "t3", driver_net_pence: 1200, tip_pence: 500 }),
  ];
  const row = recon({ ledger, settledTrips });
  assertEquals(row.expected_payable_pence, 3075);
  assertEquals(row.actual_wallet_trip_credits_pence, 3075);
  assertEquals(row.wallet_variance_pence, 0);
});

/** G4 — two independent drivers: each ledger is scoped, no cross-crediting. */
Deno.test("G4. multiple drivers stay isolated — tip of driver B never credits driver A", () => {
  const driverA = recon({
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "a1" }],
    settledTrips: [trip({ trip_id: "a1", driver_net_pence: 425 })],
  });
  const driverB = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 610, related_trip_id: "b1" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 250, related_trip_id: "b1" },
    ],
    settledTrips: [trip({ trip_id: "b1", driver_net_pence: 610, tip_pence: 250 })],
  });
  assertEquals(driverA.actual_wallet_trip_credits_pence, 425);
  assertEquals(driverA.wallet_variance_pence, 0);
  assertEquals(driverB.actual_wallet_trip_credits_pence, 860);
  assertEquals(driverB.wallet_variance_pence, 0);
});

/** G5 — tip linked to a trip outside the evaluated scope is not pulled in. */
Deno.test("G5. tip linked to another trip is excluded from the scoped basis", () => {
  const ledger: LedgerRow[] = [
    { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
    { type: "DRIVER_TIP_CREDIT", amount_pence: 250, related_trip_id: "other-trip" },
  ];
  assertEquals(sumActualWalletTripCreditsPence(ledger, new Set(["t1"])), 425);
});

/** G6 — genuine under-credit must stay visible (fix cannot hide a mismatch). */
Deno.test("G6. missing tip credit remains DRIVER_UNDER_CREDITED", () => {
  const row = recon({
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" }],
    settledTrips: [trip({ trip_id: "t1", driver_net_pence: 425, tip_pence: 250 })],
  });
  assertEquals(row.expected_payable_pence, 675);
  assertEquals(row.actual_wallet_trip_credits_pence, 425);
  assertEquals(row.wallet_variance_pence, -250);
  assertEquals(row.driver_credit_status, "DRIVER_UNDER_CREDITED");
});

/** G7 — genuine over-credit must stay visible. */
Deno.test("G7. duplicated tip ledger rows surface as over-credit, not silently netted", () => {
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t1" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t1" },
    ],
    settledTrips: [trip({ trip_id: "t1", driver_net_pence: 425, tip_pence: 100 })],
  });
  assertEquals(row.expected_payable_pence, 525);
  assertEquals(row.actual_wallet_trip_credits_pence, 625);
  assertEquals(row.wallet_variance_pence, 100);
  assertEquals(row.driver_credit_status, "DRIVER_OVER_CREDITED");
});

/** G8 — unrelated bonus and manual credit never absorb a real shortfall. */
Deno.test("G8. bonus + manual credit cannot mask a missing tip credit", () => {
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 425, related_trip_id: "t1" },
      { type: "BONUS", amount_pence: 500 },
      { type: "MANUAL_CREDIT", amount_pence: 100 },
    ],
    settledTrips: [trip({ trip_id: "t1", driver_net_pence: 425, tip_pence: 100 })],
  });
  assertEquals(row.wallet_variance_pence, -100);
  assertEquals(row.driver_credit_status, "DRIVER_UNDER_CREDITED");
});

/** G9 — legitimate settlement correction is part of the trip entitlement basis. */
Deno.test("G9. settlement correction + tip both count in the actual basis", () => {
  const row = recon({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 400, related_trip_id: "t1" },
      { type: "TRIP_SETTLEMENT_CORRECTION", amount_pence: 25, related_trip_id: "t1" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t1" },
    ],
    settledTrips: [trip({ trip_id: "t1", driver_net_pence: 425, tip_pence: 100 })],
  });
  assertEquals(row.actual_wallet_trip_credits_pence, 525);
  assertEquals(row.wallet_variance_pence, 0);
});

/** G10 — airport entitlement + dynamic commission + tip stay balanced. */
Deno.test("G10. airport (folded and separate) + dynamic commission + tip stays balanced", () => {
  for (const commission_pence of [0, 90, 150, 300]) {
    // Airport folded into driver_net by the fare engine.
    const folded = recon({
      ledger: [
        { type: "TRIP_EARNING_NET", amount_pence: 1500, related_trip_id: "t1" },
        { type: "PLATFORM_COMMISSION", amount_pence: commission_pence, related_trip_id: "t1" },
        { type: "DRIVER_TIP_CREDIT", amount_pence: 250, related_trip_id: "t1" },
      ],
      settledTrips: [trip({
        trip_id: "t1",
        driver_net_pence: 1500,
        commission_pence,
        tip_pence: 250,
      })],
    });
    assertEquals(folded.expected_payable_pence, 1750);
    assertEquals(folded.wallet_variance_pence, 0);

    // Airport stamped separately — credited on top of driver_net in the wallet.
    const separate = recon({
      ledger: [
        { type: "TRIP_EARNING_NET", amount_pence: 1500, related_trip_id: "t1" },
        { type: "PLATFORM_COMMISSION", amount_pence: commission_pence, related_trip_id: "t1" },
        { type: "DRIVER_TIP_CREDIT", amount_pence: 250, related_trip_id: "t1" },
      ],
      settledTrips: [trip({
        trip_id: "t1",
        driver_net_pence: 1000,
        airport_charge_pence: 500,
        commission_pence,
        tip_pence: 250,
      })],
    });
    assertEquals(separate.expected_payable_pence, 1750);
    assertEquals(separate.wallet_variance_pence, 0);
  }
});

/** G11 — historical and future PLATFORM_COLLECTED trips use the same basis. */
Deno.test("G11. historical and future completed trips reconcile identically", () => {
  for (const completed_at of ["2025-01-05T09:00:00.000Z", "2027-04-21T21:15:00.000Z"]) {
    const row = recon({
      ledger: [
        { type: "TRIP_EARNING_NET", amount_pence: 500, related_trip_id: "t1" },
        { type: "DRIVER_TIP_CREDIT", amount_pence: 100, related_trip_id: "t1" },
      ],
      settledTrips: [trip({ trip_id: "t1", driver_net_pence: 500, tip_pence: 100, completed_at })],
    });
    assertEquals(row.expected_payable_pence, 600);
    assertEquals(row.wallet_variance_pence, 0);
  }
});

/** G12 — DRIVER_COLLECTED trips carry no wallet entitlement stamp. */
Deno.test("G12. DRIVER_COLLECTED isolation preserved for tipped trips", () => {
  const collected = trip({
    trip_id: "t9",
    driver_net_pence: 900,
    tip_pence: 250,
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
  });
  assertEquals(collected.expected_entitlement_pence, null);
  assertEquals(collected.expected_stamp_status, "EXPECTED_STAMP_MISSING");
  // Missing stamp with no evaluable trip → null, never a silent 0 comparison.
  assertEquals(sumExpectedPayablePence([collected]), null);
});

/** G13 — no-tip drivers are byte-identical before/after the corrected basis. */
Deno.test("G13. no-tip ledgers unchanged by the tip-inclusive basis", () => {
  const ledger: LedgerRow[] = [
    { type: "TRIP_EARNING_NET", amount_pence: 408, related_trip_id: "t1" },
    { type: "TRIP_EARNING_NET", amount_pence: 512, related_trip_id: "t2" },
    { type: "PLATFORM_COMMISSION", amount_pence: 72, related_trip_id: "t1" },
  ];
  assertEquals(sumActualWalletTripCreditsPence(ledger), 920);
  const row = recon({
    ledger,
    settledTrips: [
      trip({ trip_id: "t1", driver_net_pence: 408 }),
      trip({ trip_id: "t2", driver_net_pence: 512 }),
    ],
  });
  assertEquals(row.wallet_variance_pence, 0);
  assertEquals(row.driver_credit_status, "DRIVER_CREDIT_OK");
});
