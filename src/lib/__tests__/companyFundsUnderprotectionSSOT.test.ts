import { describe, expect, it } from "vitest";
import {
  COMPANY_FUNDS_UNDERPROTECTION_ACCEPTANCE_PROOF,
  COMPANY_FUNDS_UNDERPROTECTED,
  evaluateCompanyFundsUnderprotection,
} from "../../../shared/companyFundsUnderprotectionSSOT.ts";
import {
  evaluateCompanyTransferFundingGate,
  buildCompanyTransferFundingSnapshot,
  COMPANY_TRANSFER_GATE_REASON,
} from "../../../shared/companyTransferLifecycleSSOT.ts";
import { resolveCompanyBalanceSnapshot } from "../../../shared/companyBalanceSSOT.ts";

describe("companyFundsUnderprotectionSSOT", () => {
  it("MK acceptance: Revolut £21.76, protected £23.20, payables £1.11 → underprotected", () => {
    const {
      REVOLUT_SOURCE_PENCE,
      PROTECTED_DRIVER_LIABILITIES_PENCE,
      APPROVED_PAYABLES_PENCE,
    } = COMPANY_FUNDS_UNDERPROTECTION_ACCEPTANCE_PROOF;

    const evalResult = evaluateCompanyFundsUnderprotection({
      provider_available_balance_pence: REVOLUT_SOURCE_PENCE,
      protected_driver_liabilities_pence: PROTECTED_DRIVER_LIABILITIES_PENCE,
      approved_company_payables_pence: APPROVED_PAYABLES_PENCE,
    });

    expect(evalResult.underprotected).toBe(true);
    expect(evalResult.reason_code).toBe(COMPANY_FUNDS_UNDERPROTECTED.REASON_CODE);
    expect(evalResult.message).toBe(COMPANY_FUNDS_UNDERPROTECTED.MESSAGE);
    expect(evalResult.protected_plus_payables_pence).toBe(2431);
    expect(evalResult.shortfall_pence).toBe(255);

    const snap = resolveCompanyBalanceSnapshot({
      provider_available_balance_pence: REVOLUT_SOURCE_PENCE,
      driver_liability_pence: PROTECTED_DRIVER_LIABILITIES_PENCE,
      approved_company_payables_pence: APPROVED_PAYABLES_PENCE,
      operational_reserve_pence: 1,
      classified_company_cash_pence: 5173,
      source_account_id: "revolut-source",
      status_code: "AVAILABLE",
    });

    expect(snap.company_available_before_operational_reserve_pence).toBe(0);
    expect(snap.company_available_for_transfer_pence).toBe(0);
    expect(snap.company_funds_underprotected).toBe(true);
  });

  it("blocks company transfers when underprotected but does not require driver payout gate", () => {
    const snap = buildCompanyTransferFundingSnapshot({
      capture_phase: "APPROVAL",
      source_balance_pence: 2176,
      protected_liabilities_pence: 2320,
      approved_payables_pence: 111,
      classified_company_cash_pence: 5173,
      eligible_company_cash_pence: 0,
      transferable_base_pence: 0,
      operational_reserve_pence: 1,
      operational_reserve_status: "ACTIVE",
      final_company_available_pence: 0,
    });

    expect(snap.company_funds_underprotected).toBe(true);
    const gate = evaluateCompanyTransferFundingGate({
      amount_pence: 100,
      funding_snapshot: snap,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason_codes).toContain(
      COMPANY_TRANSFER_GATE_REASON.DRIVER_LIABILITIES_EXCEED_REVOLUT_SOURCE,
    );
  });

  it("fail-closed when provider or liabilities unknown", () => {
    expect(evaluateCompanyFundsUnderprotection({
      provider_available_balance_pence: null,
      protected_driver_liabilities_pence: 2320,
    }).underprotected).toBe(false);
    expect(evaluateCompanyFundsUnderprotection({
      provider_available_balance_pence: 2176,
      protected_driver_liabilities_pence: null,
    }).underprotected).toBe(false);
  });
});
