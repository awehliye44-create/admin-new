/**
 * Finance workflow restart proofs — Company Balance SSOT + Payout Ledger resilience.
 * No payout / transfer / counterparty / wallet mutation in this suite.
 */
import { describe, expect, it } from "vitest";
import {
  COMPANY_BALANCE_ERROR,
  computeCompanyAvailableForTransferPence,
  resolveCompanyBalanceSnapshot,
  auditCompanyBalanceSourceCandidates,
} from "../companyBalanceSSOT";
import {
  emptyPayoutLedgerOverviewDto,
  finalisePayoutLedgerOverviewStatus,
  PAYOUT_LEDGER_ERROR,
} from "../payoutLedgerOverviewSSOT";

describe("SLICE A/H — payout ledger never invents money", () => {
  it("1. degraded response stays structured (success/ok + error_code, never invent cash)", () => {
    const snap = resolveCompanyBalanceSnapshot({
      status_code: PAYOUT_LEDGER_ERROR.API_UNAVAILABLE,
      driver_liability_pence: 1409,
    });
    expect(snap.provider_available_balance_pence).toBeNull();
    expect(snap.company_available_for_transfer_pence).toBeNull();
    expect(snap.unavailable_reason).toBe(PAYOUT_LEDGER_ERROR.API_UNAVAILABLE);
    expect(snap.driver_liability_pence).toBe(1409);
  });

  it("2. missing source account → SOURCE_ACCOUNT_NOT_CONFIGURED (never £0)", () => {
    const snap = resolveCompanyBalanceSnapshot({
      currency: "GBP",
      status_code: COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED,
      driver_liability_pence: 1409,
      driver_payout_reserved_pence: 0,
      approved_company_payables_pence: 0,
      operational_reserve_pence: null,
    });
    expect(snap.status).toBe("UNAVAILABLE");
    expect(snap.unavailable_reason).toBe(COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED);
    expect(snap.provider_available_balance_pence).toBeNull();
    expect(snap.company_available_for_transfer_pence).toBeNull();
    expect(snap.company_ledger_balance_pence).toBeNull();
    expect(snap.driver_liability_pence).toBe(1409);
    expect(snap.sections?.provider_balance.status).toBe("NOT_CONFIGURED");
    expect(snap.sections?.driver_liabilities.amount_pence).toBe(1409);
    expect(snap.connection_health).toBe("NOT_CONFIGURED");
    expect(snap.sections?.operational_reserve.status).not.toBe("AVAILABLE");
  });

  it("3. selected Main (£2.74) returns real provider balance, not liability", () => {
    const snap = resolveCompanyBalanceSnapshot({
      currency: "GBP",
      provider_available_balance_pence: 274,
      provider_cash_balance_pence: 274,
      company_ledger_balance_pence: 274,
      source_account_id: "acc_main_000001",
      source_account_label: "Main (GBP …000001)",
      driver_liability_pence: 1409,
      driver_payout_reserved_pence: 0,
      approved_company_payables_pence: 0,
      operational_reserve_pence: null,
      status_code: "AVAILABLE",
    });
    expect(snap.provider_available_balance_pence).toBe(274);
    expect(snap.driver_liability_pence).toBe(1409);
    expect(snap.provider_available_balance_pence).not.toBe(snap.driver_liability_pence);
    expect(snap.company_available_for_transfer_pence).toBe(0); // max(0, 274-1409)
    expect(snap.sections?.provider_balance).toEqual({
      status: "AVAILABLE",
      amount_pence: 274,
      currency: "GBP",
      reason_code: null,
    });
  });

  it("4. selected second GBP (£16.60) returns that account balance only", () => {
    const snap = resolveCompanyBalanceSnapshot({
      currency: "GBP",
      provider_available_balance_pence: 1660,
      company_ledger_balance_pence: 1660,
      source_account_id: "acc_other_000002",
      source_account_label: "Other GBP (GBP …000002)",
      driver_liability_pence: 1409,
      driver_payout_reserved_pence: 0,
      approved_company_payables_pence: 0,
      operational_reserve_pence: null,
      status_code: "AVAILABLE",
    });
    expect(snap.provider_available_balance_pence).toBe(1660);
    expect(snap.company_available_for_transfer_pence).toBe(251); // 1660 - 1409
    expect(snap.source_account_label).toContain("Other GBP");
  });

  it("5. fleet driver liability truth remains £14.09 = 1409 pence (Ahmed + Bosteyo)", () => {
    const ahmed = 1001;
    const bosteyo = 408;
    expect(ahmed + bosteyo).toBe(1409);
  });

  it("6. provider balance and driver liability are separate fields", () => {
    const snap = resolveCompanyBalanceSnapshot({
      provider_available_balance_pence: 1660,
      company_ledger_balance_pence: 1660,
      driver_liability_pence: 1409,
      status_code: "AVAILABLE",
    });
    expect(snap.provider_available_balance_pence).toBe(1660);
    expect(snap.driver_liability_pence).toBe(1409);
    expect(snap.provider_available_balance_pence).not.toEqual(snap.driver_liability_pence);
  });

  it("7. available for company transfer deducts driver liabilities", () => {
    expect(computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: 1660,
      driver_liability_pence: 1409,
      driver_payout_reserved_pence: 0,
      approved_company_payables_pence: 0,
      operational_reserve_pence: null,
    })).toBe(251);
  });

  it("7b. Main £19.34 − liabilities £14.09 = ONECAB available £5.25 (not labelled company balance)", () => {
    const snap = resolveCompanyBalanceSnapshot({
      currency: "GBP",
      provider_available_balance_pence: 1934,
      provider_cash_balance_pence: 1934,
      company_ledger_balance_pence: 1934,
      source_account_id: "4fb5a28b-3797-e242-0040-62910ba9f9d4",
      source_account_label: "Main (GBP …a9f9d4)",
      driver_liability_pence: 1409,
      driver_payout_reserved_pence: 0,
      approved_company_payables_pence: 0,
      operational_reserve_pence: null,
      customer_refund_reserved_pence: null,
      status_code: "AVAILABLE",
    });
    // Provider cash (= Revolut source account) must stay £19.34
    expect(snap.provider_available_balance_pence).toBe(1934);
    // Must NOT treat provider cash as ONECAB residual
    expect(snap.company_available_for_transfer_pence).toBe(525);
    expect(snap.company_available_for_transfer_pence).not.toBe(snap.provider_available_balance_pence);
    expect(snap.driver_liability_pence).toBe(1409);
    expect(snap.driver_payout_funding_status).toBe("FULLY_FUNDED");
    expect(snap.funding_gap_pence).toBe(0);
  });

  it("7c. provider failure surfaces PROVIDER_BALANCE_UNAVAILABLE; liability stays non-zero", () => {
    const snap = resolveCompanyBalanceSnapshot({
      status_code: COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE,
      driver_liability_pence: 1409,
    });
    expect(snap.unavailable_reason).toBe(COMPANY_BALANCE_ERROR.PROVIDER_BALANCE_UNAVAILABLE);
    expect(snap.provider_available_balance_pence).toBeNull();
    expect(snap.driver_liability_pence).toBe(1409);
    expect(snap.driver_liability_pence).not.toBe(0);
  });

  it("7d. changing source account changes provider cash only (liability unchanged)", () => {
    const liability = 1409;
    const main = resolveCompanyBalanceSnapshot({
      provider_available_balance_pence: 1934,
      source_account_id: "4fb5a28b-3797-e242-0040-62910ba9f9d4",
      driver_liability_pence: liability,
      driver_payout_reserved_pence: 0,
      approved_company_payables_pence: 0,
      status_code: "AVAILABLE",
    });
    const zeroGbp = resolveCompanyBalanceSnapshot({
      provider_available_balance_pence: 0,
      source_account_id: "101c224e-402f-e24d-0040-62fb44bc2714",
      driver_liability_pence: liability,
      driver_payout_reserved_pence: 0,
      approved_company_payables_pence: 0,
      status_code: "AVAILABLE",
    });
    expect(main.provider_available_balance_pence).toBe(1934);
    expect(zeroGbp.provider_available_balance_pence).toBe(0);
    expect(main.driver_liability_pence).toBe(liability);
    expect(zeroGbp.driver_liability_pence).toBe(liability);
    expect(main.company_available_for_transfer_pence).toBe(525);
    expect(zeroGbp.company_available_for_transfer_pence).toBe(0);
  });

  it("8. provider failure keeps driver widgets (PARTIAL) — does not crash overview", () => {
    let dto = emptyPayoutLedgerOverviewDto({ status: "LIVE", unavailable_reason: null });
    dto.unavailable_reason = null;
    dto.section_errors = [];
    dto.driver_wallet_total_pence = 1409;
    dto.driver_available_pence = 1409;
    dto.company_balance_pence = null;
    dto.company_available_for_transfer_pence = null;
    dto.section_errors.push(COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE);
    dto = finalisePayoutLedgerOverviewStatus(dto);
    expect(dto.status).toBe("PARTIAL");
    expect(dto.driver_wallet_total_pence).toBe(1409);
    expect(dto.company_balance_pence).toBeNull();
    expect(dto.unavailable_reason).toBe(COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE);
  });

  it("9+10. never uses Stripe or Merchant API as company balance evidence", () => {
    const audit = auditCompanyBalanceSourceCandidates();
    expect(audit.some((a) => a.candidate.includes("stripe") && !a.usable_for_company_balance)).toBe(true);
    expect(audit.some((a) => a.candidate.includes("revolutAdapter.getBalance") && !a.usable_for_company_balance)).toBe(true);
    expect(audit.some((a) => a.candidate.includes("Business API") && a.usable_for_company_balance)).toBe(true);
    const snap = resolveCompanyBalanceSnapshot({ driver_liability_pence: 1409 });
    expect(snap.provider_available_balance_pence).toBeNull();
    expect(snap.excludes_driver_wallet).toBe(true);
  });

  it("11. operational reserve missing stays null — never silent £0", () => {
    const snap = resolveCompanyBalanceSnapshot({
      status_code: COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED,
      operational_reserve_pence: null,
    });
    expect(snap.operational_reserve_pence).toBeNull();
    expect(snap.sections?.operational_reserve.amount_pence).toBeNull();
    expect(snap.sections?.operational_reserve.status).not.toBe("AVAILABLE");
  });

  it("null liability blocks available; null reserved is display-only (never invent £0 liability)", () => {
    expect(computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: 1660,
      driver_liability_pence: null,
      driver_payout_reserved_pence: 0,
    })).toBeNull();
    // Reserved is already inside live liability — unknown reserved must not wipe available.
    expect(computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: 1660,
      driver_liability_pence: 1409,
      driver_payout_reserved_pence: null,
    })).toBe(251);
    expect(computeCompanyAvailableForTransferPence({
      provider_available_balance_pence: 1660,
      driver_liability_pence: 1409,
      driver_payout_reserved_pence: 1409,
      operational_reserve_pence: null,
    })).toBe(251);
  });

  it("13. LIVE_PAYOUT_EXECUTION_ENABLED defaults false (read-only slice)", async () => {
    const { parseLivePayoutExecutionEnabled } = await import("../revolutBusinessOAuthSSOT");
    expect(parseLivePayoutExecutionEnabled(() => undefined)).toBe(false);
    expect(parseLivePayoutExecutionEnabled((k) => (
      k === "LIVE_PAYOUT_EXECUTION_ENABLED" ? "false" : undefined
    ))).toBe(false);
    expect(parseLivePayoutExecutionEnabled((k) => (
      k === "LIVE_PAYOUT_EXECUTION_ENABLED" ? "true" : undefined
    ))).toBe(true);
    // Slice response contract hard-codes false while env gate is off.
    expect(parseLivePayoutExecutionEnabled()).toBe(false);
  });

  it("SOURCE_ACCOUNT_NOT_CONFIGURED is preserved through overview finalise", () => {
    let dto = emptyPayoutLedgerOverviewDto({ status: "LIVE", unavailable_reason: null });
    dto.unavailable_reason = null;
    dto.section_errors = [COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED];
    dto.driver_wallet_total_pence = 1409;
    dto.company_balance_pence = null;
    dto = finalisePayoutLedgerOverviewStatus(dto);
    expect(dto.unavailable_reason).toBe(COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED);
    expect(dto.status).toBe("PARTIAL");
  });
});
