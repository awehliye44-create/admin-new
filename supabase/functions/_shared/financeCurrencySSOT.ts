/**
 * Finance currency SSOT — symbols and minor units.
 * Keep in sync with admin-new/src/lib/formatMoneyMinor.ts
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
  GHS: "GH₵",
  KES: "KSh",
  UGX: "USh",
  ETB: "Br",
  SOS: "S",
  TZS: "TSh",
  ZAR: "R",
  NGN: "₦",
  EGP: "E£",
  MAD: "DH",
  AED: "د.إ",
  SAR: "﷼",
  INR: "₹",
  JPY: "¥",
  CNY: "¥",
  KRW: "₩",
  CHF: "CHF",
  CAD: "C$",
  AUD: "A$",
};

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "MGA", "PYG",
  "RWF", "SOS", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

export function getCurrencyMinorUnit(currencyCode: string | null | undefined): number {
  const code = String(currencyCode ?? "").toUpperCase();
  if (!code) return 2;
  return ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
}

export function getCurrencySymbolFromCode(currencyCode: string | null | undefined): string {
  const code = String(currencyCode ?? "").toUpperCase();
  if (!code) return "";
  return CURRENCY_SYMBOLS[code] ?? code;
}

export type FinanceCurrencyMeta = {
  currency_code: string;
  currency_symbol: string;
  currency_minor_unit: number;
  region_id: string | null;
  service_area_id: string | null;
  is_mixed_currency_scope: boolean;
};

export type FinanceCurrencyGroupTotals = {
  currency_code: string;
  currency_symbol: string;
  currency_minor_unit: number;
  customer_revenue_pence: number;
  driver_net_pence: number;
  commission_pence: number;
  trip_count: number;
};

type SupabaseClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => { maybeSingle: () => Promise<{ data: { currency_code?: string } | null }> };
      in: (col: string, vals: string[]) => Promise<{ data: Array<{ id: string; currency_code: string }> | null }>;
    };
  };
};

export async function resolveFinanceCurrencyScope(
  supabase: SupabaseClient,
  args: {
    resolvedRegionId: string | null;
    serviceAreaId: string | null;
    regionIdsFromDrivers: string[];
  },
): Promise<{
  meta: FinanceCurrencyMeta;
  currencyGroups: FinanceCurrencyGroupTotals[] | null;
}> {
  const { resolvedRegionId, serviceAreaId, regionIdsFromDrivers } = args;

  async function metaForRegion(
    regionId: string,
    saId: string | null,
  ): Promise<FinanceCurrencyMeta> {
    const { data: region } = await supabase
      .from("regions")
      .select("currency_code")
      .eq("id", regionId)
      .maybeSingle();
    const code = String(region?.currency_code ?? "GBP").toUpperCase();
    return {
      currency_code: code,
      currency_symbol: getCurrencySymbolFromCode(code),
      currency_minor_unit: getCurrencyMinorUnit(code),
      region_id: regionId,
      service_area_id: saId,
      is_mixed_currency_scope: false,
    };
  }

  if (resolvedRegionId) {
    return {
      meta: await metaForRegion(resolvedRegionId, serviceAreaId),
      currencyGroups: null,
    };
  }

  const uniqueRegionIds = [...new Set(regionIdsFromDrivers.filter(Boolean))];
  if (uniqueRegionIds.length === 0) {
    const code = "GBP";
    return {
      meta: {
        currency_code: code,
        currency_symbol: getCurrencySymbolFromCode(code),
        currency_minor_unit: getCurrencyMinorUnit(code),
        region_id: null,
        service_area_id: null,
        is_mixed_currency_scope: false,
      },
      currencyGroups: null,
    };
  }

  const { data: regions } = await supabase
    .from("regions")
    .select("id, currency_code")
    .in("id", uniqueRegionIds);

  const currencies = [...new Set((regions ?? []).map((r) => String(r.currency_code).toUpperCase()))];

  if (currencies.length <= 1) {
    const code = currencies[0] ?? "GBP";
    return {
      meta: {
        currency_code: code,
        currency_symbol: getCurrencySymbolFromCode(code),
        currency_minor_unit: getCurrencyMinorUnit(code),
        region_id: null,
        service_area_id: null,
        is_mixed_currency_scope: false,
      },
      currencyGroups: null,
    };
  }

  const primary = currencies[0] ?? "GBP";
  return {
    meta: {
      currency_code: primary,
      currency_symbol: getCurrencySymbolFromCode(primary),
      currency_minor_unit: getCurrencyMinorUnit(primary),
      region_id: null,
      service_area_id: null,
      is_mixed_currency_scope: true,
    },
    currencyGroups: currencies.map((code) => ({
      currency_code: code,
      currency_symbol: getCurrencySymbolFromCode(code),
      currency_minor_unit: getCurrencyMinorUnit(code),
      customer_revenue_pence: 0,
      driver_net_pence: 0,
      commission_pence: 0,
      trip_count: 0,
    })),
  };
}

export function buildCurrencyGroupsFromTrips(
  tripRows: Array<{
    service_area_id?: string | null;
    commission_pence?: number | null;
    driver_net_pence?: number | null;
    final_fare_pence?: number | null;
    capture_amount_pence?: number | null;
  }>,
  serviceAreaCurrency: Map<string, string>,
): FinanceCurrencyGroupTotals[] {
  const buckets = new Map<string, FinanceCurrencyGroupTotals>();

  for (const trip of tripRows) {
    const saId = trip.service_area_id ? String(trip.service_area_id) : "";
    const code = (saId ? serviceAreaCurrency.get(saId) : null) ?? "GBP";
    const existing = buckets.get(code) ?? {
      currency_code: code,
      currency_symbol: getCurrencySymbolFromCode(code),
      currency_minor_unit: getCurrencyMinorUnit(code),
      customer_revenue_pence: 0,
      driver_net_pence: 0,
      commission_pence: 0,
      trip_count: 0,
    };
    existing.customer_revenue_pence += Math.max(
      0,
      Number(trip.final_fare_pence ?? trip.capture_amount_pence ?? 0),
    );
    existing.driver_net_pence += Math.max(0, Number(trip.driver_net_pence ?? 0));
    existing.commission_pence += Math.max(0, Number(trip.commission_pence ?? 0));
    existing.trip_count += 1;
    buckets.set(code, existing);
  }

  return [...buckets.values()].sort((a, b) => a.currency_code.localeCompare(b.currency_code));
}
