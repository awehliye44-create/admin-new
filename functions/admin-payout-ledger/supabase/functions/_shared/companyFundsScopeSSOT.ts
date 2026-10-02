/**
 * Company funds scope — global Revolut source vs service-area segregation.
 * Fail-closed: never present MK-scoped company funds from a global source account.
 */

export type CompanyFundsScopeMode = "GLOBAL" | "SERVICE_AREA";

export type CompanyFundsScope = {
  /** Revolut balance + liability queries (null = all platform-collected). */
  balance_service_area_id: string | null;
  ui_service_area_id: string | null;
  scope_mode: CompanyFundsScopeMode;
  scope_label: string;
  is_global_source: boolean;
};

export function resolveCompanyFundsScope(args: {
  ui_service_area_id?: string | null;
  revolut_source_service_area_id?: string | null;
}): CompanyFundsScope {
  const uiSa = args.ui_service_area_id == null || args.ui_service_area_id === ""
    ? null
    : String(args.ui_service_area_id);
  const sourceSa = args.revolut_source_service_area_id == null
    || args.revolut_source_service_area_id === ""
    ? null
    : String(args.revolut_source_service_area_id);

  if (sourceSa == null) {
    return {
      balance_service_area_id: null,
      ui_service_area_id: uiSa,
      scope_mode: "GLOBAL",
      scope_label:
        "Global company funds — Revolut source account is not segregated by service area",
      is_global_source: true,
    };
  }

  return {
    balance_service_area_id: sourceSa,
    ui_service_area_id: uiSa,
    scope_mode: "SERVICE_AREA",
    scope_label: "Service-area company funds — Revolut source is scoped to this service area",
    is_global_source: false,
  };
}
