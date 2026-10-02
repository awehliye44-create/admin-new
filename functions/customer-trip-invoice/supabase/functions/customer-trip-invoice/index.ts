import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  validationErrorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import { handleTripInvoiceAction } from "../_shared/tripInvoiceService.ts";
import { isTripReadyForInvoice } from "../_shared/tripInvoiceData.ts";

interface CustomerTripInvoiceRequest {
  trip_id?: string;
  action?: "download" | "view";
}

Deno.serve(async (req) => {
  const preflight = handleCORSPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Unauthorized", 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) {
      return errorResponse("Unauthorized", 401);
    }

    const body = (await req.json()) as CustomerTripInvoiceRequest;
    const tripId = body.trip_id?.trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse("Valid trip_id is required");
    }

    const action = body.action === "view" ? "view" : "download";

    const { data: trip, error: tripError } = await userClient
      .from("trips")
      .select("id, status, passenger_id, payment_method, payment_status")
      .eq("id", tripId)
      .maybeSingle();

    if (tripError || !trip) {
      return errorResponse("Trip not found", 404);
    }

    const { data: customerRow } = await userClient
      .from("customers")
      .select("id, user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    const isPassenger =
      trip.passenger_id === authData.user.id
      || (customerRow?.id && trip.passenger_id === customerRow.id);

    if (!isPassenger) {
      return errorResponse("Forbidden", 403);
    }

    if (!isTripReadyForInvoice(trip)) {
      return errorResponse("Receipt is not available for this trip yet", 400);
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const result = await handleTripInvoiceAction(serviceClient, tripId, action);

    if (!result.success) {
      return errorResponse(result.error ?? "Could not load receipt", 400);
    }

    return successResponse({
      success: true,
      trip_id: tripId,
      pdf_url: result.pdf_url ?? result.pdfUrl ?? null,
      invoice_no: result.invoice_no ?? result.invoiceNo ?? null,
      message: result.message ?? "Receipt ready",
    });
  } catch (error) {
    console.error("[customer-trip-invoice] unexpected error", error);
    return errorResponse("Internal server error", 500);
  }
});
