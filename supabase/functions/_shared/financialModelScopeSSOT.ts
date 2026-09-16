/**
 * Financial model isolation — admin page scope SSOT (Phase 0c fail-closed reads).
 */
export const FINANCIAL_MODEL = {
  PLATFORM_COLLECTED: 'PLATFORM_COLLECTED',
  DRIVER_COLLECTED_COMMISSION_WALLET: 'DRIVER_COLLECTED_COMMISSION_WALLET',
  UNKNOWN: 'FINANCIAL_MODEL_UNKNOWN',
} as const;

export type FinancialModel = typeof FINANCIAL_MODEL[keyof typeof FINANCIAL_MODEL];

export const FINANCIAL_MODEL_VIOLATION = 'FINANCIAL_MODEL_VIOLATION';

/** Admin page slug → required financial model. */
export const ADMIN_PAGE_FINANCIAL_MODEL: Record<string, Exclude<FinancialModel, 'FINANCIAL_MODEL_UNKNOWN'>> = {
  'payment-sessions': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'financial-reconciliation': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'driver-wallet-ledger': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'payout-ledger': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'commission-wallet': FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
};

/** Resolve trip/row stamp — never default null to PLATFORM_COLLECTED. */
export function resolveFinancialModelStamp(value: unknown): FinancialModel {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === FINANCIAL_MODEL.PLATFORM_COLLECTED) return FINANCIAL_MODEL.PLATFORM_COLLECTED;
  if (raw === FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET) {
    return FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET;
  }
  return FINANCIAL_MODEL.UNKNOWN;
}

/** Service area config — explicit DRIVER_COLLECTED only; null/unknown excluded from both pipelines. */
export function resolveServiceAreaFinancialModel(value: unknown): FinancialModel {
  return resolveFinancialModelStamp(value);
}

/** @deprecated Phase 0c — use resolveServiceAreaFinancialModel (fail-closed). */
export function normaliseServiceAreaFinancialModel(value: unknown): FinancialModel {
  return resolveServiceAreaFinancialModel(value);
}

export function serviceAreaMatchesFinancialModel(
  serviceAreaFinancialModel: unknown,
  requiredModel: Exclude<FinancialModel, 'FINANCIAL_MODEL_UNKNOWN'>,
): boolean {
  return resolveServiceAreaFinancialModel(serviceAreaFinancialModel) === requiredModel;
}

export function filterServiceAreasByFinancialModel<
  T extends { financial_model?: unknown },
>(serviceAreas: readonly T[], requiredModel: Exclude<FinancialModel, 'FINANCIAL_MODEL_UNKNOWN'>): T[] {
  return serviceAreas.filter((sa) => serviceAreaMatchesFinancialModel(sa.financial_model, requiredModel));
}

export function emptyServiceAreaScopeMessage(
  requiredModel: Exclude<FinancialModel, 'FINANCIAL_MODEL_UNKNOWN'>,
): string {
  return requiredModel === FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
    ? 'No Driver-Collected service areas configured'
    : 'No Platform-Collected service areas configured';
}

export type FinancialModelScopeResult =
  | { ok: true; requiredModel: Exclude<FinancialModel, 'FINANCIAL_MODEL_UNKNOWN'>; allowedServiceAreaIds: string[]; serviceAreaId: string | null }
  | { ok: false; code: typeof FINANCIAL_MODEL_VIOLATION; error: string; requiredModel: Exclude<FinancialModel, 'FINANCIAL_MODEL_UNKNOWN'> };

export function resolveFinancialModelScope(
  serviceAreas: readonly { id: string; financial_model?: unknown }[],
  requiredModel: Exclude<FinancialModel, 'FINANCIAL_MODEL_UNKNOWN'>,
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

export function tripRowMatchesFinancialModel(
  tripFinancialModel: unknown,
  requiredModel: Exclude<FinancialModel, 'FINANCIAL_MODEL_UNKNOWN'>,
): boolean {
  return resolveFinancialModelStamp(tripFinancialModel) === requiredModel;
}

export function isDriverCollectedFinancialModel(value: unknown): boolean {
  return resolveFinancialModelStamp(value) === FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET;
}

export function isPlatformCollectedFinancialModel(value: unknown): boolean {
  return resolveFinancialModelStamp(value) === FINANCIAL_MODEL.PLATFORM_COLLECTED;
}

export function isUnknownFinancialModel(value: unknown): boolean {
  return resolveFinancialModelStamp(value) === FINANCIAL_MODEL.UNKNOWN;
}

export type TripPlatformAdminClassification =
  | {
    includeOnPlatformPage: true;
    model: typeof FINANCIAL_MODEL.PLATFORM_COLLECTED;
    bucket: null;
  }
  | {
    includeOnPlatformPage: false;
    model: typeof FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET | typeof FINANCIAL_MODEL.UNKNOWN;
    bucket: null;
  };

/** Fail-closed: null/unknown stamps never enter PLATFORM or CW admin totals. */
export function classifyTripForPlatformCollectedAdminPage(trip: {
  financial_model?: unknown;
  commission_wallet_enabled?: unknown;
}): TripPlatformAdminClassification {
  const model = resolveFinancialModelStamp(trip.financial_model);
  if (model === FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET) {
    return {
      includeOnPlatformPage: false,
      model: FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      bucket: null,
    };
  }
  if (model === FINANCIAL_MODEL.UNKNOWN) {
    return { includeOnPlatformPage: false, model: FINANCIAL_MODEL.UNKNOWN, bucket: null };
  }
  return {
    includeOnPlatformPage: true,
    model: FINANCIAL_MODEL.PLATFORM_COLLECTED,
    bucket: null,
  };
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
  if (row.trip_financial_model === undefined && row.trip_commission_wallet_enabled === undefined) {
    return false;
  }
  return classifyTripForPlatformCollectedAdminPage({
    financial_model: row.trip_financial_model,
    commission_wallet_enabled: row.trip_commission_wallet_enabled,
  }).includeOnPlatformPage;
}

export function resolvePlatformCollectedServiceAreaFilter(args: {
  serviceAreaId?: string | null;
  allowedServiceAreaIds: readonly string[];
}): string[] {
  if (args.serviceAreaId) return [args.serviceAreaId];
  return [...args.allowedServiceAreaIds];
}

/** Admin issue counter bucket for unknown/null financial_model stamps. */
export function countUnknownFinancialModelTrips<
  T extends { financial_model?: unknown },
>(rows: readonly T[]): number {
  return rows.filter((r) => isUnknownFinancialModel(r.financial_model)).length;
}
