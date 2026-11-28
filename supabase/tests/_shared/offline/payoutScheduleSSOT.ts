/** Offline test/audit-only helpers; not part of Edge uploads. */


/** Guard: reject known legacy hardcodes in labels. */
export function assertNoLegacyMondayHardcode(label: string): boolean {
  const s = label.toLowerCase();
  return !(s.includes("weekly monday") && !s.includes("tuesday"));
}

export * from "../../../functions/_shared/payoutScheduleSSOT.ts";
