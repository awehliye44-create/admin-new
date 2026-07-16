import { describe, expect, it } from "vitest";
import {
  SLICE10,
  SLICE10_PROOF,
  RESERVE_MODE,
  RESERVE_POLICY_STATUS,
  OPERATIONAL_RESERVE_ERROR,
  computeEligibleCompanyCashPence,
  computeClassifiedCompanyCashPence,
  computeTransferableBasePence,
  computeOperationalReserveAmountPence,
  computeFinalCompanyAvailablePence,
  evaluateActiveReservePolicy,
  resolveOperationalReserveAmount,
  validateReservePolicyDraft,
  assertFinalCompanyTransferAllowed,
  parsePolicyRow,
} from "../../../shared/companyOperationalReserveSSOT";
import {
  computeCompanyAvailableBeforeOperationalReservePence,
  computeCompanyAvailableForTransferPence,
  resolveCompanyBalanceSnapshot,
  assertCompanyTransferFundingAvailable,
} from "../../../shared/companyBalanceSSOT";

const {
  SOURCE_PENCE,
  LIABILITY_PENCE,
  RESERVED_PENCE,
  BEFORE_RESERVE_PENCE,
  NET_COMMISSION_PENCE,
  UNCLASSIFIED_PENCE,
} = SLICE10_PROOF;

