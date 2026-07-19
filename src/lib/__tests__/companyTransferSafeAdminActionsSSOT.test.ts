import { describe, expect, it } from "vitest";
import {
  canCancelCompanyTransferSafely,
  canReturnCompanyTransferToDraft,
  canSafelyAdminMutateCompanyTransfer,
  shouldShowEditDraftAction,
} from "../../../shared/companyTransferDraftValidationSSOT";
import { canTransitionCompanyTransferStatus } from "../../../shared/companyTransferLifecycleSSOT";

describe("company transfer safe admin actions (LIVE off)", () => {
  it("allows edit / return / cancel on READY without provider payment", () => {
    const args = {
      status: "READY_FOR_EXECUTION",
      has_provider_payment_id: false,
      money_moved: false,
    };
    expect(canSafelyAdminMutateCompanyTransfer(args)).toBe(true);
    expect(canReturnCompanyTransferToDraft(args)).toBe(true);
    expect(canCancelCompanyTransferSafely(args)).toBe(true);
    expect(shouldShowEditDraftAction(args)).toBe(true);
  });

  it("blocks safe mutate after provider payment id exists", () => {
    const args = {
      status: "READY_FOR_EXECUTION",
      has_provider_payment_id: true,
      money_moved: false,
    };
    expect(canSafelyAdminMutateCompanyTransfer(args)).toBe(false);
    expect(canReturnCompanyTransferToDraft(args)).toBe(false);
    expect(canCancelCompanyTransferSafely(args)).toBe(false);
    expect(shouldShowEditDraftAction(args)).toBe(false);
  });

  it("allows READY → DRAFT and READY → CANCELLED transitions", () => {
    expect(canTransitionCompanyTransferStatus({
      from: "READY_FOR_EXECUTION",
      to: "DRAFT",
    })).toBe(true);
    expect(canTransitionCompanyTransferStatus({
      from: "READY_FOR_EXECUTION",
      to: "CANCELLED",
    })).toBe(true);
    expect(canTransitionCompanyTransferStatus({
      from: "APPROVED",
      to: "DRAFT",
    })).toBe(true);
  });
});
