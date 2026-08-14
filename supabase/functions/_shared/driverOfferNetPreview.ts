/**
 * Server-side driver net preview for ride offers (not settlement).
 * Commission SSOT: base service-area/global dispatch commission − wave reduction (monotonic floor).
 */
import { calculateCommissionSplit } from "./commission.ts";

export function computeDriverNetPreviewPence(
  grossFarePence: number,
  commissionPercent: number,
  airportChargePence = 0,
): number {
  if (grossFarePence <= 0) return 0;
  const split = calculateCommissionSplit(grossFarePence, commissionPercent, {
    airport_charge_pence: airportChargePence,
  });
  return split.driverNetPence;
}

export function enrichOfferSnapshotDriverNet(
  snapshot: Record<string, unknown> | null,
  _driver: { driver_categories?: { name?: string } | { name?: string }[] | null },
  commissionPercent: number,
  baseFarePence: number,
  currencyCode?: string | null,
): Record<string, unknown> {
  const base = snapshot ? { ...snapshot } : {};
  const commissionPct = Number(commissionPercent);
  if (!Number.isFinite(commissionPct) || commissionPct < 0 || baseFarePence <= 0) return base;

  const airportPence = Number(
    base.airport_charge_pence ?? base.airportChargePence ?? 0,
  ) || 0;

  const split = calculateCommissionSplit(baseFarePence, commissionPct, {
    airport_charge_pence: airportPence,
  });
  const driverNet = split.driverNetPence;

  // Canonical ONECAB offer fare SSOT (backend-resolved; client must not guess).
  base.driver_net_fare_pence = driverNet;
  base.platform_commission_pence = split.commissionPence;
  base.final_trip_fare_pence = baseFarePence;
  // Legacy aliases — keep until all clients migrate.
  base.driver_net_preview_pence = driverNet;
  base.driver_earnings_pence = driverNet;
  base.commission_percent = commissionPct;
  base.effective_commission_percent = commissionPct;

  const currency =
    (typeof currencyCode === "string" && currencyCode.trim())
    || (typeof base.currency === "string" && base.currency.trim())
    || (typeof base.currency_code === "string" && base.currency_code.trim())
    || null;
  if (currency) {
    base.currency = currency;
    base.currency_code = currency;
  }

  const presets = base.preset_options;
  if (Array.isArray(presets)) {
    base.preset_options = presets.map((item) => {
      if (!item || typeof item !== "object") return item;
      const row = item as Record<string, unknown>;
      const gross = Number(row.grossFarePence ?? row.gross_fare_pence ?? 0);
      if (!Number.isFinite(gross) || gross <= 0) return item;
      const presetSplit = calculateCommissionSplit(Math.round(gross), commissionPct, {
        airport_charge_pence: airportPence,
      });
      const net = presetSplit.driverNetPence;
      return {
        ...row,
        driverNetPence: net,
        driver_net_pence: net,
        driver_net_fare_pence: net,
        platform_commission_pence: presetSplit.commissionPence,
        final_trip_fare_pence: Math.round(gross),
      };
    });
  }

  return base;
}

/** Read canonical driver net from offer snapshot (server SSOT). */
export function readOfferDriverNetFarePence(
  snapshot: Record<string, unknown> | null | undefined,
): number {
  if (!snapshot) return 0;
  const canonical = Number(snapshot.driver_net_fare_pence ?? 0);
  if (Number.isFinite(canonical) && canonical > 0) return Math.round(canonical);
  const legacy = Number(snapshot.driver_net_preview_pence ?? snapshot.driver_earnings_pence ?? 0);
  return Number.isFinite(legacy) && legacy > 0 ? Math.round(legacy) : 0;
}
