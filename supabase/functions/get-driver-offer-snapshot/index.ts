import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import {
  extractPresetOptionsFromOffer,
  MIN_PRESET_OPTIONS,
} from "../_shared/presetOptionsCanonical.ts";
import {
  logRequestDuration,
  startRequestTimer,
  withDuration,
  createRequestId,
  finishEdgeRequestLog,
} from "../_shared/edgeRequestTiming.ts";

const RATE_LIMIT_CONFIG = {
  limit: 120,
  windowMs: 60_000,
  keyPrefix: "get-driver-offer-snapshot",
};

const MIN_PRESET_CHIPS = MIN_PRESET_OPTIONS;

type OfferRow = Record<string, unknown>;
type TripRow = Record<string, unknown>;

function readDriverNetFromPresetOptions(snapshot: Record<string, unknown>): number {
  const presets = snapshot.preset_options;
  if (!Array.isArray(presets) || presets.length === 0) return 0;

  const ordered = [...presets].sort((a, b) => {
    const ao = Number((a as { order?: number })?.order ?? 0);
    const bo = Number((b as { order?: number })?.order ?? 0);
    return ao - bo;
  });
  const recommended = ordered.find(
    (item) =>
      item
      && typeof item === "object"
      && String((item as Record<string, unknown>).key ?? "").toLowerCase() === "recommended",
  );

  for (const item of [recommended, ...ordered]) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    for (const key of [
      "driver_net_pence",
      "driver_net_fare_pence",
      "driver_net_preview_pence",
      "driverNetPence",
      "driverNetFarePence",
    ]) {
      const v = Number(row[key]);
      if (Number.isFinite(v) && v > 0) return Math.round(v);
    }
  }
  return 0;
}

function readDriverNetPence(offer: OfferRow): number {
  const snap = offer.offer_snapshot;
  if (snap && typeof snap === "object") {
    const s = snap as Record<string, unknown>;
    for (const key of [
      "driver_net_fare_pence",
      "driver_net_pence",
      "driver_net_preview_pence",
      "driver_earnings_pence",
      "driverNetFarePence",
      "driverNetPreviewPence",
      "driverEarningsPence",
    ]) {
      const v = Number(s[key]);
      if (Number.isFinite(v) && v > 0) return Math.round(v);
    }
    const fromPresets = readDriverNetFromPresetOptions(s);
    if (fromPresets > 0) return fromPresets;
  }
  const direct = Number(offer.driver_net_pence ?? offer.driver_net_earnings_pence);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
  return 0;
}

function hasAddress(value: unknown): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  return !["pickup", "dropoff", "drop-off", "tap to view details", "—", "-", "n/a"].includes(lower);
}

function offerNeedsPresetChips(offer: OfferRow): boolean {
  if (offer.is_stacked === true) return false;
  if (offer.delivery_phase === "scan_and_go") return false;
  const snap = offer.offer_snapshot;
  if (snap && typeof snap === "object" && (snap as Record<string, unknown>).scan_and_go === true) {
    return false;
  }
  if (offer.offer_type === "scan_and_go") return false;
  const ns = String(offer.negotiation_status ?? "").toLowerCase();
  if (ns && ns !== "sent_to_driver") return false;
  return true;
}

