import { describe, expect, it } from "vitest";
import {
  assertCompanyTransferMoneySource,
  resolveDefaultMoneySourceForCategory,
} from "../../../shared/companyOutgoingTransferSSOT";
import {
  canApproveCompanyTransfer,
  resolveCompanyTransferApprovalsRequired,
} from "../../../shared/companyOutgoingTransferApprovalSSOT";

describe("company outgoing transfer SSOT", () => {
  it("rejects driver wallet and payment session money sources", () => {
    expect(() => assertCompanyTransferMoneySource("DRIVER_WALLET")).toThrow(/FORBIDDEN/);
    expect(() => assertCompanyTransferMoneySource("PAYMENT_SESSIONS")).toThrow(/FORBIDDEN/);
    expect(assertCompanyTransferMoneySource("COMPANY_BALANCE")).toBe("COMPANY_BALANCE");
  });

  it("staff reimbursement defaults to company balance", () => {
    expect(resolveDefaultMoneySourceForCategory("STAFF_REIMBURSEMENT")).toBe("COMPANY_BALANCE");
  });

  it("applies approval thresholds", () => {
    expect(resolveCompanyTransferApprovalsRequired(10_000).tier).toBe("SINGLE");
    expect(resolveCompanyTransferApprovalsRequired(100_000).tier).toBe("DUAL");
    expect(resolveCompanyTransferApprovalsRequired(300_000).requires_owner).toBe(true);
  });

  it("blocks self-approval", () => {
    expect(canApproveCompanyTransfer({
      requester_id: "user-a",
      approver_id: "user-a",
    }).ok).toBe(false);
    expect(canApproveCompanyTransfer({
      requester_id: "user-a",
      approver_id: "user-b",
    }).ok).toBe(true);
  });
});
