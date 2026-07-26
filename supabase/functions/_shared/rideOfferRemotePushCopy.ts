/**
 * Shared ride-offer remote push copy builder (parity with Driver OS hydrate).
 * Driver-net only — never customer gross / client commission.
 */

export type RideOfferPushCopyInput = {
  driverNetPence: number | null;
  currencyCode: string | null | undefined;
  distanceMeters: number | null | undefined;
  etaSeconds: number | null | undefined;
  pickupSummary: string;
  isStacked?: boolean;
  isScheduled?: boolean;
  hasMultipleStops?: boolean;
  paymentMethod?: string | null;
  serviceType?: string | null;
};

export type RideOfferPushCopy = {
  title: string;
  /** Primary line: New ride offer · £X.XX (+ optional flags) */
  headline: string;
  /** Secondary lines: distance · ETA / pickup */
  detail: string;
  /** Full APNs/FCM body (headline + detail) */
  body: string;
  fareText: string;
  distanceText: string | null;
  etaText: string | null;
};

function currencySymbol(code: string): string {
  switch (code) {
    case "GBP":
      return "£";
    case "EUR":
      return "€";
    case "USD":
      return "$";
    default:
      return `${code} `;
  }
}

export function formatDriverNetFareText(
  currencyCode: string | null | undefined,
  netPence: number | null | undefined,
): string {
  const ccy = String(currencyCode ?? "GBP").trim().toUpperCase() || "GBP";
  const sym = currencySymbol(ccy);
  if (netPence == null || !Number.isFinite(netPence) || netPence <= 0) {
    return "—";
  }
  return `${sym}${(Math.round(netPence) / 100).toFixed(2)}`;
}

export function metersToMilesText(meters: number | null | undefined): string | null {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return null;
  const miles = meters / 1609.344;
  const rounded = miles >= 10 ? Math.round(miles) : Math.round(miles * 10) / 10;
  return `${rounded} mi`;
}

export function secondsToMinutesText(
  seconds: number | null | undefined,
): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const mins = Math.max(1, Math.round(seconds / 60));
  return `${mins} min`;
}

function isCardPayment(method: string | null | undefined): boolean {
  const m = String(method ?? "").trim().toLowerCase();
  return m === "card" || m === "stripe" || m.includes("card");
}

/**
 * Authoritative remote push copy — mirrors Driver
 * `rideOfferNotificationCopy` + stacked/scheduled/multi-stop rules.
 */
export function buildRideOfferRemotePushCopy(
  input: RideOfferPushCopyInput,
): RideOfferPushCopy {
  const fareText = formatDriverNetFareText(
    input.currencyCode,
    input.driverNetPence,
  );
  const distanceText = metersToMilesText(input.distanceMeters);
  const etaText = secondsToMinutesText(input.etaSeconds);

  const offerKind = input.isStacked
    ? "New ride after current trip"
    : "New ride offer";

  const flags: string[] = [];
  if (input.isScheduled) flags.push("Scheduled");
  if (input.hasMultipleStops) flags.push("+ multiple stops");
  if (isCardPayment(input.paymentMethod)) flags.push("Card");
  if (input.serviceType && input.serviceType.trim()) {
    flags.push(input.serviceType.trim());
  }

  const headline =
    fareText === "—"
      ? `${offerKind}${flags.length ? ` · ${flags.join(" · ")}` : ""}`
      : `${offerKind} · ${fareText}${
        flags.length ? ` · ${flags.join(" · ")}` : ""
      }`;

  const metaParts: string[] = [];
  if (distanceText && etaText) {
    metaParts.push(`${distanceText} · ${etaText} to pickup`);
  } else if (distanceText) {
    metaParts.push(`${distanceText} to pickup`);
  } else if (etaText) {
    metaParts.push(`${etaText} to pickup`);
  }

  const pickup = (input.pickupSummary || "Tap to view details").trim();
  const detailLines = [...metaParts, pickup].filter(Boolean);
  const detail = detailLines.join("\n");
  const body = detail ? `${headline}\n${detail}` : headline;

  return {
    title: "ONECAB DRIVER",
    headline,
    detail,
    body,
    fareText,
    distanceText,
    etaText,
  };
}
