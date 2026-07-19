/**
 * Sole-admin company transfer self-approval — narrow four-eyes exception.
 * Does NOT disable separation-of-duties globally. Never for staff/admin roles.
 * Fail-closed: every gate must pass; explicit confirmation + audit required.
 */

export const SOLE_ADMIN_CT_APPROVAL_POLICY_VERSION = "SOLE_ADMIN_CT_APPROVAL_V1" as const;

export const SOLE_ADMIN_CT_SETTING = {
  ENABLED: "allow_sole_admin_company_transfer_approval",
  LIMIT_PENCE: "sole_admin_company_transfer_limit_pence",
  ALLOWED_TYPES: "sole_admin_company_transfer_allowed_types",
} as const;

/** Fail-closed default: certification only until explicitly expanded. */
export const SOLE_ADMIN_CT_DEFAULT_ALLOWED_TYPES = ["CERTIFICATION"] as const;

export const SOLE_ADMIN_CT_ELIGIBLE_APPROVER_ROLES = [
  "super_admin",
  "admin",
  "finance_manager",
] as const;

export const SOLE_ADMIN_CT_REASON = {
  POLICY_DISABLED: "SOLE_ADMIN_APPROVAL_DISABLED",
  ROLE_NOT_SUPER_ADMIN: "SOLE_ADMIN_REQUIRES_SUPER_ADMIN",
  OTHER_APPROVER_EXISTS: "SOLE_ADMIN_SECOND_APPROVER_EXISTS",
  AMOUNT_OVER_LIMIT: "SOLE_ADMIN_AMOUNT_OVER_LIMIT",
  AMOUNT_NOT_CERTIFICATION_1P: "SOLE_ADMIN_REQUIRES_CERTIFICATION_1P",
  LIMIT_NOT_CONFIGURED: "SOLE_ADMIN_LIMIT_NOT_CONFIGURED",
  TRANSFER_TYPE_BLOCKED: "SOLE_ADMIN_TRANSFER_TYPE_BLOCKED",
  PAYEE_NOT_VERIFIED: "SOLE_ADMIN_PAYEE_NOT_PROVIDER_VERIFIED",
  MONEY_SOURCE_INVALID: "SOLE_ADMIN_MONEY_SOURCE_INVALID",
  FUNDING_GATE_BLOCKED: "SOLE_ADMIN_FUNDING_GATE_BLOCKED",
  PROVIDER_PAYMENT_EXISTS: "SOLE_ADMIN_PROVIDER_PAYMENT_EXISTS",
  LEDGER_DEBIT_EXISTS: "SOLE_ADMIN_LEDGER_DEBIT_EXISTS",
  CONFIRMATION_REQUIRED: "SOLE_ADMIN_CONFIRMATION_REQUIRED",
  OVERRIDE_REASON_REQUIRED: "SOLE_ADMIN_OVERRIDE_REASON_REQUIRED",
  NOT_SELF_APPROVAL: "SOLE_ADMIN_NOT_SELF_APPROVAL",
} as const;

export type SoleAdminCtReasonCode =
  (typeof SOLE_ADMIN_CT_REASON)[keyof typeof SOLE_ADMIN_CT_REASON];

export const SOLE_ADMIN_CT_REASON_LABEL: Record<SoleAdminCtReasonCode, string> = {
  SOLE_ADMIN_APPROVAL_DISABLED: "Sole-admin company transfer approval is disabled",
  SOLE_ADMIN_REQUIRES_SUPER_ADMIN: "Only a super admin may use sole-admin approval",
  SOLE_ADMIN_SECOND_APPROVER_EXISTS:
    "A second authorised company-transfer approver exists — self-approval blocked",
  SOLE_ADMIN_AMOUNT_OVER_LIMIT: "Amount exceeds the sole-admin approval limit",
  SOLE_ADMIN_REQUIRES_CERTIFICATION_1P:
    "Sole-admin approval is limited to CERTIFICATION transfers of exactly £0.01 (1p)",
  SOLE_ADMIN_LIMIT_NOT_CONFIGURED: "Sole-admin approval limit is not configured",
  SOLE_ADMIN_TRANSFER_TYPE_BLOCKED:
    "Transfer type is not permitted for sole-admin approval",
  SOLE_ADMIN_PAYEE_NOT_PROVIDER_VERIFIED: "Payee must be PROVIDER_VERIFIED",
  SOLE_ADMIN_MONEY_SOURCE_INVALID:
    "Sole-admin approval requires ONECAB Available Company Funds (COMPANY_BALANCE)",
  SOLE_ADMIN_FUNDING_GATE_BLOCKED: "Company funds gate did not pass",
  SOLE_ADMIN_PROVIDER_PAYMENT_EXISTS:
    "Transfer already has a provider payment — sole-admin approval blocked",
  SOLE_ADMIN_LEDGER_DEBIT_EXISTS:
    "Transfer already has a company ledger debit — sole-admin approval blocked",
  SOLE_ADMIN_CONFIRMATION_REQUIRED:
    "Explicit sole-admin confirmation is required",
  SOLE_ADMIN_OVERRIDE_REASON_REQUIRED:
    "A full audit override reason is required (min 10 characters)",
  SOLE_ADMIN_NOT_SELF_APPROVAL: "Sole-admin policy applies only to self-approval",
};

