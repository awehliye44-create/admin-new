/** Offline test/audit-only helpers; not part of Edge uploads. */
import { FinancialModel, FINANCIAL_MODEL, classifyTripForPlatformCollectedAdminPage, isDriverCollectedFinancialModel, isUnknownFinancialModel } from "../../../functions/_shared/financialModelScopeSSOT.ts";


/** Admin page slug → required financial model. */
export const ADMIN_PAGE_FINANCIAL_MODEL: Record<string, Exclude<FinancialModel, 'FINANCIAL_MODEL_UNKNOWN'>> = {
  'payment-sessions': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'financial-reconciliation': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'driver-wallet-ledger': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'payout-ledger': FINANCIAL_MODEL.PLATFORM_COLLECTED,
  'commission-wallet': FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
};


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


/** Admin issue counter bucket for unknown/null financial_model stamps. */
export function countUnknownFinancialModelTrips<
  T extends { financial_model?: unknown },
>(rows: readonly T[]): number {
  return rows.filter((r) => isUnknownFinancialModel(r.financial_model)).length;
}

export * from "../../../functions/_shared/financialModelScopeSSOT.ts";
export * from "../../../../shared/edgePresentation/financialModelScopeSSOT.ts";
