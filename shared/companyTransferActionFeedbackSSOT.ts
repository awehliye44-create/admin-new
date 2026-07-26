/**
 * Company transfer action feedback SSOT — action-specific toasts + status checks.
 * Never invent success from HTTP 200 alone; compare returned canonical status.
 */

export const COMPANY_TRANSFER_ACTION_SUCCESS_MESSAGE = {
  approve: "Transfer approved and ready for execution.",
  approve_sole_admin:
    "Transfer approved using sole-admin override and is ready for execution.",
  submit_for_approval: "Transfer submitted for approval.",
  return_to_draft: "Transfer returned to draft.",
  reject: "Transfer rejected.",
  cancel: "Transfer cancelled.",
  mark_ready_for_execution: "Transfer is ready for execution.",
  execute: "Transfer execution started.",
} as const;

export type CompanyTransferFeedbackAction =
  keyof typeof COMPANY_TRANSFER_ACTION_SUCCESS_MESSAGE
  | "approve";

/** Canonical approval timeline shown in the UI. */
export const COMPANY_TRANSFER_STATUS_TIMELINE = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "READY_FOR_EXECUTION",
] as const;

export type CompanyTransferTimelineStatus =
  (typeof COMPANY_TRANSFER_STATUS_TIMELINE)[number];

export const RETURN_TO_DRAFT_CONFIRM_MESSAGE =
  "This will remove approval and require the transfer to be approved again.";

/** Expected post-action statuses (any match = success alignment). */
export function expectedStatusesForCompanyTransferAction(
  action: string,
  opts?: { sole_admin_override?: boolean },
): string[] {
  switch (String(action)) {
    case "approve":
      return opts?.sole_admin_override
        ? ["READY_FOR_EXECUTION"]
        : ["APPROVED", "READY_FOR_EXECUTION"];
    case "submit_for_approval":
      return ["AWAITING_APPROVAL"];
    case "return_to_draft":
      return ["DRAFT"];
    case "reject":
      return ["REJECTED"];
    case "cancel":
      return ["CANCELLED"];
    case "mark_ready_for_execution":
      return ["READY_FOR_EXECUTION"];
    case "execute":
      return ["PROCESSING", "READY_FOR_EXECUTION", "COMPLETED", "PAID"];
    default:
      return [];
  }
}

export function companyTransferActionSuccessMessage(
  action: string,
  opts?: { sole_admin_override?: boolean },
): string {
  if (action === "approve" && opts?.sole_admin_override) {
    return COMPANY_TRANSFER_ACTION_SUCCESS_MESSAGE.approve_sole_admin;
  }
  const key = action as keyof typeof COMPANY_TRANSFER_ACTION_SUCCESS_MESSAGE;
  return COMPANY_TRANSFER_ACTION_SUCCESS_MESSAGE[key]
    ?? "Transfer action completed.";
}

export function companyTransferStatusMismatchMessage(status: string | null | undefined): string {
  const s = String(status ?? "UNKNOWN").toUpperCase() || "UNKNOWN";
  return `Action completed, but transfer status is now ${s}. Review Audit History.`;
}

export type CompanyTransferActionFeedbackInput = {
  action: string;
  previous_status?: string | null;
  new_status?: string | null;
  transfer_ref?: string | null;
  acting_admin?: string | null;
  action_at?: string | null;
  sole_admin_override?: boolean;
  blocked?: boolean;
};

export type CompanyTransferActionFeedback = {
  title: string;
  description: string;
  status_aligned: boolean;
  variant: "success" | "warning" | "error";
};

export function buildCompanyTransferActionFeedback(
  input: CompanyTransferActionFeedbackInput,
): CompanyTransferActionFeedback {
  if (input.blocked) {
    return {
      title: "Transfer validation failed",
      description: formatCompanyTransferActionMeta(input),
      status_aligned: false,
      variant: "error",
    };
  }

  const expected = expectedStatusesForCompanyTransferAction(input.action, {
    sole_admin_override: input.sole_admin_override,
  });
  const newStatus = String(input.new_status ?? "").toUpperCase();
  const statusAligned = expected.length === 0
    || (newStatus.length > 0 && expected.includes(newStatus));

  const title = statusAligned
    ? companyTransferActionSuccessMessage(input.action, {
      sole_admin_override: input.sole_admin_override,
    })
    : companyTransferStatusMismatchMessage(input.new_status);

  return {
    title,
    description: formatCompanyTransferActionMeta(input),
    status_aligned: statusAligned,
    variant: statusAligned ? "success" : "warning",
  };
}

export function formatCompanyTransferActionMeta(
  input: Pick<
    CompanyTransferActionFeedbackInput,
    "previous_status" | "new_status" | "transfer_ref" | "acting_admin" | "action_at"
  >,
): string {
  const prev = String(input.previous_status ?? "—").toUpperCase() || "—";
  const next = String(input.new_status ?? "—").toUpperCase() || "—";
  const when = input.action_at
    ? new Date(input.action_at).toLocaleString("en-GB")
    : new Date().toLocaleString("en-GB");
  const admin = String(input.acting_admin ?? "—").trim() || "—";
  const ref = String(input.transfer_ref ?? "—").trim() || "—";
  return [
    `Ref: ${ref}`,
    `Status: ${prev} → ${next}`,
    `By: ${admin}`,
    `At: ${when}`,
  ].join(" · ");
}

/** Index of current status on the approval timeline; -1 if off-path. */
export function companyTransferTimelineIndex(status: string | null | undefined): number {
  const s = String(status ?? "").toUpperCase();
  return COMPANY_TRANSFER_STATUS_TIMELINE.indexOf(
    s as CompanyTransferTimelineStatus,
  );
}

/** READY must never silently invite Submit for Approval. */
export function canShowSubmitForApprovalAction(status: string | null | undefined): boolean {
  return String(status ?? "").toUpperCase() === "DRAFT"
    || String(status ?? "").toUpperCase() === "BLOCKED"
    || String(status ?? "").toUpperCase() === "FUNDING_UNAVAILABLE";
}

/** Return-to-draft is allowed only with explicit confirm (never silent). */
export function requiresReturnToDraftConfirmation(status: string | null | undefined): boolean {
  const s = String(status ?? "").toUpperCase();
  return [
    "AWAITING_APPROVAL",
    "APPROVED",
    "READY_FOR_EXECUTION",
    "BLOCKED",
    "SCHEDULED",
  ].includes(s);
}
