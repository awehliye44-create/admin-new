/**
 * Financial model isolation — admin page scope SSOT.
 *
 * Two hard-separated pipelines (see .cursor/rules/financial-model-isolation-lock.mdc):
 *  - PLATFORM_COLLECTED             → Payment Sessions, Financial Reconciliation,
 *                                     Driver Wallet Ledger, Payout Ledger
 *  - DRIVER_COLLECTED_COMMISSION_WALLET → Commission Wallet
 *
 * Admin service-area dropdowns and the backend queries behind them must never
 * mix models. "All Services" always means "all service areas of THIS page's model".
 */

export const FINANCIAL_MODEL = {
  PLATFORM_COLLECTED: 'PLATFORM_COLLECTED',
  DRIVER_COLLECTED_COMMISSION_WALLET: 'DRIVER_COLLECTED_COMMISSION_WALLET',
} as const;

export type FinancialModel = typeof FINANCIAL_MODEL[keyof typeof FINANCIAL_MODEL];

export const FINANCIAL_MODEL_VIOLATION = 'FINANCIAL_MODEL_VIOLATION';

/** Admin page slug → required financial model. No page may be absent from this map. */
export const ADMIN_PAGE_FINANCIAL_MODEL: Record<string, FinancialModel> = {
  'payment-sessions': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'financial-reconciliation': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'driver-wallet-ledger': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'payout-ledger': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'commission-wallet': FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
};

/**
 * Service areas with a NULL/legacy financial_model are treated as PLATFORM_COLLECTED
 * (platform capture is the historic default). They never appear on Commission Wallet.
 */
export function normaliseServiceAreaFinancialModel(value: unknown): FinancialModel {
  return value === FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
    ? FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
    : FINANCIAL_MODEL.PLATFORM_COLLECTED;
}

export function serviceAreaMatchesFinancialModel(
  serviceAreaFinancialModel: unknown,
  requiredModel: FinancialModel,
): boolean {
  return normaliseServiceAreaFinancialModel(serviceAreaFinancialModel) === requiredModel;
}

export function filterServiceAreasByFinancialModel<
  T extends { financial_model?: unknown },
>(serviceAreas: readonly T[], requiredModel: FinancialModel): T[] {
  return serviceAreas.filter((sa) => serviceAreaMatchesFinancialModel(sa.financial_model, requiredModel));
}

export function emptyServiceAreaScopeMessage(requiredModel: FinancialModel): string {
  return requiredModel === FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
    ? 'No Driver-Collected service areas configured'
    : 'No Platform-Collected service areas configured';
}

export type FinancialModelScopeResult =
  | { ok: true; requiredModel: FinancialModel; allowedServiceAreaIds: string[]; serviceAreaId: string | null }
  | { ok: false; code: typeof FINANCIAL_MODEL_VIOLATION; error: string; requiredModel: FinancialModel };

/**
 * Resolve the service-area scope for a page.
 * - requested id of the wrong model → FINANCIAL_MODEL_VIOLATION (URL/API cannot bypass)
 * - no requested id ("All Services") → all service areas of the page's model only
 */
export function resolveFinancialModelScope(
  serviceAreas: readonly { id: string; financial_model?: unknown }[],
  requiredModel: FinancialModel,
  requestedServiceAreaId?: string | null,
): FinancialModelScopeResult {
  const allowed = filterServiceAreasByFinancialModel(serviceAreas, requiredModel).map((sa) => sa.id);

  if (requestedServiceAreaId) {
    if (!allowed.includes(requestedServiceAreaId)) {
      return {
        ok: false,
        code: FINANCIAL_MODEL_VIOLATION,
        requiredModel,
        error: `Service area ${requestedServiceAreaId} does not belong to ${requiredModel}`,
      };
    }
    return { ok: true, requiredModel, allowedServiceAreaIds: [requestedServiceAreaId], serviceAreaId: requestedServiceAreaId };
  }

  return { ok: true, requiredModel, allowedServiceAreaIds: allowed, serviceAreaId: null };
}

/**
 * Trip-linked financial rows use the IMMUTABLE trip stamp, never live SA config.
 */
export function tripRowMatchesFinancialModel(
  tripFinancialModel: unknown,
  requiredModel: FinancialModel,
): boolean {
  return normaliseServiceAreaFinancialModel(tripFinancialModel) === requiredModel;
}
