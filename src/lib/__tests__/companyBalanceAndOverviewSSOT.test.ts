import { describe, expect, it } from "vitest";
import {
  assertCompanyBalanceExcludesDriverWallet,
  assertCompanyTransferFundingAvailable,
  auditCompanyBalanceSourceCandidates,
  COMPANY_BALANCE_ERROR,
  formatCompanyBalancePence,
  resolveCompanyBalanceSnapshot,
} from "../../../shared/companyBalanceSSOT";
import {
  emptyPayoutLedgerOverviewDto,
  finalisePayoutLedgerOverviewStatus,
  PAYOUT_LEDGER_ERROR,
} from "../../../shared/payoutLedgerOverviewSSOT";

describe("company balance SSOT", () => {
  it("returns UNAVAILABLE — never £0 — when no canonical source exists", () => {
    const snap = resolveCompanyBalanceSnapshot({ currency: "GBP" });
    expect(snap.status).toBe("UNAVAILABLE");
    expect(snap.company_ledger_balance_pence).toBeNull();
    expect(snap.company_available_for_transfer_pence).toBeNull();
    expect(snap.unavailable_reason).toBe(COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED);
    expect(snap.excludes_driver_wallet).toBe(true);
  });

  it("rejects Revolut stub zero as provider evidence", () => {
    const snap = resolveCompanyBalanceSnapshot({
      provider_balance_is_stub: true,
      provider_cash_balance_pence: 0,
    });
    expect(snap.status).toBe("UNAVAILABLE");
    expect(snap.provider_cash_balance_pence).toBeNull();
    expect(formatCompanyBalancePence(0, snap.unavailable_reason).kind).toBe("unavailable");
  });

  it("never formats unavailable company balance as £0.00", () => {
    const formatted = formatCompanyBalancePence(null, COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE);
    expect(formatted).toEqual({
      kind: "unavailable",
      reason: COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE,
    });
  });

  it("blocks company transfer funding when balance unavailable", () => {
    const snap = resolveCompanyBalanceSnapshot();
    expect(() =>
      assertCompanyTransferFundingAvailable({
        money_source: "COMPANY_BALANCE",
        company_balance: snap,
        amount_pence: 100,
      }),
    ).toThrow(COMPANY_BALANCE_ERROR.FUNDING_UNAVAILABLE);
  });

  it("forbids driver wallet as company funding source", () => {
    const snap = resolveCompanyBalanceSnapshot({
      company_ledger_balance_pence: 10_000,
      provider_cash_balance_pence: 10_000,
    });
    expect(() =>
      assertCompanyTransferFundingAvailable({
        money_source: "DRIVER_WALLET",
        company_balance: snap,
        amount_pence: 100,
      }),
    ).toThrow(COMPANY_BALANCE_ERROR.FORBIDDEN_DRIVER_WALLET);
  });

  it("company available must not equal driver wallet totals", () => {
    expect(assertCompanyBalanceExcludesDriverWallet({
      company_available_for_transfer_pence: 1409,
      driver_wallet_total_pence: 1409,
      driver_available_pence: 1409,
    })).toBe(false);
    expect(assertCompanyBalanceExcludesDriverWallet({
      company_available_for_transfer_pence: null,
      driver_wallet_total_pence: 1409,
      driver_available_pence: 1409,
    })).toBe(true);
  });

  it("audit lists revolut stub and forbids DWL as company balance", () => {
    const audit = auditCompanyBalanceSourceCandidates();
    expect(audit.some((a) => a.candidate === "driver_wallet_ledger" && !a.usable_for_company_balance)).toBe(true);
    expect(audit.some((a) => a.candidate.includes("revolutAdapter.getBalance") && !a.usable_for_company_balance)).toBe(true);
    expect(audit.some((a) => a.candidate.includes("Business API") && a.usable_for_company_balance)).toBe(true);
    expect(audit.some((a) => a.candidate.includes("stripe") && !a.usable_for_company_balance)).toBe(true);
  });
});

