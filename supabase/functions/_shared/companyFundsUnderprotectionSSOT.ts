/**
 * Company funds underprotection — read-only classification (pure SSOT).
 *
 * When protected driver liabilities + approved payables exceed Revolut source cash,
 * ONECAB company-transfer liquidity is £0 and company transfers must be blocked.
 * Driver payout gates remain separate — owner may still fund Revolut for driver payouts.
 */

export const COMPANY_FUNDS_UNDERPROTECTED = {
  REASON_CODE: "DRIVER_LIABILITIES_EXCEED_REVOLUT_SOURCE",
  MESSAGE:
    "Company funds unavailable — driver liabilities exceed Revolut balance.",
} as const;

export type CompanyFundsUnderprotectionEvaluation = {
  underprotected: boolean;
  reason_code: typeof COMPANY_FUNDS_UNDERPROTECTED.REASON_CODE | null;
  message: string | null;
  protected_plus_payables_pence: number | null;
  shortfall_pence: number | null;
};

function nonNeg(n: unknown): number {
  const v = Math.round(Number(n ?? 0));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Fail-closed: unknown inputs → not underprotected (no invented warning). */
export function evaluateCompanyFundsUnderprotection(args: {
  provider_available_balance_pence: number | null;
  protected_driver_liabilities_pence: number | null;
  approved_company_payables_pence?: number | null;
}): CompanyFundsUnderprotectionEvaluation {
  if (args.provider_available_balance_pence == null) {
    return {
      underprotected: false,
      reason_code: null,
      message: null,
      protected_plus_payables_pence: null,
      shortfall_pence: null,
    };
  }
  if (args.protected_driver_liabilities_pence == null) {
    return {
      underprotected: false,
      reason_code: null,
      message: null,
      protected_plus_payables_pence: null,
      shortfall_pence: null,
    };
  }

  const source = Math.max(0, Math.round(args.provider_available_balance_pence));
  const protectedPlus = nonNeg(args.protected_driver_liabilities_pence)
    + nonNeg(args.approved_company_payables_pence);

  if (protectedPlus <= source) {
    return {
      underprotected: false,
      reason_code: null,
      message: null,
      protected_plus_payables_pence: protectedPlus,
      shortfall_pence: 0,
    };
  }

  return {
    underprotected: true,
    reason_code: COMPANY_FUNDS_UNDERPROTECTED.REASON_CODE,
    message: COMPANY_FUNDS_UNDERPROTECTED.MESSAGE,
    protected_plus_payables_pence: protectedPlus,
    shortfall_pence: protectedPlus - source,
  };
}

/** MK acceptance: Revolut £21.76, pending/protected £23.20, payables £1.11 → before reserve £0. */
export const COMPANY_FUNDS_UNDERPROTECTION_ACCEPTANCE_PROOF = {
  REVOLUT_SOURCE_PENCE: 2176,
  PROTECTED_DRIVER_LIABILITIES_PENCE: 2320,
  APPROVED_PAYABLES_PENCE: 111,
  EXPECTED_BEFORE_RESERVE_PENCE: 0,
  EXPECTED_TRANSFERABLE_PENCE: 0,
} as const;
