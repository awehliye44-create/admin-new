/** Roles allowed to execute company-funds mutations (must match adminPaymentGate). */
export const COMPANY_FUNDS_EXECUTION_ROLES = [
  "super_admin",
  "admin",
  "finance_manager",
] as const;

/** Staff roles that must never mutate company funds. */
export const COMPANY_FUNDS_REJECTED_STAFF_ROLES = [
  "customer_support",
  "support",
  "operator",
] as const;

/** Company outgoing transfer actions that change workflow or transfer state. */
export const COMPANY_TRANSFER_MUTATION_ACTIONS = [
  "create",
  "submit_for_approval",
  "approve",
  "reject",
  "cancel",
  "edit_draft",
  "return_to_draft",
  "mark_ready_for_execution",
  "execute",
  "mark_paid",
  "retry",
] as const;

export const COMPANY_TRANSFER_READ_ONLY_ACTIONS = [
  "view_evidence",
] as const;

export function isCompanyTransferReadOnlyAction(action: string | null | undefined): boolean {
  return (COMPANY_TRANSFER_READ_ONLY_ACTIONS as readonly string[]).includes(String(action ?? ""));
}

export function isCompanyFundsRejectedStaffRole(role: string | null | undefined): boolean {
  const r = String(role ?? "").trim().toLowerCase();
  return (COMPANY_FUNDS_REJECTED_STAFF_ROLES as readonly string[]).some(
    (blocked) => blocked === r,
  );
}

/** Reserve policy mutations routed through admin-company-operational-reserve edge. */
export const COMPANY_RESERVE_POLICY_ACTIONS = {
  SAVE_DRAFT: "save_draft",
  ACTIVATE: "activate",
  DISABLE: "disable",
} as const;
