/**
 * Driver net earnings display for ride-offer push copy.
 */
import { getCurrencySymbol } from "./currency.ts";

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

/** Driver net pence from offer snapshot or trip row â never customer gross. */
export function driverNetPenceFromOfferContext(args: {
  offerSnapshot?: Record<string, unknown> | null;
  trip?: Record<string, unknown> | null;
}): number | null {
  const snap = args.offerSnapshot ?? null;
  const trip = args.trip ?? null;
  const fromSnap =
    num(snap?.driver_net_preview_pence)
    ?? num(snap?.driverNetPreviewPence)
    ?? num(snap?.driver_earnings_pence)
    ?? num(snap?.driverEarningsPence)
    ?? num(snap?.driver_net_pence)
    ?? num(snap?.driverNetPence);
  if (fromSnap != null && fromSnap > 0) return Math.round(fromSnap);
  const fromTrip =
    num(trip?.driver_net_preview_pence)
    ?? num(trip?.driver_net_pence);
  if (fromTrip != null && fromTrip > 0) return Math.round(fromTrip);
  return null;
}

export function driverNetDisplayForRideOfferPush(
  currencyCode: string | null | undefined,
  netPence: number | null,
): string {
  const ccy = String(currencyCode ?? "").trim().toUpperCase();
  if (!ccy) return "\u2014";
  const sym = getCurrencySymbol(ccy) || `${ccy} `;
  if (netPence == null || !Number.isFinite(netPence) || netPence <= 0) return "\u2014";
  const major = Number((netPence / 100).toFixed(2));
  return `${sym}${major.toFixed(2)}`;
}

export function rideOfferPushBodyDriverNet(
  currencyCode: string | null | undefined,
  netPence: number | null,
): string {
  const disp = driverNetDisplayForRideOfferPush(currencyCode, netPence);
  if (disp === "\u2014") return "New trip â tap to view offer details.";
  return `New trip â you earn ${disp}.`;
}
