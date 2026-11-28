/** Offline test/audit-only helpers; not part of Edge uploads. */
import { COMPANY_TRANSFER_MUTATION_ACTIONS, COMPANY_FUNDS_EXECUTION_ROLES } from "../../../functions/_shared/companyFundsAuthoritySSOT.ts";


export function isCompanyTransferMutationAction(action: string | null | undefined): boolean {
  return (COMPANY_TRANSFER_MUTATION_ACTIONS as readonly string[]).includes(String(action ?? ""));
}


export function isCompanyFundsExecutionRole(role: string | null | undefined): boolean {
  return (COMPANY_FUNDS_EXECUTION_ROLES as readonly string[]).includes(String(role ?? ""));
}

export * from "../../../functions/_shared/companyFundsAuthoritySSOT.ts";
