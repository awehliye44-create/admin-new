/** Offline test/audit-only helpers; not part of Edge uploads. */


/** Payment Sessions list label for recovery capture rows. */
export function recapturedAmountDisplayLabel(
  recapturedPence: number,
  currencySymbol = "£",
): string {
  const major = (Math.round(recapturedPence) / 100).toFixed(2);
  return `Recaptured ${currencySymbol}${major}`;
}

export * from "../../../functions/_shared/tripHistoryShortfallRecaptureSSOT.ts";
export * from "../../../../shared/edgePresentation/tripHistoryShortfallRecaptureSSOT.ts";
