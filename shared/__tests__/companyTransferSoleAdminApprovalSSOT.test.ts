import { describe, expect, it } from "vitest";
import {
  canUiSoleApproveCompanyTransfer,
  evaluateSoleAdminCompanyTransferSelfApproval,
  parseSoleAdminCtAllowedTransferTypes,
  parseSoleAdminCtLimitPence,
  parseSoleAdminCtSettingEnabled,
  resolveOwnerSoleApprovalLimitPence,
  shouldUseCompanyTransferSoleAdminSelfApprovalPath,
  SOLE_ADMIN_CT_REASON,
  SOLE_OWNER_CT_APPROVAL_POLICY_VERSION,
  SOLE_OWNER_CT_DEFAULT_LIMIT_PENCE,
} from "../companyTransferSoleAdminApprovalSSOT";

const baseOk = {
  policy_enabled: true,
  actor_role: "super_admin",
  actor_is_owner: false,
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

const ownerOutgoing = {
  ...baseOk,
  actor_is_owner: true,
  amount_pence: 111,
  limit_pence: 1,
  owner_sole_approval_limit_pence: SOLE_OWNER_CT_DEFAULT_LIMIT_PENCE,
  transfer_type: "COMPANY_OUTGOING",
  allowed_transfer_types: ["CERTIFICATION"],
  other_eligible_approver_count: 2,
  override_reason: "Owner sole approval for company outgoing transfer audit",
  transfer_reference: "COT-75A57C98",
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

  it("A: Owner + COMPANY_OUTGOING → sole approval allowed", () => {
    const result = evaluateSoleAdminCompanyTransferSelfApproval(ownerOutgoing);
    expect(result.ok).toBe(true);
    expect(result.audit?.owner_override).toBe(true);
    expect(result.audit?.transfer_type).toBe("COMPANY_OUTGOING");
    expect(result.audit?.amount_pence).toBe(111);
  });

  it("B: Owner self-approves own COMPANY_OUTGOING → Owner audit event fields", () => {
    const result = evaluateSoleAdminCompanyTransferSelfApproval(ownerOutgoing);
    expect(result.ok).toBe(true);
    expect(result.audit?.owner_override).toBe(true);
    expect(result.audit?.role).toBe("owner");
    expect(result.audit?.reason).toBe("COMPANY_TRANSFER_OWNER_SOLE_APPROVAL");
    expect(result.audit?.approval_policy_version).toBe(SOLE_OWNER_CT_APPROVAL_POLICY_VERSION);
    expect(result.audit?.requester_user_id).toBe(result.audit?.approver_user_id);
  });

  it("C: Owner + CERTIFICATION → allowed (Owner path)", () => {
    const result = evaluateSoleAdminCompanyTransferSelfApproval({
      ...baseOk,
      actor_is_owner: true,
      amount_pence: 50,
      other_eligible_approver_count: 1,
      override_reason: "Owner certification sole approval with audit reason",
    });
    expect(result.ok).toBe(true);
    expect(result.audit?.owner_override).toBe(true);
    expect(result.audit?.transfer_type).toBe("CERTIFICATION");
  });

  it("D: super_admin WITHOUT is_owner + COMPANY_OUTGOING → no Owner bypass", () => {
    const result = evaluateSoleAdminCompanyTransferSelfApproval({
      ...ownerOutgoing,
      actor_is_owner: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason_codes).toEqual(
      expect.arrayContaining([
        SOLE_ADMIN_CT_REASON.AMOUNT_NOT_CERTIFICATION_1P,
        SOLE_ADMIN_CT_REASON.TRANSFER_TYPE_BLOCKED,
      ]),
    );
    expect(result.audit).toBeNull();
  });

  it("E: non-owner super_admin CERTIFICATION 1p → existing sole-admin preserved", () => {
    const result = evaluateSoleAdminCompanyTransferSelfApproval(baseOk);
    expect(result.ok).toBe(true);
    expect(result.audit?.owner_override).toBe(false);
    expect(result.audit?.sole_admin_override).toBe(true);
    expect(result.audit?.amount_pence).toBe(1);
    expect(result.audit?.reason).toBe("COMPANY_TRANSFER_CERTIFICATION");
  });

  it("F: ordinary admin → unchanged (blocked)", () => {
    expect(
      evaluateSoleAdminCompanyTransferSelfApproval({
        ...baseOk,
        actor_role: "admin",
        actor_is_owner: false,
      }).reason_codes,
    ).toContain(SOLE_ADMIN_CT_REASON.ROLE_NOT_SUPER_ADMIN);
  });

  it("G: COMPANY_INTERNAL → Owner exception NOT granted", () => {
    const result = evaluateSoleAdminCompanyTransferSelfApproval({
      ...ownerOutgoing,
      transfer_type: "COMPANY_INTERNAL",
    });
    expect(result.ok).toBe(false);
    expect(result.reason_codes.length).toBeGreaterThan(0);
  });

  it("H: COMPANY_PAYABLE → Owner exception NOT granted", () => {
    const result = evaluateSoleAdminCompanyTransferSelfApproval({
      ...ownerOutgoing,
      transfer_type: "COMPANY_PAYABLE",
    });
    expect(result.ok).toBe(false);
  });

  it("blocks when another eligible approver exists (non-owner)", () => {
    const result = evaluateSoleAdminCompanyTransferSelfApproval({
      ...baseOk,
      other_eligible_approver_count: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.reason_codes).toContain(SOLE_ADMIN_CT_REASON.OTHER_APPROVER_EXISTS);
  });

  it("blocks company_outgoing type and missing confirmation/reason (non-owner)", () => {
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
        ...ownerOutgoing,
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

  it("L: frontend button state matches backend Owner/non-owner rule", () => {
    expect(canUiSoleApproveCompanyTransfer({
      actor_is_owner: true,
      transfer_type: "COMPANY_OUTGOING",
      amount_pence: 111,
      owner_sole_approval_limit_pence: SOLE_OWNER_CT_DEFAULT_LIMIT_PENCE,
    })).toBe(true);
    expect(canUiSoleApproveCompanyTransfer({
      actor_is_owner: true,
      transfer_type: "CERTIFICATION",
      amount_pence: 50,
    })).toBe(true);
    expect(canUiSoleApproveCompanyTransfer({
      actor_is_owner: true,
      transfer_type: "COMPANY_INTERNAL",
      amount_pence: 111,
    })).toBe(false);
    expect(canUiSoleApproveCompanyTransfer({
      actor_is_owner: false,
      transfer_type: "COMPANY_OUTGOING",
      amount_pence: 111,
    })).toBe(false);
    expect(canUiSoleApproveCompanyTransfer({
      actor_is_owner: false,
      transfer_type: "CERTIFICATION",
      amount_pence: 1,
    })).toBe(true);
    expect(canUiSoleApproveCompanyTransfer({
      actor_is_owner: false,
      transfer_type: "CERTIFICATION",
      amount_pence: 2,
    })).toBe(false);
  });

  it("Owner over configured limit is blocked on UI and backend", () => {
    expect(canUiSoleApproveCompanyTransfer({
      actor_is_owner: true,
      transfer_type: "COMPANY_OUTGOING",
      amount_pence: 30_000,
      owner_sole_approval_limit_pence: 25_000,
    })).toBe(false);
    const result = evaluateSoleAdminCompanyTransferSelfApproval({
      ...ownerOutgoing,
      amount_pence: 30_000,
      owner_sole_approval_limit_pence: 25_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason_codes).toContain(SOLE_ADMIN_CT_REASON.AMOUNT_OVER_LIMIT);
  });

  it("LIVE on uses sole/owner path instead of blanket self-approve disable", () => {
    expect(shouldUseCompanyTransferSoleAdminSelfApprovalPath({
      live_company_transfer_execution_enabled: true,
      allow_self_approval: false,
    })).toBe(true);
    expect(shouldUseCompanyTransferSoleAdminSelfApprovalPath({
      live_company_transfer_execution_enabled: false,
      allow_self_approval: true,
    })).toBe(false);
    expect(resolveOwnerSoleApprovalLimitPence({
      owner_sole_approval_limit_pence: null,
      single_approval_max_pence: 25_000,
    })).toBe(25_000);
  });
});
