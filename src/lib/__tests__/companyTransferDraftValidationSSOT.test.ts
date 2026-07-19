import { describe, expect, it } from "vitest";
import {
  buildLiveFundsShortfallDisplay,
  buildPreDraftInsufficientFundsMessage,
  evaluatePreDraftCompanyFundsGate,
  isAmountValidationOnlyBlock,
  isOperationalCompanyTransferBlock,
  shouldShowEditDraftAction,
  shouldShowRetryValidation,
} from "../../../shared/companyTransferDraftValidationSSOT";

describe("companyTransferDraftValidationSSOT", () => {
  it("blocks pre-draft when requested exceeds available funds", () => {
    const gate = evaluatePreDraftCompanyFundsGate({
      requested_pence: 5000,
      available_company_funds_pence: 774,
    });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("INSUFFICIENT_COMPANY_FUNDS");
    expect(gate.shortfall_pence).toBe(4226);
    expect(gate.message).toContain("£50.00");
    expect(gate.message).toContain("£7.74");
    expect(gate.message).toContain("£42.26");
    expect(gate.message).toMatch(/cannot be drafted/i);
  });

  it("allows pre-draft when requested ≤ available", () => {
    const gate = evaluatePreDraftCompanyFundsGate({
      requested_pence: 1,
      available_company_funds_pence: 774,
    });
    expect(gate.ok).toBe(true);
    expect(gate.shortfall_pence).toBe(0);
  });

  it("marks amount-only insufficient as non-operational block", () => {
    expect(isAmountValidationOnlyBlock(["INSUFFICIENT_COMPANY_FUNDS"])).toBe(true);
    expect(isOperationalCompanyTransferBlock(["INSUFFICIENT_COMPANY_FUNDS"])).toBe(false);
    expect(shouldShowEditDraftAction({
      status: "BLOCKED",
      blocked_reason_codes: ["INSUFFICIENT_COMPANY_FUNDS"],
    })).toBe(true);
    expect(shouldShowRetryValidation({
      status: "BLOCKED",
      blocked_reason_codes: ["INSUFFICIENT_COMPANY_FUNDS"],
    })).toBe(false);
  });

  it("keeps operational blocks on Retry Validation", () => {
    expect(isOperationalCompanyTransferBlock([
      "OPERATIONAL_RESERVE_NOT_CONFIGURED",
    ])).toBe(true);
    expect(shouldShowRetryValidation({
      status: "BLOCKED",
      blocked_reason_codes: ["OPERATIONAL_RESERVE_NOT_CONFIGURED"],
    })).toBe(true);
    expect(shouldShowEditDraftAction({
      status: "BLOCKED",
      blocked_reason_codes: ["OPERATIONAL_RESERVE_NOT_CONFIGURED"],
    })).toBe(false);
  });

  it("builds live shortfall green/red display", () => {
    const bad = buildLiveFundsShortfallDisplay({
      available_company_funds_pence: 774,
      requested_pence: 5000,
    });
    expect(bad.valid).toBe(false);
    expect(bad.shortfall_pence).toBe(4226);

    const good = buildLiveFundsShortfallDisplay({
      available_company_funds_pence: 774,
      requested_pence: 100,
    });
    expect(good.valid).toBe(true);
    expect(good.shortfall_pence).toBe(0);
  });

  it("formats pre-draft message without claiming a blocked ledger row", () => {
    const msg = buildPreDraftInsufficientFundsMessage({
      available_company_funds_pence: 774,
      requested_pence: 5000,
    });
    expect(msg).not.toMatch(/blocked to protect/i);
    expect(msg).toMatch(/cannot be drafted/i);
  });
});
