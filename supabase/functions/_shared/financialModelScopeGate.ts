/**
 * Backend enforcement of financial-model isolation for admin finance pages.
 * A wrong-model service_area_id (URL param, manual API call, super admin) is rejected
 * with the stable FINANCIAL_MODEL_VIOLATION code. "All Services" is scoped to the
 * page's model — never all service areas.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  FINANCIAL_MODEL,
  FINANCIAL_MODEL_VIOLATION,
  resolveFinancialModelScope,
  type FinancialModel,
  type FinancialModelScopeResult,
} from "../../../shared/financialModelScopeSSOT.ts";

export { FINANCIAL_MODEL, FINANCIAL_MODEL_VIOLATION };
export type { FinancialModel, FinancialModelScopeResult };

export async function resolveServiceAreaFinancialScope(
  supabase: SupabaseClient,
  requiredModel: Exclude<FinancialModel, "FINANCIAL_MODEL_UNKNOWN">,
  requestedServiceAreaId?: string | null,
): Promise<FinancialModelScopeResult> {
  const { data, error } = await supabase
    .from("service_areas")
    .select("id, financial_model");

  if (error) {
    return {
      ok: false,
      code: FINANCIAL_MODEL_VIOLATION,
      requiredModel,
      error: `Unable to resolve service area financial models: ${error.message}`,
    };
  }

  return resolveFinancialModelScope(
    (data ?? []) as { id: string; financial_model?: unknown }[],
    requiredModel,
    requestedServiceAreaId ?? null,
  );
}
