/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Trip-modification payment gate SSOT (MK-260915-002).
 *
 * Fare-increasing modifications must not mutate trip destination/stops/fare
 * until provider read-back proves authorised TOTAL covers the new payable.
 * Processing / pending / unknown never unlock apply.
 *
 * Pure helpers — no wallet, commission, payout, invoice, or capture writes.
 */

import {
  revolutProviderAuthorisedTotalPence,
  type RevolutOrder,
} from "../../../functions/_shared/revolutOrders.ts";

import { findBankDeclineReason } from "../../../functions/_shared/revolutCustomerError.ts";
import { ModificationPaymentGateDecision, decideModificationIncrementCoverage, MODIFICATION_AUTH_FORBIDDEN_MUTATIONS } from "../../../functions/_shared/tripModificationPaymentGateSSOT.ts";


/** Pounds→pence exact conversion for money display values (never float fare math). */
export function poundsToPenceExact(pounds: number): number {
  return Math.round(Number(pounds) * 100);
}


/**
 * Optimistic concurrency: apply only when trip still matches the fare basis
 * the modification was quoted against. Concurrent winners move the fare;
 * losers must not stack a second delta.
 */
export function tripFareBasisMatchesExpectation(args: {
  expectedPreviousFarePence: number | null | undefined;
  currentCommittedFarePence: number | null | undefined;
}): boolean {
  const expected = Math.round(Number(args.expectedPreviousFarePence ?? NaN));
  const current = Math.round(Number(args.currentCommittedFarePence ?? NaN));
  if (!Number.isFinite(expected) || expected < 0) return false;
  if (!Number.isFinite(current) || current < 0) return false;
  return expected === current;
}


/**
 * Internal simulator for the £5.00→£8.11 class of cases without hard-coding
 * those amounts into production paths. Inputs are arbitrary pence.
 */
export function simulateModificationAuthorisationSequence(args: {
  originalAuthorisedPence: number;
  requiredPayablePence: number;
  providerSnapshots: Array<RevolutOrder | null>;
}): {
  decisions: ModificationPaymentGateDecision[];
  applied: boolean;
  finalAuthorisedPence: number;
} {
  const decisions: ModificationPaymentGateDecision[] = [];
  let applied = false;
  let finalAuthorised = Math.round(Number(args.originalAuthorisedPence));

  for (const snapshot of args.providerSnapshots) {
    const decision = decideModificationIncrementCoverage({
      order: snapshot,
      requiredPayablePence: args.requiredPayablePence,
    });
    decisions.push(decision);
    finalAuthorised = decision.authorisedTotalPence;
    if (decision.mayApply) {
      applied = true;
      break;
    }
    if (decision.phase === "PAYMENT_FAILED") {
      break;
    }
  }

  return { decisions, applied, finalAuthorisedPence: finalAuthorised };
}


export function assertNoForbiddenModificationAuthMutation(kind: string): boolean {
  return !(MODIFICATION_AUTH_FORBIDDEN_MUTATIONS as readonly string[]).includes(kind);
}

export * from "../../../functions/_shared/tripModificationPaymentGateSSOT.ts";
