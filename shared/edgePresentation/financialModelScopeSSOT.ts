/** Admin presentation-only helpers; not part of Edge uploads. */
import { FinancialModel, resolveServiceAreaFinancialModel, FINANCIAL_MODEL } from "../../supabase/functions/_shared/financialModelScopeSSOT.ts";


/** @deprecated Phase 0c — use resolveServiceAreaFinancialModel (fail-closed). */
export function normaliseServiceAreaFinancialModel(value: unknown): FinancialModel {
  return resolveServiceAreaFinancialModel(value);
}


export function emptyServiceAreaScopeMessage(
  requiredModel: Exclude<FinancialModel, 'FINANCIAL_MODEL_UNKNOWN'>,
): string {
  return requiredModel === FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
    ? 'No Driver-Collected service areas configured'
    : 'No Platform-Collected service areas configured';
}

export * from "../../supabase/functions/_shared/financialModelScopeSSOT.ts";