export type SoleAdminCtApprovalAudit = {
  requester_user_id: string | null;
  approver_user_id: string;
  sole_admin_override: true;
  role: "super_admin";
  reason: "COMPANY_TRANSFER_CERTIFICATION";
  override_reason: string;
  approval_policy_version: typeof SOLE_ADMIN_CT_APPROVAL_POLICY_VERSION;
  approved_at: string;
  amount_pence: number;
  payee_id: string | null;
  transfer_id?: string | null;
  transfer_reference: string | null;
  other_eligible_approver_count: number;
  limit_pence: number;
  transfer_type: string | null;
};

export function parseSoleAdminCtSettingEnabled(raw: unknown): boolean {
  const s = String(raw ?? "false").replace(/^"|"$/g, "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

export function parseSoleAdminCtLimitPence(raw: unknown): number | null {
  const s = String(raw ?? "").replace(/^"|"$/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** Comma/space-separated types; empty/missing → CERTIFICATION only (fail-closed). */
export function parseSoleAdminCtAllowedTransferTypes(raw: unknown): string[] {
  const s = String(raw ?? "").replace(/^"|"$/g, "").trim();
  if (!s) return [...SOLE_ADMIN_CT_DEFAULT_ALLOWED_TYPES];
  const parts = s.split(/[,|\s]+/).map((p) => p.trim().toUpperCase()).filter(Boolean);
  return parts.length > 0 ? [...new Set(parts)] : [...SOLE_ADMIN_CT_DEFAULT_ALLOWED_TYPES];
}

export function isCompanyTransferPayeeProviderVerified(args: {
  account_verification_status?: string | null;
  provider_link_status?: string | null;
}): boolean {
  const vs = String(args.account_verification_status ?? "").trim().toUpperCase();
  const link = String(args.provider_link_status ?? "").trim().toUpperCase();
  return (
    vs === "VERIFIED"
    || vs === "PROVIDER_VERIFIED"
    || link === "PROVIDER_VERIFIED"
  );
}

export function isOnecabAvailableCompanyFundsSource(moneySource: string | null | undefined): boolean {
  return String(moneySource ?? "").trim().toUpperCase() === "COMPANY_BALANCE";
}

/**
 * Evaluate sole-admin self-approval exception.
 * Call only when requester_id === approver_id. Does not replace four-eyes for others.
 */
export function evaluateSoleAdminCompanyTransferSelfApproval(args: {
  policy_enabled: boolean;
  actor_role: string | null | undefined;
  requester_user_id: string | null | undefined;
  approver_user_id: string | null | undefined;
  other_eligible_approver_count: number;
  amount_pence: number;
  limit_pence: number | null;
  transfer_type: string | null | undefined;
  allowed_transfer_types?: string[];
  payee_provider_verified: boolean;
  money_source: string | null | undefined;
  funding_gate_allowed: boolean;
  has_provider_payment: boolean;
  has_company_ledger_debit: boolean;
  confirm_sole_admin_approval: boolean;
  override_reason: string | null | undefined;
  payee_id?: string | null;
  transfer_id?: string | null;
  transfer_reference?: string | null;
  approved_at?: string;
}): {
  ok: boolean;
  reason_codes: SoleAdminCtReasonCode[];
  audit: SoleAdminCtApprovalAudit | null;
} {
  const reasons: SoleAdminCtReasonCode[] = [];
  const requester = String(args.requester_user_id ?? "").trim();
  const approver = String(args.approver_user_id ?? "").trim();
  const amount = Math.round(Number(args.amount_pence) || 0);
  const allowedTypes = (args.allowed_transfer_types?.length
    ? args.allowed_transfer_types
    : [...SOLE_ADMIN_CT_DEFAULT_ALLOWED_TYPES]
  ).map((t) => t.toUpperCase());
  const transferType = String(args.transfer_type ?? "").trim().toUpperCase();
  const override = String(args.override_reason ?? "").trim();

  if (!approver || !requester || requester !== approver) {
    reasons.push(SOLE_ADMIN_CT_REASON.NOT_SELF_APPROVAL);
  }
  if (!args.policy_enabled) {
    reasons.push(SOLE_ADMIN_CT_REASON.POLICY_DISABLED);
  }
  if (String(args.actor_role ?? "").trim().toLowerCase() !== "super_admin") {
    reasons.push(SOLE_ADMIN_CT_REASON.ROLE_NOT_SUPER_ADMIN);
  }
  if (Math.max(0, Math.round(Number(args.other_eligible_approver_count) || 0)) > 0) {
    reasons.push(SOLE_ADMIN_CT_REASON.OTHER_APPROVER_EXISTS);
  }
  // Controlled certification exception: CERTIFICATION + exactly 1p only.
  if (transferType !== "CERTIFICATION" || amount !== 1) {
    reasons.push(SOLE_ADMIN_CT_REASON.AMOUNT_NOT_CERTIFICATION_1P);
  }
  if (!transferType || !allowedTypes.includes(transferType)) {
    reasons.push(SOLE_ADMIN_CT_REASON.TRANSFER_TYPE_BLOCKED);
  }
  if (args.limit_pence == null || !(args.limit_pence >= 0)) {
    reasons.push(SOLE_ADMIN_CT_REASON.LIMIT_NOT_CONFIGURED);
  } else if (amount > args.limit_pence) {
    reasons.push(SOLE_ADMIN_CT_REASON.AMOUNT_OVER_LIMIT);
  }
  if (!args.payee_provider_verified) {
    reasons.push(SOLE_ADMIN_CT_REASON.PAYEE_NOT_VERIFIED);
  }
  if (!isOnecabAvailableCompanyFundsSource(args.money_source)) {
    reasons.push(SOLE_ADMIN_CT_REASON.MONEY_SOURCE_INVALID);
  }
  if (!args.funding_gate_allowed) {
    reasons.push(SOLE_ADMIN_CT_REASON.FUNDING_GATE_BLOCKED);
  }
  if (args.has_provider_payment) {
    reasons.push(SOLE_ADMIN_CT_REASON.PROVIDER_PAYMENT_EXISTS);
  }
  if (args.has_company_ledger_debit) {
    reasons.push(SOLE_ADMIN_CT_REASON.LEDGER_DEBIT_EXISTS);
  }
  if (args.confirm_sole_admin_approval !== true) {
    reasons.push(SOLE_ADMIN_CT_REASON.CONFIRMATION_REQUIRED);
  }
  if (override.length < 10) {
    reasons.push(SOLE_ADMIN_CT_REASON.OVERRIDE_REASON_REQUIRED);
  }

  const unique = [...new Set(reasons)];
  if (unique.length > 0) {
    return { ok: false, reason_codes: unique, audit: null };
  }

  return {
    ok: true,
    reason_codes: [],
    audit: {
      requester_user_id: requester || null,
      approver_user_id: approver,
      sole_admin_override: true,
      role: "super_admin",
      reason: "COMPANY_TRANSFER_CERTIFICATION",
      override_reason: override,
      approval_policy_version: SOLE_ADMIN_CT_APPROVAL_POLICY_VERSION,
      approved_at: args.approved_at ?? new Date().toISOString(),
      amount_pence: amount,
      payee_id: args.payee_id ?? null,
      transfer_id: args.transfer_id ?? null,
      transfer_reference: args.transfer_reference ?? null,
      other_eligible_approver_count: 0,
      limit_pence: args.limit_pence!,
      transfer_type: transferType || null,
    },
  };
}

export function soleAdminCtReasonLabel(code: string): string {
  const key = code as SoleAdminCtReasonCode;
  return SOLE_ADMIN_CT_REASON_LABEL[key] ?? code;
}
