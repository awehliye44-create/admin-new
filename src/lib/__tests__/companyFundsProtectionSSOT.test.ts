import { describe, expect, it } from "vitest";
import {
  COMPANY_TRANSFER_GATE_REASON,
  buildCompanyTransferFundingSnapshot,
  buildInsufficientCompanyFundsMessage,
  evaluateCompanyTransferFundingGate,
  gateHasInsufficientCompanyFunds,
} from "../../../shared/companyTransferLifecycleSSOT";

describe("Company Funds Protection SSOT", () => {
  it("blocks when requested > ONECAB Available Company Funds with shortfall message", () => {
    const snap = buildCompanyTransferFundingSnapshot({
      capture_phase: "APPROVAL",
      classified_company_cash_pence: 1000,
      eligible_company_cash_pence: 1000,
      operational_reserve_pence: 100,
      operational_reserve_status: "ACTIVE",
      final_company_available_pence: 200,
    });
    const gate = evaluateCompanyTransferFundingGate({
      amount_pence: 500,
      funding_snapshot: snap,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason_codes).toContain(COMPANY_TRANSFER_GATE_REASON.INSUFFICIENT_COMPANY_FUNDS);
    expect(gateHasInsufficientCompanyFunds(gate.reason_codes)).toBe(true);
    expect(gate.funds_protection?.shortfall_pence).toBe(300);
    expect(gate.funds_protection?.message).toContain("protect driver funds");
  });

  it("allows when requested <= available and never emits funds_protection", () => {
    const snap = buildCompanyTransferFundingSnapshot({
      capture_phase: "SUBMIT",
      classified_company_cash_pence: 1000,
      eligible_company_cash_pence: 1000,
      operational_reserve_pence: 100,
      operational_reserve_status: "ACTIVE",
      final_company_available_pence: 500,
    });
    const gate = evaluateCompanyTransferFundingGate({
      amount_pence: 500,
      funding_snapshot: snap,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.funds_protection ?? null).toBeNull();
  });

  it("formats the operator message with Available / Requested / Shortfall", () => {
    const msg = buildInsufficientCompanyFundsMessage({
      available_company_funds_pence: 1526,
      requested_pence: 2500,
    });
    expect(msg).toMatch(/Available Company Funds: £15\.26/);
    expect(msg).toMatch(/Requested Transfer: £25\.00/);
    expect(msg).toMatch(/Shortfall: £9\.74/);
  });
});
