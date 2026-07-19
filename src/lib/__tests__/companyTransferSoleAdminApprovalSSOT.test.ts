import { describe, expect, it } from "vitest";
import {
  evaluateSoleAdminCompanyTransferSelfApproval,
  parseSoleAdminCtAllowedTransferTypes,
  parseSoleAdminCtLimitPence,
  parseSoleAdminCtSettingEnabled,
  SOLE_ADMIN_CT_REASON,
} from "../../../shared/companyTransferSoleAdminApprovalSSOT";

const baseOk = {
  policy_enabled: true,
  actor_role: "super_admin",
  requester_user_id: "u1",
  approver_user_id: "u1",
  other_eligible_approver_count: 0,
  amount_pence: 1,
  limit_pence: 1,
  transfer_type: "CERTIFICATION",
  allowed_transfer_types: ["CERTIFICATION"],
  payee_provider_verified: true,
  money_source: "COMPANY_BALANCE",
  funding_gate_allowed: true,
  has_provider_payment: false,
  has_company_ledger_debit: false,
  confirm_sole_admin_approval: true,
  override_reason: "Sole-admin certification approval — no second approver",
  payee_id: "payee-1",
  transfer_reference: "COT-TEST",
};

describe("companyTransferSoleAdminApprovalSSOT", () => {
  it("parses settings fail-closed", () => {
    expect(parseSoleAdminCtSettingEnabled(false)).toBe(false);
    expect(parseSoleAdminCtSettingEnabled("true")).toBe(true);
    expect(parseSoleAdminCtLimitPence("1")).toBe(1);
    expect(parseSoleAdminCtLimitPence("")).toBeNull();
    expect(parseSoleAdminCtAllowedTransferTypes(null)).toEqual(["CERTIFICATION"]);
    expect(parseSoleAdminCtAllowedTransferTypes("CERTIFICATION,VENDOR")).toEqual([
      "CERTIFICATION",
      "VENDOR",
    ]);
  });

  it("allows certification 1p sole-admin when all gates pass", () => {
    const result = evaluateSoleAdminCompanyTransferSelfApproval(baseOk);
    expect(result.ok).toBe(true);
    expect(result.audit?.sole_admin_override).toBe(true);
    expect(result.audit?.amount_pence).toBe(1);
    expect(result.audit?.approval_policy_version).toBe("SOLE_ADMIN_CT_APPROVAL_V1");
  });

  it("blocks when another eligible approver exists", () => {
    const result = evaluateSoleAdminCompanyTransferSelfApproval({
      ...baseOk,
      other_eligible_approver_count: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.reason_codes).toContain(SOLE_ADMIN_CT_REASON.OTHER_APPROVER_EXISTS);
  });

  it("blocks non-super_admin and amount over limit", () => {
    expect(
      evaluateSoleAdminCompanyTransferSelfApproval({
        ...baseOk,
        actor_role: "admin",
      }).reason_codes,
    ).toContain(SOLE_ADMIN_CT_REASON.ROLE_NOT_SUPER_ADMIN);

    expect(
      evaluateSoleAdminCompanyTransferSelfApproval({
        ...baseOk,
        amount_pence: 111,
      }).reason_codes,
    ).toContain(SOLE_ADMIN_CT_REASON.AMOUNT_OVER_LIMIT);
  });

  it("blocks company_outgoing type and missing confirmation/reason", () => {
    expect(
      evaluateSoleAdminCompanyTransferSelfApproval({
        ...baseOk,
        transfer_type: "COMPANY_OUTGOING",
      }).reason_codes,
    ).toContain(SOLE_ADMIN_CT_REASON.TRANSFER_TYPE_BLOCKED);

    expect(
      evaluateSoleAdminCompanyTransferSelfApproval({
        ...baseOk,
        confirm_sole_admin_approval: false,
        override_reason: "short",
      }).reason_codes,
    ).toEqual(
      expect.arrayContaining([
        SOLE_ADMIN_CT_REASON.CONFIRMATION_REQUIRED,
        SOLE_ADMIN_CT_REASON.OVERRIDE_REASON_REQUIRED,
      ]),
    );
  });

  it("blocks provider payment / ledger debit / non-company funds", () => {
    expect(
      evaluateSoleAdminCompanyTransferSelfApproval({
        ...baseOk,
        has_provider_payment: true,
      }).reason_codes,
    ).toContain(SOLE_ADMIN_CT_REASON.PROVIDER_PAYMENT_EXISTS);

    expect(
      evaluateSoleAdminCompanyTransferSelfApproval({
        ...baseOk,
        money_source: "DRIVER_WALLET",
      }).reason_codes,
    ).toContain(SOLE_ADMIN_CT_REASON.MONEY_SOURCE_INVALID);
  });
});
