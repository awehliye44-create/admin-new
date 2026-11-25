/**
 * PayableFareSSOT — immutable versioned final payable for a financial operation.
 * Waiting counted exactly once via waiting_basis (G-FC / force_complete).
 */

export type WaitingBasis = "columns" | "included_in_fare" | "none";

export type PayableSnapshotSource =
  | "booking"
  | "completion"
  | "modification"
  | "negotiation_commit"
  | "force_complete"
  | "tip_finalize"
  | "admin_capture"
  | "composition"
  | "recovery";

export type PayableFareSnapshotInput = {
  grossFarePence?: number | null;
  modificationPence?: number | null;
  waitingPence?: number | null;
  discountPence?: number | null;
  airportPassThroughPence?: number | null;
  tipPence?: number | null;
  receivablesPence?: number | null;
  /** When admin/force fare already includes waiting, set included_in_fare and waitingPence=0. */
  waitingBasis?: WaitingBasis;
  source: PayableSnapshotSource;
  currency?: string;
};

export type PayableFareSnapshot = {
  source: PayableSnapshotSource;
  gross_fare_pence: number;
  modification_pence: number;
  waiting_pence: number;
  discount_pence: number;
  airport_pass_through_pence: number;
  tip_pence: number;
  receivables_pence: number;
  total_payable_pence: number;
  waiting_basis: WaitingBasis;
  currency: string;
};

function intPence(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return n;
}

function nonNeg(value: unknown): number {
  return Math.max(0, intPence(value));
}

/**
 * Build an immutable payable snapshot.
 * Composition (waiting, discounts, tips, receivables) is included before coverage.
 */
export function buildPayableFareSnapshot(input: PayableFareSnapshotInput): PayableFareSnapshot {
  const waitingBasis: WaitingBasis = input.waitingBasis ?? "columns";
  const waiting = waitingBasis === "included_in_fare" || waitingBasis === "none"
    ? 0
    : nonNeg(input.waitingPence);

  const gross = nonNeg(input.grossFarePence);
  const modification = intPence(input.modificationPence); // signed allowed
  const discount = nonNeg(input.discountPence);
  const airport = nonNeg(input.airportPassThroughPence);
  const tip = nonNeg(input.tipPence);
  const receivables = nonNeg(input.receivablesPence);

  // Route/gross + signed mods + waiting (once) + airport + tip + receivables − discount.
  const total = Math.max(
    0,
    gross + modification + waiting + airport + tip + receivables - discount,
  );

  return {
    source: input.source,
    gross_fare_pence: gross,
    modification_pence: modification,
    waiting_pence: waiting,
    discount_pence: discount,
    airport_pass_through_pence: airport,
    tip_pence: tip,
    receivables_pence: receivables,
    total_payable_pence: total,
    waiting_basis: waitingBasis,
    currency: String(input.currency ?? "GBP").trim() || "GBP",
  };
}

/**
 * force_complete / admin fare that already embeds waiting must not re-add columns.
 */
export function forceCompletePayableSnapshot(args: {
  adminFarePence: number;
  pickupWaitingPence?: number | null;
  stopWaitingPence?: number | null;
  airportPence?: number | null;
  tipPence?: number | null;
  receivablesPence?: number | null;
  /** True when adminFarePence already includes waiting charges. */
  adminFareIncludesWaiting: boolean;
}): PayableFareSnapshot {
  const waitingColumns =
    nonNeg(args.pickupWaitingPence) + nonNeg(args.stopWaitingPence);
  if (args.adminFareIncludesWaiting) {
    return buildPayableFareSnapshot({
      source: "force_complete",
      grossFarePence: nonNeg(args.adminFarePence),
      waitingPence: 0,
      waitingBasis: "included_in_fare",
      airportPassThroughPence: args.airportPence,
      tipPence: args.tipPence,
      receivablesPence: args.receivablesPence,
    });
  }
  return buildPayableFareSnapshot({
    source: "force_complete",
    grossFarePence: nonNeg(args.adminFarePence),
    waitingPence: waitingColumns,
    waitingBasis: "columns",
    airportPassThroughPence: args.airportPence,
    tipPence: args.tipPence,
    receivablesPence: args.receivablesPence,
  });
}

export function requiredAuthorisedTotalFromSnapshot(
  snapshot: PayableFareSnapshot,
): number {
  // Tips may be authorised with fare at completion; receivables included (composition-before-cover).
  return snapshot.total_payable_pence;
}
