/**
 * Owner sole-approval SSOT behavioural tests (A–H, L).
 * Run: deno test --allow-read shared/companyTransferSoleAdminApprovalSSOT.deno.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canUiSoleApproveCompanyTransfer,
  evaluateSoleAdminCompanyTransferSelfApproval,
  SOLE_ADMIN_CT_REASON,
  SOLE_OWNER_CT_APPROVAL_POLICY_VERSION,
} from "./companyTransferSoleAdminApprovalSSOT.ts";

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
  transfer_type: "COMPANY_OUTGOING",
  allowed_transfer_types: ["CERTIFICATION"],
  other_eligible_approver_count: 2,
  override_reason: "Owner sole approval for company outgoing transfer audit",
  transfer_reference: "COT-75A57C98",
};

Deno.test("A: Owner + COMPANY_OUTGOING allowed", () => {
  const result = evaluateSoleAdminCompanyTransferSelfApproval(ownerOutgoing);
  assertEquals(result.ok, true);
  assertEquals(result.audit?.owner_override, true);
  assertEquals(result.audit?.amount_pence, 111);
});

Deno.test("B: Owner self-approve audit fields", () => {
  const result = evaluateSoleAdminCompanyTransferSelfApproval(ownerOutgoing);
  assertEquals(result.ok, true);
  assertEquals(result.audit?.role, "owner");
  assertEquals(result.audit?.reason, "COMPANY_TRANSFER_OWNER_SOLE_APPROVAL");
  assertEquals(result.audit?.approval_policy_version, SOLE_OWNER_CT_APPROVAL_POLICY_VERSION);
  assertEquals(result.audit?.requester_user_id, result.audit?.approver_user_id);
});

Deno.test("C: Owner + CERTIFICATION allowed", () => {
  const result = evaluateSoleAdminCompanyTransferSelfApproval({
    ...baseOk,
    actor_is_owner: true,
    amount_pence: 50,
    other_eligible_approver_count: 1,
    override_reason: "Owner certification sole approval with audit reason",
  });
  assertEquals(result.ok, true);
  assertEquals(result.audit?.owner_override, true);
});

Deno.test("D: non-owner super_admin COMPANY_OUTGOING blocked", () => {
  const result = evaluateSoleAdminCompanyTransferSelfApproval({
    ...ownerOutgoing,
    actor_is_owner: false,
  });
  assertEquals(result.ok, false);
  assert(result.reason_codes.includes(SOLE_ADMIN_CT_REASON.AMOUNT_NOT_CERTIFICATION_1P));
  assert(result.reason_codes.includes(SOLE_ADMIN_CT_REASON.TRANSFER_TYPE_BLOCKED));
});

Deno.test("E: non-owner CERTIFICATION 1p preserved", () => {
  const result = evaluateSoleAdminCompanyTransferSelfApproval(baseOk);
  assertEquals(result.ok, true);
  assertEquals(result.audit?.owner_override, false);
  assertEquals(result.audit?.reason, "COMPANY_TRANSFER_CERTIFICATION");
});

Deno.test("F: ordinary admin blocked", () => {
  const result = evaluateSoleAdminCompanyTransferSelfApproval({
    ...baseOk,
    actor_role: "admin",
    actor_is_owner: false,
  });
  assert(result.reason_codes.includes(SOLE_ADMIN_CT_REASON.ROLE_NOT_SUPER_ADMIN));
});

Deno.test("G: COMPANY_INTERNAL not Owner-exception", () => {
  const result = evaluateSoleAdminCompanyTransferSelfApproval({
    ...ownerOutgoing,
    transfer_type: "COMPANY_INTERNAL",
  });
  assertEquals(result.ok, false);
});

Deno.test("H: COMPANY_PAYABLE not Owner-exception", () => {
  const result = evaluateSoleAdminCompanyTransferSelfApproval({
    ...ownerOutgoing,
    transfer_type: "COMPANY_PAYABLE",
  });
  assertEquals(result.ok, false);
});

Deno.test("L: UI gate matches backend", () => {
  assertEquals(canUiSoleApproveCompanyTransfer({
    actor_is_owner: true,
    transfer_type: "COMPANY_OUTGOING",
    amount_pence: 111,
  }), true);
  assertEquals(canUiSoleApproveCompanyTransfer({
    actor_is_owner: false,
    transfer_type: "COMPANY_OUTGOING",
    amount_pence: 111,
  }), false);
  assertEquals(canUiSoleApproveCompanyTransfer({
    actor_is_owner: false,
    transfer_type: "CERTIFICATION",
    amount_pence: 1,
  }), true);
});
