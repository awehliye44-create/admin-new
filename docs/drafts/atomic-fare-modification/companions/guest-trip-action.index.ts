/**
 * Thin WhatsApp tracking-token wrapper.
 *
 * Validates the signed trip token, then calls the existing customer functions:
 * request-trip-modification, confirm-trip-modification-payment, cancel-trip.
 * Does not price, decide fees, or write trip rows itself.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import {
  buildWhatsAppContinuationSigningMaterial,
  verifyWhatsAppContinuationToken,
} from "../_shared/whatsappContinuationToken.ts";
import { phonesExactlyMatch } from "../_shared/whatsappGuestBookingSSOT.ts";
import { invokeAsTripPassenger } from "../_shared/whatsappPassengerInvoke.ts";

const TERMINAL = new Set([
  "completed",
  "cancelled",
  "canceled",
  "expired",
  "expired_no_driver",
  "no_drivers",
  "no_show",
]);

/** Exact status list from request-trip-modification. */
const MODIFIABLE = new Set([
  "accepted",
  "confirmed",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "in_progress",
  "started",
  "ongoing",
  "at_stop",
  "driving_to_next_stop",
]);

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const token = typeof body.tracking_token === "string" ? body.tracking_token : "";
  const action = typeof body.action === "string" ? body.action : "";
  const confirm = body.confirm === true;
  if (!token || !action) return json({ error: "tracking_token and action are required" }, 400);

  const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "";
  if (!verifyToken || !phoneNumberId) return json({ error: "Tracking unavailable" }, 503);

  const signing = buildWhatsAppContinuationSigningMaterial({ verifyToken, phoneNumberId });
  let claims = await verifyWhatsAppContinuationToken(token, signing);
  if (!claims) {
    const stale = await verifyWhatsAppContinuationToken(token, signing, undefined, { allowExpired: true });
    if (stale?.purpose === "book") claims = stale;
  }
  if (!claims?.tripId && claims?.purpose !== "book") {
    return json({ error: "Invalid or expired tracking link" }, 401);
  }
  if (!claims) return json({ error: "Invalid or expired tracking link" }, 401);

  const tripId = claims.tripId || "";
  let trip: Record<string, unknown> | null = null;
  if (tripId) {
    const { data } = await supabase
      .from("trips")
      .select("id, status, passenger_id, payment_session_id, booking_source")
      .eq("id", tripId)
      .maybeSingle();
    trip = data as Record<string, unknown> | null;
  } else {
    const { data: sessions } = await supabase
      .from("payment_sessions")
      .select("id, trip_id, booking_snapshot")
      .contains("booking_snapshot", { continuation_token: token })
      .limit(3);
    const owned = (sessions ?? []).find((row: { booking_snapshot: unknown }) => {
      const snap = asRecord(row.booking_snapshot);
      return phonesExactlyMatch(typeof snap.wa_id === "string" ? snap.wa_id : "", claims!.waId)
        && String(snap.booking_source ?? "") === "whatsapp_booking";
    });
    if (owned?.trip_id) {
      const { data } = await supabase
        .from("trips")
        .select("id, status, passenger_id, payment_session_id, booking_source")
        .eq("id", owned.trip_id)
        .maybeSingle();
      trip = data as Record<string, unknown> | null;
    }
  }
  if (!trip?.id || typeof trip.passenger_id !== "string") {
    return json({ error: "No live booking found for this link" }, 404);
  }

  const sessionId = typeof trip.payment_session_id === "string" ? trip.payment_session_id : "";
  const { data: session } = sessionId
    ? await supabase.from("payment_sessions").select("booking_snapshot, trip_id").eq("id", sessionId).maybeSingle()
    : { data: null };
  const snap = asRecord(session?.booking_snapshot);
  if (!phonesExactlyMatch(typeof snap.wa_id === "string" ? snap.wa_id : "", claims.waId)) {
    return json({ error: "Not authorised for this trip" }, 403);
  }
  if (session?.trip_id && session.trip_id !== trip.id) {
    return json({ error: "Not authorised for this trip" }, 403);
  }

  const status = String(trip.status ?? "").toLowerCase();
  if (TERMINAL.has(status)) {
    return json({ error: "This trip can no longer be changed.", code: "terminal" }, 400);
  }

  if (action === "edit_stop") {
    return json({
      error: "Editing an existing stop is not supported in one request. Remove it and add a new stop instead.",
      code: "unsupported",
    }, 400);
  }

  if (action === "cancel_trip") {
    const reason = typeof body.reasonCode === "string" ? body.reasonCode : undefined;
    const result = await invokeAsTripPassenger(supabase, trip.passenger_id, "cancel-trip", {
      trip_id: trip.id,
      tripId: trip.id,
      cancelled_by: "rider",
      ...(reason ? { reason } : {}),
    });
    return json({
      ...result.json,
      error: typeof result.json.error === "string" ? result.json.error : result.status >= 400 ? "That change could not be applied" : undefined,
    }, result.status);
  }

  if (!MODIFIABLE.has(status)) {
    return json({
      error: "Trip cannot be modified",
      reason: `Current status '${status}' does not allow modifications`,
    }, 400);
  }

  const address = typeof body.address === "string" ? body.address.trim() : "";
  const lat = typeof body.lat === "number" ? body.lat : Number(body.lat);
  const lng = typeof body.lng === "number" ? body.lng : Number(body.lng);
  let modification: Record<string, unknown> | null = null;

  if (action === "add_stop" || action === "change_destination") {
    if (!address || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json({ error: "Choose an address from the suggestions." }, 400);
    }
    modification = action === "add_stop"
      ? { tripId: trip.id, changeType: "add_stop", newStops: [{ address, lat, lng, type: "stop" }], previewOnly: !confirm }
      : { tripId: trip.id, changeType: "change_dropoff", newDropoff: { address, lat, lng }, previewOnly: !confirm };
  } else if (action === "remove_stop") {
    const stopId = typeof body.stopId === "string" ? body.stopId : "";
    const { data: stop } = await supabase
      .from("trip_stops")
      .select("stop_index, type, trip_id")
      .eq("id", stopId)
      .maybeSingle();
    if (!stop || stop.trip_id !== trip.id || stop.type !== "stop" || stop.stop_index == null) {
      return json({ error: "Stop not found" }, 400);
    }
    modification = {
      tripId: trip.id,
      changeType: "remove_stop",
      stopIndexToRemove: stop.stop_index,
      previewOnly: !confirm,
    };
  } else {
    return json({ error: "Unsupported action" }, 400);
  }

  const quoted = await invokeAsTripPassenger(
    supabase,
    trip.passenger_id,
    "request-trip-modification",
    modification,
  );
  if (quoted.status === 409 && confirm) {
    const existingId = typeof quoted.json.existingRequestId === "string" ? quoted.json.existingRequestId : "";
    const existingStatus = String(quoted.json.existingStatus ?? "");
    if (existingId && (existingStatus === "payment_required" || existingStatus === "payment_pending")) {
      const paid = await invokeAsTripPassenger(
        supabase,
        trip.passenger_id,
        "confirm-trip-modification-payment",
        { requestId: existingId },
      );
      const paymentProcessing = paid.json.paymentProcessing === true
        || paid.json.status === "payment_pending"
        || paid.status === 202;
      return json({
        ...paid.json,
        paymentProcessing,
        tripUnchanged: paymentProcessing || paid.json.tripUnchanged === true,
        error: paymentProcessing
          ? "Payment is still processing. Your trip has not been changed."
          : paid.status >= 400
          ? (typeof paid.json.error === "string" ? paid.json.error : "Payment could not be updated")
          : undefined,
      }, paymentProcessing ? 202 : paid.status);
    }
  }

  if (quoted.status >= 400 || !confirm) {
    const fareDeltaPence = typeof quoted.json.fareDeltaPence === "number" ? quoted.json.fareDeltaPence : null;
    const newFarePence = typeof quoted.json.newCustomerTotalPence === "number"
      ? quoted.json.newCustomerTotalPence
      : typeof quoted.json.newFarePence === "number"
      ? quoted.json.newFarePence
      : null;
    const backendPreview = quoted.json.preview && typeof quoted.json.preview === "object"
      ? quoted.json.preview as Record<string, unknown>
      : null;
    const currencyCode = typeof backendPreview?.currency === "string" ? backendPreview.currency : "GBP";
    const symbol = typeof backendPreview?.currencySymbol === "string" ? backendPreview.currencySymbol : "";
    const money = (pence: number) =>
      symbol ? `${symbol}${(pence / 100).toFixed(2)}` : `${pence} pence`;
    return json({
      ...quoted.json,
      preview: quoted.status < 400
        ? {
          currentPence: newFarePence,
          currencyCode,
          fareDeltaPence,
          summary: fareDeltaPence == null
            ? "ONECAB has checked this change."
            : fareDeltaPence === 0
            ? "No fare change."
            : fareDeltaPence > 0
            ? `Fare increases by ${money(fareDeltaPence)}. New total ${money(newFarePence ?? 0)}.`
            : `Fare decreases by ${money(Math.abs(fareDeltaPence))}. New total ${money(newFarePence ?? 0)}.`,
        }
        : undefined,
      error: typeof quoted.json.error === "string"
        ? quoted.json.error
        : quoted.status >= 400
        ? "That change could not be applied"
        : undefined,
    }, quoted.status);
  }

  const requestId = typeof quoted.json.requestId === "string" ? quoted.json.requestId : "";
  const needsPayment = quoted.json.paymentRequired === true
    || quoted.json.status === "payment_required"
    || quoted.json.status === "payment_pending";
  if (needsPayment && requestId) {
    const paid = await invokeAsTripPassenger(
      supabase,
      trip.passenger_id,
      "confirm-trip-modification-payment",
      { requestId },
    );
    const paymentProcessing = paid.json.paymentProcessing === true
      || paid.json.status === "payment_pending"
      || paid.json.paymentPhase === "PAYMENT_PENDING";
    const failed = paid.status >= 400 && !paymentProcessing && paid.status !== 202;
    return json({
      ...quoted.json,
      ...paid.json,
      paymentProcessing,
      // While increment is processing/pending, destination and fare stay unchanged.
      tripUnchanged: paymentProcessing || paid.json.tripUnchanged === true,
      error: failed
        ? (typeof paid.json.error === "string" ? paid.json.error : "Payment could not be updated")
        : paymentProcessing
        ? "Payment is still processing. Your trip has not been changed."
        : undefined,
    }, paymentProcessing ? 202 : paid.status);
  }

  return json(quoted.json, quoted.status);
});
