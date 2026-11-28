/** Offline test/audit-only helpers; not part of Edge uploads. */
import { CoverageResolveSource, positivePenceOrNull, resolveInitialAuthorisedHoldPence, intPence } from "../../../functions/_shared/authorisationProjectionSSOT.ts";


/**
 * Decision coverage: provider-confirmed first, else local total mirror.
 * Does not invent coverage from missing provider + missing total.
 */
export function resolveSessionAuthorisedCoveragePence(args: {
  providerConfirmedAuthorisedPence?: number | null;
  providerAuthKnown?: boolean;
  total_authorised_amount_pence?: number | null;
  authorised_amount_pence?: number | null;
  original_authorised_pence?: number | null;
}): { coveragePence: number | null; source: CoverageResolveSource } {
  if (args.providerAuthKnown === true) {
    const provider = positivePenceOrNull(args.providerConfirmedAuthorisedPence);
    if (provider != null) {
      return { coveragePence: provider, source: "provider" };
    }
  } else {
    const provider = positivePenceOrNull(args.providerConfirmedAuthorisedPence);
    if (provider != null) {
      return { coveragePence: provider, source: "provider" };
    }
  }

  const total = positivePenceOrNull(args.total_authorised_amount_pence);
  if (total != null) {
    return { coveragePence: total, source: "local_total" };
  }

  const original = resolveInitialAuthorisedHoldPence(args);
  if (original != null) {
    return { coveragePence: original, source: "local_original_fallback" };
  }

  return { coveragePence: null, source: "unknown" };
}


/** Whether an UPDATE may change authorised_amount_pence (app-side precheck). */
export function mayWriteOriginalAuthorisedAmount(args: {
  existingAuthorisedPence?: number | null;
  nextAuthorisedPence?: number | null;
}): boolean {
  const existing = intPence(args.existingAuthorisedPence);
  if (existing <= 0) return true;
  const next = args.nextAuthorisedPence == null ? null : intPence(args.nextAuthorisedPence);
  if (next == null) return false;
  return next === existing;
}

export * from "../../../functions/_shared/authorisationProjectionSSOT.ts";
