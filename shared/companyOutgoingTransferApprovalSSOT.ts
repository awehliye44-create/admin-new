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
}): { ok: boolean; reason: string | null } {
  const requester = String(args.requester_id ?? "").trim();
  const approver = String(args.approver_id ?? "").trim();
  if (!approver) return { ok: false, reason: "APPROVER_REQUIRED" };
  if (requester && requester === approver) {
    return { ok: false, reason: "REQUESTER_CANNOT_SELF_APPROVE" };
  }
  return { ok: true, reason: null };
}