function evaluateSnapshotComplete(offer: OfferRow, trip: TripRow | null): boolean {
  if (!offer.id || !trip?.id) return false;
  if (readDriverNetPence(offer) <= 0) return false;
  if (!hasAddress(trip.pickup_address)) return false;
  if (!hasAddress(trip.dropoff_address)) return false;
  const expiresAt = String(offer.expires_at ?? "");
  if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) return false;
  if (offerNeedsPresetChips(offer)) {
    const presets = extractPresetOptionsFromOffer({
      offer_snapshot: offer.offer_snapshot,
      offer_options: offer.offer_options as number[] | null | undefined,
    });
    if (presets.length < MIN_PRESET_CHIPS) return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  if (req.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405);
  }

  const requestId = createRequestId();
  const elapsed = startRequestTimer();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("UNAUTHORIZED", "Missing authorization header", 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(supabaseUrl, serviceKey);

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return errorResponse("UNAUTHORIZED", "Invalid session", 401);
    }

    let body: { offer_id?: string };
    try {
      body = await req.json();
    } catch {
      return validationErrorResponse("Invalid JSON body");
    }

    const offerId = String(body.offer_id ?? "").trim();
    if (!isValidUUID(offerId)) {
      return validationErrorResponse("offer_id must be a valid UUID");
    }

    const { data: driverRow } = await userClient
      .from("drivers")
      .select("id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    const driverId = typeof driverRow?.id === "string" ? driverRow.id : null;
    if (!driverId) {
      return errorResponse("FORBIDDEN", "Driver profile not found", 403);
    }

    const loadOffer = async (): Promise<{ offer: OfferRow | null; trip: TripRow | null }> => {
      const { data, error } = await userClient
        .from("ride_offers")
        .select("*, trips(*)")
        .eq("id", offerId)
        .eq("driver_id", driverId)
        .maybeSingle();

      if (error || !data) {
        return { offer: null, trip: null };
      }

      const offer = data as OfferRow;
      const embedded = offer.trips;
      const trip = (Array.isArray(embedded) ? embedded[0] : embedded) as TripRow | null;
      return { offer, trip };
    };

    let { offer, trip } = await loadOffer();
    if (!offer) {
      return successResponse(withDuration({
        success: false,
        error: "OFFER_NOT_FOUND",
        message: "Offer not found for this driver",
        offer_id: offerId,
      }, elapsed(), { source: "get-driver-offer-snapshot", requestId }));
    }

    const tripId = String(offer.trip_id ?? trip?.id ?? "");
    if (offerNeedsPresetChips(offer) && tripId) {
      const presetCount = extractPresetOptionsFromOffer({
        offer_snapshot: offer.offer_snapshot,
        offer_options: offer.offer_options as number[] | null | undefined,
      }).length;
      if (presetCount < MIN_PRESET_CHIPS) {
        const { data: enrichResult, error: enrichErr } = await serviceClient.rpc(
          "enrich_ride_offer_presets",
          { p_trip_id: tripId },
        );
        if (enrichErr) {
          console.warn("[get-driver-offer-snapshot] enrich_ride_offer_presets failed:", enrichErr.message);
        } else {
          console.log("[get-driver-offer-snapshot] enrich_ride_offer_presets", enrichResult);
          ({ offer, trip } = await loadOffer());
        }
      }
    }

    const { data: validation, error: validationErr } = await userClient.rpc(
      "validate_driver_offer",
      { p_offer_id: offerId, p_driver_id: driverId },
    );

    const validationPayload = validation && typeof validation === "object"
      ? validation as Record<string, unknown>
      : null;

    const snapshotComplete = evaluateSnapshotComplete(offer, trip);
    const presetOptions = extractPresetOptionsFromOffer({
      offer_snapshot: offer.offer_snapshot,
      offer_options: offer.offer_options as number[] | null | undefined,
    });

    const duration_ms = elapsed();
    logRequestDuration("get-driver-offer-snapshot", duration_ms, {
      request_id: requestId,
      offer_id: offerId,
      trip_id: tripId || null,
      snapshot_complete: snapshotComplete,
      preset_count: presetOptions.length,
    });
    finishEdgeRequestLog("get-driver-offer-snapshot", duration_ms, {
      request_id: requestId,
      offer_id: offerId,
      trip_id: tripId || null,
      snapshot_complete: snapshotComplete,
    });

    return successResponse(withDuration({
      success: true,
      offer_id: offerId,
      trip_id: tripId || null,
      driver_id: driverId,
      offer,
      trip,
      preset_options: presetOptions,
      driver_net_pence: readDriverNetPence(offer),
      payment_method: trip?.payment_method ?? null,
      snapshot_complete: snapshotComplete,
      needs_preset_chips: offerNeedsPresetChips(offer),
      validation: validationPayload ?? { valid: !validationErr, rpc_error: validationErr?.message ?? null },
    }, duration_ms, { source: "get-driver-offer-snapshot", requestId }));
  } catch (error) {
    console.error("[get-driver-offer-snapshot] Error:", error);
    return errorResponse("INTERNAL_ERROR", String(error), 500);
  }
});