describe("payout ledger overview partial failure", () => {
  it("preserves ACCOUNT_NOT_CONFIGURED instead of collapsing to SOURCE_UNAVAILABLE", () => {
    let dto = emptyPayoutLedgerOverviewDto({ status: "LIVE", unavailable_reason: null });
    dto.unavailable_reason = null;
    dto.section_errors = [];
    dto.driver_wallet_total_pence = 1409;
    dto.driver_available_pence = 1409;
    dto.company_balance_pence = null;
    dto.company_available_for_transfer_pence = null;
    dto.section_errors.push("ACCOUNT_NOT_CONFIGURED");

    dto = finalisePayoutLedgerOverviewStatus(dto);
    expect(dto.status).toBe("PARTIAL");
    expect(dto.unavailable_reason).toBe("ACCOUNT_NOT_CONFIGURED");
    expect(dto.driver_available_pence).toBe(1409);
  });

  it("keeps driver widgets when company balance is unavailable", () => {
    let dto = emptyPayoutLedgerOverviewDto({ status: "LIVE", unavailable_reason: null });
    dto.unavailable_reason = null;
    dto.section_errors = [];
    dto.driver_wallet_total_pence = 1409;
    dto.driver_available_pence = 1409;
    dto.driver_pending_pence = 0;
    dto.driver_debt_pence = 0;
    dto.eligible_driver_count = 2;
    dto.held_driver_count = 0;
    dto.company_balance_pence = null;
    dto.company_available_for_transfer_pence = null;
    dto.section_errors.push(PAYOUT_LEDGER_ERROR.COMPANY_BALANCE_SOURCE_UNAVAILABLE);

    dto = finalisePayoutLedgerOverviewStatus(dto);
    expect(dto.status).toBe("PARTIAL");
    expect(dto.driver_wallet_total_pence).toBe(1409);
    expect(dto.driver_available_pence).toBe(1409);
    expect(dto.company_balance_pence).toBeNull();
    expect(dto.unavailable_reason).toBe(PAYOUT_LEDGER_ERROR.COMPANY_BALANCE_SOURCE_UNAVAILABLE);
  });

  it("failed API surfaces specific error code", () => {
    const dto = emptyPayoutLedgerOverviewDto({
      status: "UNAVAILABLE",
      unavailable_reason: PAYOUT_LEDGER_ERROR.API_UNAVAILABLE,
    });
    expect(dto.unavailable_reason).toBe(PAYOUT_LEDGER_ERROR.API_UNAVAILABLE);
    expect(dto.driver_wallet_total_pence).toBeNull();
  });

  it("does not invent company balance from driver liabilities", () => {
    let dto = emptyPayoutLedgerOverviewDto({ status: "LIVE", unavailable_reason: null });
    dto.unavailable_reason = null;
    dto.section_errors = [];
    dto.driver_wallet_total_pence = 1409;
    dto.driver_available_pence = 1409;
    // Intentionally leave company null — must stay null after finalise.
    dto = finalisePayoutLedgerOverviewStatus(dto);
    expect(dto.company_available_for_transfer_pence).toBeNull();
    expect(dto.company_balance_pence).toBeNull();
    expect(dto.status).toBe("PARTIAL");
  });
});

describe("P0 company funding labels / residual formula", () => {
  it("£19.34 is provider cash; £5.25 is ONECAB available funds", () => {
    const snap = resolveCompanyBalanceSnapshot({
      currency: "GBP",
      provider_available_balance_pence: 1934,
      company_ledger_balance_pence: 1934,
      source_account_id: "4fb5a28b-3797-e242-0040-62910ba9f9d4",
      driver_liability_pence: 1409,
      driver_payout_reserved_pence: 0,
      approved_company_payables_pence: 0,
      operational_reserve_pence: null,
      status_code: "AVAILABLE",
    });
    expect(snap.provider_available_balance_pence).toBe(1934);
    expect(snap.company_available_for_transfer_pence).toBe(525);
    expect(snap.company_available_for_transfer_pence).not.toBe(1934);
    expect(snap.driver_liability_pence).toBe(1409);
    expect(snap.driver_payout_funding_status).toBe("FULLY_FUNDED");
    expect(snap.funding_gap_pence).toBe(0);
  });

  it("provider failure → PROVIDER_BALANCE_UNAVAILABLE; liability not forced to £0", () => {
    const snap = resolveCompanyBalanceSnapshot({
      status_code: COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE,
      driver_liability_pence: 1409,
    });
    expect(snap.unavailable_reason).toBe(COMPANY_BALANCE_ERROR.PROVIDER_BALANCE_UNAVAILABLE);
    expect(snap.driver_liability_pence).toBe(1409);
  });

  it("source change moves provider cash only", () => {
    const a = resolveCompanyBalanceSnapshot({
      provider_available_balance_pence: 1934,
      source_account_id: "4fb5a28b-3797-e242-0040-62910ba9f9d4",
      driver_liability_pence: 1409,
      driver_payout_reserved_pence: 0,
      status_code: "AVAILABLE",
    });
    const b = resolveCompanyBalanceSnapshot({
      provider_available_balance_pence: 0,
      source_account_id: "101c224e-402f-e24d-0040-62fb44bc2714",
      driver_liability_pence: 1409,
      driver_payout_reserved_pence: 0,
      status_code: "AVAILABLE",
    });
    expect(a.provider_available_balance_pence).not.toBe(b.provider_available_balance_pence);
    expect(a.driver_liability_pence).toBe(b.driver_liability_pence);
  });
});
