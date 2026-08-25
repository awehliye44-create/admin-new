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

export function isDriverCollectedFinancialModel(value: unknown): boolean {
  return String(value ?? '').toUpperCase() === FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET;
}

/**
 * Explicit safe legacy bucket — NULL trip stamps are PLATFORM_COLLECTED only when
 * there is no Driver-Collected evidence (`commission_wallet_enabled === true`).
 * Never silently mix unknown/null Driver-Collected rows onto PLATFORM pages.
 */
export const LEGACY_NULL_AS_PLATFORM_COLLECTED = 'LEGACY_NULL_AS_PLATFORM_COLLECTED' as const;

export type TripPlatformAdminClassification =
  | {
    includeOnPlatformPage: true;
    model: typeof FINANCIAL_MODEL.PLATFORM_COLLECTED;
    bucket: typeof LEGACY_NULL_AS_PLATFORM_COLLECTED | null;
  }
  | {
    includeOnPlatformPage: false;
    model: typeof FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET | 'UNKNOWN_EXCLUDED';
    bucket: null;
  };

export function classifyTripForPlatformCollectedAdminPage(trip: {
  financial_model?: unknown;
  commission_wallet_enabled?: unknown;
}): TripPlatformAdminClassification {
  if (isDriverCollectedFinancialModel(trip.financial_model)) {
    return {
      includeOnPlatformPage: false,
      model: FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      bucket: null,
    };
  }
  const stampMissing = trip.financial_model == null || trip.financial_model === '';
  if (stampMissing && trip.commission_wallet_enabled === true) {
    return { includeOnPlatformPage: false, model: 'UNKNOWN_EXCLUDED', bucket: null };
  }
  if (stampMissing) {
    return {
      includeOnPlatformPage: true,
      model: FINANCIAL_MODEL.PLATFORM_COLLECTED,
      bucket: LEGACY_NULL_AS_PLATFORM_COLLECTED,
    };
  }
  if (String(trip.financial_model).toUpperCase() === FINANCIAL_MODEL.PLATFORM_COLLECTED) {
    return {
      includeOnPlatformPage: true,
      model: FINANCIAL_MODEL.PLATFORM_COLLECTED,
      bucket: null,
    };
  }
  return { includeOnPlatformPage: false, model: 'UNKNOWN_EXCLUDED', bucket: null };
}

export function filterTripsForPlatformCollectedAdminPage<
  T extends { financial_model?: unknown; commission_wallet_enabled?: unknown },
>(rows: readonly T[]): T[] {
  return rows.filter((row) => classifyTripForPlatformCollectedAdminPage(row).includeOnPlatformPage);
}

export function filterTripsForCommissionWalletAdminPage<
  T extends { financial_model?: unknown },
>(rows: readonly T[]): T[] {
  return rows.filter((row) => isDriverCollectedFinancialModel(row.financial_model));
}

/**
 * Payment Sessions isolation: null `service_area_id` is excluded unless the linked
 * trip is explicitly classified into PLATFORM (including the safe legacy-null bucket).
 */
export function paymentSessionIncludedOnPlatformCollectedAdminPage(
  row: {
    service_area_id?: string | null;
    trip_financial_model?: unknown;
    trip_commission_wallet_enabled?: unknown;
  },
  allowedServiceAreaIds: readonly string[],
): boolean {
  if (row.service_area_id) {
    if (!allowedServiceAreaIds.includes(row.service_area_id)) return false;
    if (row.trip_financial_model !== undefined || row.trip_commission_wallet_enabled !== undefined) {
      return classifyTripForPlatformCollectedAdminPage({
        financial_model: row.trip_financial_model,
        commission_wallet_enabled: row.trip_commission_wallet_enabled,
      }).includeOnPlatformPage;
    }
    return true;
  }
  // Null SA: require explicit trip classification evidence — never silent mix.
  if (row.trip_financial_model === undefined && row.trip_commission_wallet_enabled === undefined) {
    return false;
  }
  return classifyTripForPlatformCollectedAdminPage({
    financial_model: row.trip_financial_model,
    commission_wallet_enabled: row.trip_commission_wallet_enabled,
  }).includeOnPlatformPage;
}

/** Effective PLATFORM SA id list for All-Services vs single-SA requests. */
export function resolvePlatformCollectedServiceAreaFilter(args: {
  serviceAreaId?: string | null;
  allowedServiceAreaIds: readonly string[];
}): string[] {
  if (args.serviceAreaId) return [args.serviceAreaId];
  return [...args.allowedServiceAreaIds];
}
