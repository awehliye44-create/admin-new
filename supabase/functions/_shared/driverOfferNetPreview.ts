/**
 * Server-side driver net preview for ride offers (not settlement).
 * Commission SSOT: base service-area/global dispatch commission − wave reduction (monotonic floor).
 */
import {
  buildAirportRouteExtraItems,
  driverNetFromCustomerTotal,
  resolveQuoteAirportChargePence,
} from "./airportChargeFareSplitSSOT.ts";

export function computeDriverNetPreviewPence(
  grossFarePence: number,
  commissionPercent: number,
  airportChargePence = 0,
): number {
  if (grossFarePence <= 0) return 0;
  return driverNetFromCustomerTotal({
    customerPence: grossFarePence,
    airportPence: airportChargePence,
    commissionPercent,
  }).driverNetPence;
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

  // Prefer an explicit airport already on the snapshot (trip/quote overlay).
  // Missing amount → unknown (never silently 0). Authoritative 0 stays zero.
  const explicitAirportRaw = base.airport_charge_pence ?? base.airportChargePence;
  const explicitAirportNum = Number(explicitAirportRaw);
  const hasExplicitAirport = explicitAirportRaw != null &&
    explicitAirportRaw !== "" &&
    Number.isFinite(explicitAirportNum);
  const resolvedAirport = resolveQuoteAirportChargePence(base);
  const airportState: "present" | "zero" | "unknown" = hasExplicitAirport
    ? (explicitAirportNum > 0 ? "present" : "zero")
    : (resolvedAirport > 0 ? "present" : "unknown");
  const airportPence = airportState === "present"
    ? Math.max(0, Math.round(hasExplicitAirport ? explicitAirportNum : resolvedAirport))
    : 0;

  const otherPassThroughPence = Math.max(
    0,
    Math.round(Number(base.other_pass_through_charges_pence ?? base.otherPassThroughChargesPence ?? 0) || 0),
  );
  const extras = buildAirportRouteExtraItems(airportPence);
  if (airportState === "present" && extras.length > 0) {
    base.airport_charge_pence = airportPence;
    base.airport_charge_state = "present";
    if (!Array.isArray(base.route_extra_items)) base.route_extra_items = extras;
  } else if (airportState === "zero") {
    base.airport_charge_pence = 0;
    base.airport_charge_state = "zero";
  } else {
    // unknown: omit amount so clients cannot treat absence as £0
    delete base.airport_charge_pence;
    delete base.airportChargePence;
    base.airport_charge_state = "unknown";
  }

  const split = driverNetFromCustomerTotal({
    customerPence: baseFarePence,
    airportPence,
    otherPassThroughPence,
    commissionPercent: commissionPct,
  });
  const driverNet = split.driverNetPence;
  const journeyNet = Math.max(0, split.commissionablePence - split.commissionPence);

  // Canonical ONECAB offer fare SSOT (backend-resolved; client must not guess).
  base.driver_net_fare_pence = driverNet;
  base.platform_commission_pence = split.commissionPence;
  base.final_trip_fare_pence = baseFarePence;
  // Legacy aliases — keep until all clients migrate.
  base.driver_net_preview_pence = driverNet;
  base.driver_earnings_pence = driverNet;
  base.commission_percent = commissionPct;
  base.effective_commission_percent = commissionPct;
  // Journey net excludes airport; total driver_net_* includes it (MK-261113-007).
  if (airportState === "present") {
    base.driver_journey_net_pence = journeyNet;
  } else if (airportState === "zero") {
    base.driver_journey_net_pence = journeyNet;
  }
  // unknown: do not invent a journey split that pretends airport is known.

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
      const presetSplit = driverNetFromCustomerTotal({
        customerPence: Math.round(gross),
        airportPence,
        otherPassThroughPence,
        commissionPercent: commissionPct,
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
