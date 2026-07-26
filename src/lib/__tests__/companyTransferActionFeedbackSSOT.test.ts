import { describe, expect, it } from "vitest";
import {
  RETURN_TO_DRAFT_CONFIRM_MESSAGE,
  buildCompanyTransferActionFeedback,
  canShowSubmitForApprovalAction,
  companyTransferActionSuccessMessage,
  companyTransferStatusMismatchMessage,
  companyTransferTimelineIndex,
  expectedStatusesForCompanyTransferAction,
  requiresReturnToDraftConfirmation,
} from "../../../shared/companyTransferActionFeedbackSSOT";

describe("companyTransferActionFeedbackSSOT", () => {
  it("uses action-specific success messages", () => {
    expect(companyTransferActionSuccessMessage("approve")).toBe(
      "Transfer approved and ready for execution.",
    );
    expect(companyTransferActionSuccessMessage("approve", { sole_admin_override: true })).toBe(
      "Transfer approved using sole-admin override and is ready for execution.",
    );
    expect(companyTransferActionSuccessMessage("submit_for_approval")).toBe(
      "Transfer submitted for approval.",
    );
    expect(companyTransferActionSuccessMessage("return_to_draft")).toBe(
      "Transfer returned to draft.",
    );
    expect(companyTransferActionSuccessMessage("reject")).toBe("Transfer rejected.");
    expect(companyTransferActionSuccessMessage("cancel")).toBe("Transfer cancelled.");
    expect(companyTransferActionSuccessMessage("mark_ready_for_execution")).toBe(
      "Transfer is ready for execution.",
    );
  });

  it("flags status mismatch when backend status ≠ expected", () => {
    const fb = buildCompanyTransferActionFeedback({
      action: "approve",
      previous_status: "AWAITING_APPROVAL",
      new_status: "DRAFT",
      transfer_ref: "COT-AF7A5028",
      acting_admin: "admin@onecab.net",
      sole_admin_override: true,
    });
    expect(fb.status_aligned).toBe(false);
    expect(fb.variant).toBe("warning");
    expect(fb.title).toBe(companyTransferStatusMismatchMessage("DRAFT"));
    expect(fb.description).toContain("COT-AF7A5028");
    expect(fb.description).toContain("AWAITING_APPROVAL → DRAFT");
  });

  it("sole-admin approve expects READY_FOR_EXECUTION", () => {
    expect(expectedStatusesForCompanyTransferAction("approve", { sole_admin_override: true }))
      .toEqual(["READY_FOR_EXECUTION"]);
    const fb = buildCompanyTransferActionFeedback({
      action: "approve",
      previous_status: "AWAITING_APPROVAL",
      new_status: "READY_FOR_EXECUTION",
      transfer_ref: "COT-AF7A5028",
      sole_admin_override: true,
      acting_admin: "admin@onecab.net",
    });
    expect(fb.status_aligned).toBe(true);
    expect(fb.title).toContain("sole-admin override");
  });

  it("blocks silent submit from READY and requires return-to-draft confirm", () => {
    expect(canShowSubmitForApprovalAction("READY_FOR_EXECUTION")).toBe(false);
    expect(canShowSubmitForApprovalAction("DRAFT")).toBe(true);
    expect(requiresReturnToDraftConfirmation("READY_FOR_EXECUTION")).toBe(true);
    expect(RETURN_TO_DRAFT_CONFIRM_MESSAGE).toContain("remove approval");
  });

  it("timeline highlights canonical approval path", () => {
    expect(companyTransferTimelineIndex("DRAFT")).toBe(0);
    expect(companyTransferTimelineIndex("AWAITING_APPROVAL")).toBe(1);
    expect(companyTransferTimelineIndex("APPROVED")).toBe(2);
    expect(companyTransferTimelineIndex("READY_FOR_EXECUTION")).toBe(3);
    expect(companyTransferTimelineIndex("CANCELLED")).toBe(-1);
  });
});
