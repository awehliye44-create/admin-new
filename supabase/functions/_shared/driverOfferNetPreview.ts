/**
 * Server-side driver net preview for ride offers (not settlement).
 */
import { calculateCommissionSplit } from "./commission.ts";
import { extractDriverTierName } from "./dispatch-settings.ts";

export type TierCommissionMap = Map<string, number>;

export async function loadServiceAreaTierCommissionMap(
  supabase: { from: (table: string) => unknown },
  serviceAreaId: string | null | undefined,
): Promise<TierCommissionMap> {
  const map = new Map<string, number>();
  if (!serviceAreaId) return map;

  const { data, error } = await (supabase as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (a: string, b: string) => { eq: (a: string, b: boolean) => Promise<{ data: unknown; error: { message: string } | null }> };
      };
    };
  })
    .from("service_area_driver_tiers")
    .select("tier_name, commission_percent")
    .eq("service_area_id", serviceAreaId)
    .eq("is_active", true);

  if (error) {
    console.warn("[driverOfferNetPreview] loadServiceAreaTierCommissionMap failed:", error.message);
    return map;
  }

  for (const row of (data as { tier_name?: string; commission_percent?: number }[]) ?? []) {
    const name = String(row.tier_name ?? "").trim().toLowerCase();
    const pct = Number(row.commission_percent);
    if (name && Number.isFinite(pct)) map.set(name, pct);
  }
  return map;
}

export function resolveTierCommissionPercent(
  tierName: string,
  commissionMap: TierCommissionMap,
): number | null {
  const key = tierName.trim().toLowerCase();
  if (commissionMap.has(key)) return commissionMap.get(key)!;
  if (commissionMap.has("bronze")) return commissionMap.get("bronze")!;
  return null;
}

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
  driver: { driver_categories?: { name?: string } | { name?: string }[] | null },
  commissionMap: TierCommissionMap,
  baseFarePence: number,
  currencyCode?: string | null,
): Record<string, unknown> {
  const base = snapshot ? { ...snapshot } : {};
  const tierName = extractDriverTierName(driver);
  const commissionPct = resolveTierCommissionPercent(tierName, commissionMap);
  if (commissionPct == null || baseFarePence <= 0) return base;

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
  // Legacy aliases â keep until all clients migrate.
  base.driver_net_preview_pence = driverNet;
  base.driver_earnings_pence = driverNet;
  base.commission_percent = commissionPct;

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