describe("Slice 10 operational reserve SSOT", () => {
  it("exports slice marker", () => {
    expect(SLICE10).toBe(10);
  });

  it("before-config proof: eligible 525, classified 172, unclassified 353, reserve NOT_CONFIGURED, final UNAVAILABLE", () => {
    const eligible = computeEligibleCompanyCashPence({
      provider_available_balance_pence: SOURCE_PENCE,
      driver_liability_pence: LIABILITY_PENCE,
      approved_company_payables_pence: 0,
    });
    expect(eligible).toBe(BEFORE_RESERVE_PENCE);
    expect(eligible).toBe(
      computeCompanyAvailableBeforeOperationalReservePence({
        provider_available_balance_pence: SOURCE_PENCE,
        driver_liability_pence: LIABILITY_PENCE,
        approved_company_payables_pence: 0,
      }),
    );

    const classified = computeClassifiedCompanyCashPence({
      recognised_net_commission_pence: NET_COMMISSION_PENCE,
    });
    expect(classified).toBe(NET_COMMISSION_PENCE);
    expect(BEFORE_RESERVE_PENCE - NET_COMMISSION_PENCE).toBe(UNCLASSIFIED_PENCE);

    const base = computeTransferableBasePence({
      eligible_company_cash_pence: eligible,
      classified_company_cash_pence: classified,
    });
    expect(base).toBe(NET_COMMISSION_PENCE);

    const none = resolveOperationalReserveAmount({
      policy: null,
      currency: "GBP",
      eligible_company_cash_pence: eligible,
    });
    expect(none.status).toBe("NOT_CONFIGURED");
    expect(none.reason_code).toBe(OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED);
    expect(none.amount_pence).toBeNull();

    expect(computeFinalCompanyAvailablePence({
      eligible_company_cash_pence: eligible,
      classified_company_cash_pence: classified,
      operational_reserve_pence: null,
    })).toBeNull();

    expect(computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: SOURCE_PENCE,
      driver_liability_pence: LIABILITY_PENCE,
      driver_payout_reserved_pence: RESERVED_PENCE,
      approved_company_payables_pence: 0,
      operational_reserve_pence: null,
      classified_company_cash_pence: classified,
    })).toBeNull();

    const snap = resolveCompanyBalanceSnapshot({
      currency: "GBP",
      provider_available_balance_pence: SOURCE_PENCE,
      driver_liability_pence: LIABILITY_PENCE,
      driver_payout_reserved_pence: RESERVED_PENCE,
      approved_company_payables_pence: 0,
      operational_reserve_pence: null,
      classified_company_cash_pence: classified,
      status_code: "AVAILABLE",
    });
    expect(snap.company_available_before_operational_reserve_pence).toBe(525);
    expect(snap.company_available_for_transfer_pence).toBeNull();
    expect(snap.sections?.operational_reserve.status).toBe("NOT_CONFIGURED");
    expect(snap.sections?.company_transfer_available.status).toBe("UNAVAILABLE");
  });

  it("FIXED_AMOUNT + ACTIVE: final = min(eligible, classified) − reserve (excludes unclassified)", () => {
    const eligible = BEFORE_RESERVE_PENCE;
    const classified = NET_COMMISSION_PENCE;
    const policy = {
      service_area_id: "mk-sa",
      currency: "GBP",
      reserve_mode: RESERVE_MODE.FIXED_AMOUNT,
      reserve_amount_pence: 1,
      reserve_percentage_bps: null,
      minimum_reserve_pence: 0,
      effective_from: "2026-01-01",
      effective_to: null,
      status: RESERVE_POLICY_STATUS.ACTIVE,
    };
    const resolved = resolveOperationalReserveAmount({
      policy,
      currency: "GBP",
      service_area_id: "mk-sa",
      eligible_company_cash_pence: eligible,
    });
    expect(resolved.status).toBe("ACTIVE");
    expect(resolved.amount_pence).toBe(1);

    expect(computeFinalCompanyAvailablePence({
      eligible_company_cash_pence: eligible,
      classified_company_cash_pence: classified,
      operational_reserve_pence: 1,
    })).toBe(171);

    // Unclassified 353 never enters transferable base
    expect(computeTransferableBasePence({
      eligible_company_cash_pence: eligible,
      classified_company_cash_pence: classified,
    })).not.toBe(BEFORE_RESERVE_PENCE);
  });

  it("PERCENTAGE: reserve = max(minimum, round(eligible * bps / 10000))", () => {
    const amount = computeOperationalReserveAmountPence({
      policy: {
        reserve_mode: RESERVE_MODE.PERCENTAGE,
        reserve_amount_pence: null,
        reserve_percentage_bps: 1000, // 10%
        minimum_reserve_pence: 100,
      },
      eligible_company_cash_pence: 525,
    });
    // 10% of 525 = 53; minimum 100 → 100
    expect(amount).toBe(100);

    const bare = computeOperationalReserveAmountPence({
      policy: {
        reserve_mode: RESERVE_MODE.PERCENTAGE,
        reserve_amount_pence: null,
        reserve_percentage_bps: 1000,
        minimum_reserve_pence: 0,
      },
      eligible_company_cash_pence: 525,
    });
    expect(bare).toBe(53);
  });

  it("DRAFT / DISABLED do not unlock final funds", () => {
    for (const status of [RESERVE_POLICY_STATUS.DRAFT, RESERVE_POLICY_STATUS.DISABLED] as const) {
      const r = evaluateActiveReservePolicy({
        policy: {
          service_area_id: null,
          currency: "GBP",
          reserve_mode: RESERVE_MODE.FIXED_AMOUNT,
          reserve_amount_pence: 0,
          reserve_percentage_bps: null,
          minimum_reserve_pence: 0,
          effective_from: null,
          effective_to: null,
          status,
        },
        currency: "GBP",
      });
      expect(r.status).toBe("NOT_CONFIGURED");
      expect(r.reason_code).toBe(OPERATIONAL_RESERVE_ERROR.INACTIVE);
      expect(r.amount_pence).toBeNull();
    }
  });

  it("currency mismatch / stale effective window fail closed", () => {
    const base = {
      service_area_id: null,
      currency: "GBP",
      reserve_mode: RESERVE_MODE.FIXED_AMOUNT,
      reserve_amount_pence: 1,
      reserve_percentage_bps: null,
      minimum_reserve_pence: 0,
      effective_from: "2026-01-01T00:00:00.000Z",
      effective_to: "2026-06-01T00:00:00.000Z",
      status: RESERVE_POLICY_STATUS.ACTIVE,
    };
    expect(evaluateActiveReservePolicy({
      policy: base,
      currency: "EUR",
    }).reason_code).toBe(OPERATIONAL_RESERVE_ERROR.CURRENCY_MISMATCH);

    expect(evaluateActiveReservePolicy({
      policy: base,
      currency: "GBP",
      as_of: "2026-07-15T00:00:00.000Z",
    }).reason_code).toBe(OPERATIONAL_RESERVE_ERROR.STALE);

    expect(evaluateActiveReservePolicy({
      policy: { ...base, effective_from: "2026-12-01T00:00:00.000Z", effective_to: null },
      currency: "GBP",
      as_of: "2026-07-15T00:00:00.000Z",
    }).reason_code).toBe(OPERATIONAL_RESERVE_ERROR.STALE);
  });

  it("company transfer gate uses final_company_available only", () => {
    const snap = resolveCompanyBalanceSnapshot({
      currency: "GBP",
      provider_available_balance_pence: SOURCE_PENCE,
      driver_liability_pence: LIABILITY_PENCE,
      driver_payout_reserved_pence: RESERVED_PENCE,
      approved_company_payables_pence: 0,
      operational_reserve_pence: 0,
      classified_company_cash_pence: NET_COMMISSION_PENCE,
      status_code: "AVAILABLE",
    });
    // Safer base: min(525, 172) − 0 = 172 — never 525 (includes unclassified)
    expect(snap.company_available_for_transfer_pence).toBe(172);
    expect(snap.company_available_before_operational_reserve_pence).toBe(525);

    expect(() => assertCompanyTransferFundingAvailable({
      money_source: "COMPANY_BALANCE",
      company_balance: snap,
      amount_pence: 172,
    })).not.toThrow();

    expect(() => assertCompanyTransferFundingAvailable({
      money_source: "COMPANY_BALANCE",
      company_balance: {
        ...snap,
        company_available_for_transfer_pence: null,
        final_company_available_pence: null,
      },
      amount_pence: 1,
    })).toThrow();

    expect(() => assertFinalCompanyTransferAllowed({
      final_company_available_pence: null,
      reserve_reason_code: OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED,
    })).toThrow(OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED);
  });

  it("liabilities remain protected — reserved not double-subtracted", () => {
    const final = computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: SOURCE_PENCE,
      driver_liability_pence: LIABILITY_PENCE,
      driver_payout_reserved_pence: RESERVED_PENCE,
      approved_company_payables_pence: 0,
      operational_reserve_pence: 0,
      classified_company_cash_pence: NET_COMMISSION_PENCE,
    });
    expect(final).toBe(172);
    // If reserved were subtracted again: min(525-1001, …) nonsense — stay at 172
    expect(final).not.toBe(SOURCE_PENCE - LIABILITY_PENCE - RESERVED_PENCE);
  });

  it("validateReservePolicyDraft + parsePolicyRow", () => {
    expect(validateReservePolicyDraft({
      reserve_mode: "FIXED_AMOUNT",
      reserve_amount_pence: 1,
      currency: "GBP",
    }).ok).toBe(true);
    expect(validateReservePolicyDraft({
      reserve_mode: "PERCENTAGE",
      reserve_percentage_bps: 250,
      minimum_reserve_pence: 50,
      currency: "GBP",
    }).ok).toBe(true);
    expect(validateReservePolicyDraft({
      reserve_mode: "FIXED_AMOUNT",
      reserve_amount_pence: -1,
    }).ok).toBe(false);

    const parsed = parsePolicyRow({
      id: "x",
      service_area_id: "sa",
      currency: "gbp",
      reserve_mode: "FIXED_AMOUNT",
      reserve_amount_pence: 1,
      status: "DRAFT",
      effective_from: "2026-07-15",
    });
    expect(parsed?.currency).toBe("GBP");
    expect(parsed?.status).toBe("DRAFT");
  });

  it("missing classified cash fail-closed even with ACTIVE reserve amount", () => {
    expect(computeFinalCompanyAvailablePence({
      eligible_company_cash_pence: 525,
      classified_company_cash_pence: null,
      operational_reserve_pence: 0,
    })).toBeNull();
    expect(computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: SOURCE_PENCE,
      driver_liability_pence: LIABILITY_PENCE,
      operational_reserve_pence: 0,
      classified_company_cash_pence: null,
    })).toBeNull();
  });

  it("PERCENTAGE path: reserve from eligible, final from transferable_base only", () => {
    const eligible = BEFORE_RESERVE_PENCE; // 525
    const classified = NET_COMMISSION_PENCE; // 172
    const reserve = computeOperationalReserveAmountPence({
      policy: {
        reserve_mode: RESERVE_MODE.PERCENTAGE,
        reserve_amount_pence: null,
        reserve_percentage_bps: 1000, // 10% → 53
        minimum_reserve_pence: 0,
      },
      eligible_company_cash_pence: eligible,
    });
    expect(reserve).toBe(53);
    // final = min(525,172) − 53 = 119 — never eligible−reserve (472) and never includes unclassified
    expect(computeFinalCompanyAvailablePence({
      eligible_company_cash_pence: eligible,
      classified_company_cash_pence: classified,
      operational_reserve_pence: reserve,
    })).toBe(119);
    expect(eligible - (reserve ?? 0)).toBe(472);
    expect(BEFORE_RESERVE_PENCE - NET_COMMISSION_PENCE).toBe(UNCLASSIFIED_PENCE);
  });

  it("approved payables deducted once in eligible — not again in final", () => {
    const source = 2000;
    const liabilities = 1000;
    const payables = 200;
    const classified = 500;
    const reserve = 50;
    const eligible = computeEligibleCompanyCashPence({
      provider_available_balance_pence: source,
      driver_liability_pence: liabilities,
      approved_company_payables_pence: payables,
    });
    expect(eligible).toBe(800); // 2000 − 1000 − 200
    // Spec §6 safer: final = min(eligible, classified) − reserve = min(800,500) − 50 = 450
    // Wrong double-subtract would be min(800,500) − payables − reserve = 250
    expect(computeFinalCompanyAvailablePence({
      eligible_company_cash_pence: eligible,
      classified_company_cash_pence: classified,
      operational_reserve_pence: reserve,
    })).toBe(450);
    expect(computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: source,
      driver_liability_pence: liabilities,
      approved_company_payables_pence: payables,
      operational_reserve_pence: reserve,
      classified_company_cash_pence: classified,
    })).toBe(450);
    expect(450).not.toBe(classified - payables - reserve);
  });

  it("transfer gate blocked with explicit OPERATIONAL_RESERVE_NOT_CONFIGURED (not silent zero)", () => {
    const snap = resolveCompanyBalanceSnapshot({
      currency: "GBP",
      provider_available_balance_pence: SOURCE_PENCE,
      driver_liability_pence: LIABILITY_PENCE,
      driver_payout_reserved_pence: RESERVED_PENCE,
      approved_company_payables_pence: 0,
      operational_reserve_pence: null,
      operational_reserve_reason_code: OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED,
      classified_company_cash_pence: NET_COMMISSION_PENCE,
      status_code: "AVAILABLE",
    });
    expect(snap.company_available_for_transfer_pence).toBeNull();
    expect(snap.final_company_available_pence).toBeNull();
    expect(snap.sections?.operational_reserve.status).toBe("NOT_CONFIGURED");
    expect(snap.sections?.operational_reserve.reason_code)
      .toBe(OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED);
    expect(snap.sections?.company_transfer_available.status).toBe("UNAVAILABLE");
    expect(snap.sections?.company_transfer_available.reason_code)
      .toBe(OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED);
    expect(snap.company_available_for_transfer_pence).not.toBe(0);

    expect(() => assertCompanyTransferFundingAvailable({
      money_source: "COMPANY_BALANCE",
      company_balance: snap,
      amount_pence: 1,
    })).toThrow(OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED);
  });

  it("preserves QUERY_FAILED / STALE reserve reasons (fail-closed, explicit)", () => {
    for (const code of [
      OPERATIONAL_RESERVE_ERROR.QUERY_FAILED,
      OPERATIONAL_RESERVE_ERROR.STALE,
      OPERATIONAL_RESERVE_ERROR.CURRENCY_MISMATCH,
    ] as const) {
      const snap = resolveCompanyBalanceSnapshot({
        currency: "GBP",
        provider_available_balance_pence: SOURCE_PENCE,
        driver_liability_pence: LIABILITY_PENCE,
        operational_reserve_pence: null,
        operational_reserve_reason_code: code,
        classified_company_cash_pence: NET_COMMISSION_PENCE,
        status_code: "AVAILABLE",
      });
      expect(snap.sections?.operational_reserve.reason_code).toBe(code);
      expect(snap.sections?.company_transfer_available.reason_code).toBe(code);
      expect(snap.company_available_for_transfer_pence).toBeNull();
      expect(() => assertCompanyTransferFundingAvailable({
        money_source: "COMPANY_BALANCE",
        company_balance: snap,
        amount_pence: 1,
      })).toThrow(code);
    }
  });
});
