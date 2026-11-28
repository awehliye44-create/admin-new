/** Offline test/audit-only helpers; not part of Edge uploads. */


/** MK acceptance: Revolut £21.76, pending/protected £23.20, payables £1.11 → before reserve £0. */
export const COMPANY_FUNDS_UNDERPROTECTION_ACCEPTANCE_PROOF = {
  REVOLUT_SOURCE_PENCE: 2176,
  PROTECTED_DRIVER_LIABILITIES_PENCE: 2320,
  APPROVED_PAYABLES_PENCE: 111,
  EXPECTED_BEFORE_RESERVE_PENCE: 0,
  EXPECTED_TRANSFERABLE_PENCE: 0,
} as const;

export * from "../../../functions/_shared/companyFundsUnderprotectionSSOT.ts";
