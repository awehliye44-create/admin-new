/** Admin presentation-only helpers; not part of Edge uploads. */
import { DriverWalletAdjustmentReasonCategory, normalizeDriverWalletAdjustmentReasonCategory, DRIVER_WALLET_ADJUSTMENT_REASON_LABELS, formatDriverWalletAdminIdShort } from "../../supabase/functions/_shared/driverWalletManualAdjustmentSSOT.ts";


export function parseDriverWalletAdminAdjustmentMetadata(
  metadata: Record<string, unknown> | null | undefined,
): {
  reasonCategory: DriverWalletAdjustmentReasonCategory | null;
  reasonCategoryLabel: string | null;
  reasonNote: string | null;
  evidenceReference: string | null;
  createdByAdminId: string | null;
  approvedByAdminId: string | null;
  payoutEligible: boolean | null;
} {
  const raw = metadata ?? {};
  const reasonCategory = normalizeDriverWalletAdjustmentReasonCategory(
    raw.reason_category != null ? String(raw.reason_category) : null,
  );
  return {
    reasonCategory,
    reasonCategoryLabel: reasonCategory
      ? DRIVER_WALLET_ADJUSTMENT_REASON_LABELS[reasonCategory]
      : (raw.reason_category_label != null ? String(raw.reason_category_label) : null),
    reasonNote: raw.reason_note != null ? String(raw.reason_note) : null,
    evidenceReference: raw.evidence_reference != null ? String(raw.evidence_reference) : null,
    createdByAdminId: raw.created_by_admin_id != null ? String(raw.created_by_admin_id) : null,
    approvedByAdminId: raw.approved_by_admin_id != null ? String(raw.approved_by_admin_id) : null,
    payoutEligible: raw.payout_eligible === true
      ? true
      : raw.payout_eligible === false
      ? false
      : null,
  };
}


export function formatDriverWalletAdminAdjustmentAuditNotes(args: {
  reasonCategoryLabel?: string | null;
  reasonNote?: string | null;
  createdByAdminId?: string | null;
  approvedByAdminId?: string | null;
}): string {
  const parts: string[] = [];
  if (args.reasonCategoryLabel) parts.push(args.reasonCategoryLabel);
  if (args.reasonNote) parts.push(args.reasonNote);
  const audit: string[] = [];
  if (args.createdByAdminId) {
    audit.push(`Created ${formatDriverWalletAdminIdShort(args.createdByAdminId)}`);
  }
  if (args.approvedByAdminId) {
    audit.push(`Approved ${formatDriverWalletAdminIdShort(args.approvedByAdminId)}`);
  }
  if (audit.length) parts.push(audit.join(" · "));
  return parts.join(" · ") || "—";
}

export * from "../../supabase/functions/_shared/driverWalletManualAdjustmentSSOT.ts";
