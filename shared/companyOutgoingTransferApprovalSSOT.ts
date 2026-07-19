/**
 * Company outgoing transfer approval thresholds (pure SSOT).
 * Requester must never approve their own transfer.
 */

export type CompanyTransferApprovalTier = {
  /** Inclusive max for single approval (pence). Default £250 = 25000. */
  single_max_pence: number;
  /** Inclusive max for dual approval (pence). Above requires owner. Default £2500 = 250000. */
  dual_max_pence: number;
};

export const DEFAULT_COMPANY_TRANSFER_APPROVAL_TIERS: CompanyTransferApprovalTier = {
  single_max_pence: 25_000,
  dual_max_pence: 250_000,
};

export type CompanyTransferApprovalRequirement = {
  approvals_required: number;
  requires_owner: boolean;
  tier: "SINGLE" | "DUAL" | "OWNER";
};

export function resolveCompanyTransferApprovalsRequired(
  amountPence: number,
  tiers: CompanyTransferApprovalTier = DEFAULT_COMPANY_TRANSFER_APPROVAL_TIERS,
): CompanyTransferApprovalRequirement {
  const amount = Math.max(0, Math.round(Number(amountPence) || 0));
  const singleMax = Math.max(0, Math.round(tiers.single_max_pence));
  const dualMax = Math.max(singleMax, Math.round(tiers.dual_max_pence));
  if (amount <= singleMax) {
    return { approvals_required: 1, requires_owner: false, tier: "SINGLE" };
  }
  if (amount <= dualMax) {
    return { approvals_required: 2, requires_owner: false, tier: "DUAL" };
  }
  return { approvals_required: 1, requires_owner: true, tier: "OWNER" };
}

export function canApproveCompanyTransfer(args: {
  requester_id: string | null | undefined;
  approver_id: string | null | undefined;
  category?: string | null;
  force_high_risk?: boolean;
  /** Defaults to true (single-admin). Pass false to enforce segregation. */
  allow_self_approval?: boolean;
}): { ok: boolean; reason: string | null } {
  const requester = String(args.requester_id ?? "").trim();
  const approver = String(args.approver_id ?? "").trim();
  if (!approver) return { ok: false, reason: "APPROVER_REQUIRED" };
  const allowSelf = args.allow_self_approval ?? true;
  if (!allowSelf && requester && requester === approver) {
    return { ok: false, reason: "REQUESTER_CANNOT_SELF_APPROVE" };
  }
  return { ok: true, reason: null };
}

/** High-risk categories always require at least one independent approval. */
export function resolveHighRiskApprovalRequirement(category: string | null | undefined): {
  always_require_approval: boolean;
  min_approvals: number;
} {
  const c = String(category ?? "").toUpperCase();
  const high = [
    "DIRECTOR_DIVIDEND",
    "DIRECTOR_LOAN",
    "COMPANY_WITHDRAWAL",
    "TAX_PAYMENT",
    "REGULATORY_PAYMENT",
  ];
  if (high.includes(c)) return { always_require_approval: true, min_approvals: 1 };
  return { always_require_approval: false, min_approvals: 0 };
}

/** Merge amount tiers with high-risk floor. */
export function resolveCompanyTransferApprovalsRequiredForCategory(
  amountPence: number,
  category: string | null | undefined,
  tiers: CompanyTransferApprovalTier = DEFAULT_COMPANY_TRANSFER_APPROVAL_TIERS,
): CompanyTransferApprovalRequirement {
  const base = resolveCompanyTransferApprovalsRequired(amountPence, tiers);
  const high = resolveHighRiskApprovalRequirement(category);
  if (!high.always_require_approval) return base;
  return {
    approvals_required: Math.max(base.approvals_required, high.min_approvals),
    requires_owner: base.requires_owner || amountPence > tiers.dual_max_pence,
    tier: base.tier === "OWNER" ? "OWNER" : base.approvals_required >= 2 ? "DUAL" : "SINGLE",
  };
}

/**
 * DIRECT_TRANSFER only for low-risk recurring within a configured cap.
 * High-risk categories must use DRAFT_FOR_APPROVAL.
 */
export function assertDirectTransferAllowed(args: {
  execution_mode: string | null | undefined;
  category: string | null | undefined;
  amount_pence: number;
  /** Default £100 = 10000 pence. */
  direct_max_pence?: number;
}): { ok: true } | { ok: false; status: string } {
  const mode = String(args.execution_mode ?? "DRAFT_FOR_APPROVAL").toUpperCase();
  if (mode !== "DIRECT_TRANSFER") return { ok: true };
  const high = resolveHighRiskApprovalRequirement(args.category);
  if (high.always_require_approval) {
    return { ok: false, status: "DIRECT_TRANSFER_FORBIDDEN_HIGH_RISK" };
  }
  const cap = Math.max(0, Math.round(args.direct_max_pence ?? 10_000));
  if (Math.round(args.amount_pence) > cap) {
    return { ok: false, status: "DIRECT_TRANSFER_AMOUNT_EXCEEDS_CAP" };
  }
  return { ok: true };
}
