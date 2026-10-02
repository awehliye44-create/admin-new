/**
 * Authoritative WhatsApp booking pickup coverage via resolve-service-area SSOT.
 *
 * Used by create-guest-payment-intent and whatsapp-booking-fares so neither
 * surface can invent coverage or accept a forged service_area_id.
 */

export type PickupCoverageFailureCode =
  | "OUTSIDE_AREA"
  | "SERVICE_AREA_MISMATCH"
  | "COVERAGE_RESOLVE_FAILED";

export type PickupCoverageResult =
  | { ok: true; serviceAreaId: string }
  | { ok: false; error: string; code: PickupCoverageFailureCode; status: number };

export async function assertPickupCoveredByResolveServiceArea(
  supabaseUrl: string,
  invokeHeaders: Record<string, string>,
  input: {
    pickupLat: number;
    pickupLng: number;
    /** When set, must match the resolved service area. */
    serviceAreaId?: string | null;
  },
): Promise<PickupCoverageResult> {
  const res = await fetch(`${supabaseUrl}/functions/v1/resolve-service-area`, {
    method: "POST",
    headers: invokeHeaders,
    body: JSON.stringify({
      pickup_lat: input.pickupLat,
      pickup_lng: input.pickupLng,
    }),
  });
  const body = await res.json().catch(() => ({})) as {
    success?: boolean;
    code?: string;
    error?: string;
    settings?: { service_area_id?: string } | null;
  };

  if (body.code === "OUTSIDE_AREA") {
    return {
      ok: false,
      error: "ONECAB is not currently available in this pickup area",
      code: "OUTSIDE_AREA",
      status: 400,
    };
  }
  if (!res.ok || body.success === false || !body.settings?.service_area_id) {
    return {
      ok: false,
      error: body.error || "Coverage could not be confirmed",
      code: "COVERAGE_RESOLVE_FAILED",
      status: 503,
    };
  }
  if (
    typeof input.serviceAreaId === "string" &&
    input.serviceAreaId.length > 0 &&
    body.settings.service_area_id !== input.serviceAreaId
  ) {
    return {
      ok: false,
      error: "Pickup is not in the selected service area",
      code: "SERVICE_AREA_MISMATCH",
      status: 400,
    };
  }
  return { ok: true, serviceAreaId: body.settings.service_area_id };
}
