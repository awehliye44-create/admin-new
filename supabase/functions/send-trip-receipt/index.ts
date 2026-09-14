/**
 * Manual trip receipt email.
 * Authenticated customer (own completed trip) or admin/staff.
 * Never invoked by trip completion, capture, or a payment webhook.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "../_shared/security.ts";
import {
  errorResponse,
  isValidUUID,
  successResponse,
  validationErrorResponse,
} from "../_shared/security.ts";
import { sendManualTripReceipt } from "../_shared/manualTripReceiptSend.ts";
import { normalizeReceiptEmail } from "../../../shared/manualTripReceiptSSOT.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    // Service role and cron must not send receipts. Email is a user action.
    if (token === serviceKey) return errorResponse("Unauthorized", 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) return errorResponse("Unauthorized", 401);

    let body: { trip_id?: string; email?: string } = {};
    try {
      body = await req.json();
    } catch {
      return validationErrorResponse({ body: "Invalid JSON body" });
    }

    const tripId = body.trip_id?.trim() ?? "";
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse({ trip_id: "Valid trip_id is required" });
    }

    const email = normalizeReceiptEmail(body.email);
    if (!email) {
      return validationErrorResponse({ email: "Enter a valid email address" });
    }

    const service = createClient(supabaseUrl, serviceKey);
    const userId = authData.user.id;

    const [{ data: adminRole }, { data: staffRow }] = await Promise.all([
      service.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
      service.from("staff_profiles").select("id").eq("user_id", userId).eq("is_active", true).maybeSingle(),
    ]);
    const isAdmin = Boolean(adminRole || staffRow);

    const { data: trip, error: tripError } = await service
      .from("trips")
      .select("id, passenger_id")
      .eq("id", tripId)
      .maybeSingle();

    if (tripError || !trip) return errorResponse("Trip not found", 404);

    let recipientUserId = userId;
    if (!isAdmin) {
      const { data: customerRow } = await userClient
        .from("customers")
        .select("id, user_id")
        .eq("user_id", userId)
        .maybeSingle();
      const ownsTrip = trip.passenger_id === userId
        || (customerRow?.id && trip.passenger_id === customerRow.id);
      if (!ownsTrip) return errorResponse("Forbidden", 403);
    } else if (trip.passenger_id) {
      const { data: customer } = await service
        .from("customers")
        .select("user_id")
        .or(`id.eq.${trip.passenger_id},user_id.eq.${trip.passenger_id}`)
        .maybeSingle();
      recipientUserId = (customer?.user_id as string | null) ?? (trip.passenger_id as string);
    }

    const result = await sendManualTripReceipt(service, {
      tripId,
      email,
      sentBy: userId,
      source: isAdmin ? "admin_panel" : "customer_app",
      recipientUserId,
    });

    if (!result.ok) {
      return errorResponse(result.error ?? "Could not send receipt", 400);
    }

    return successResponse({
      success: true,
      trip_id: tripId,
      status: result.status,
      idempotent: result.idempotent === true,
      invoice_email_status: result.invoice_email_status ?? result.status,
      invoice_email_sent_at: result.invoice_email_sent_at ?? null,
      invoice_email_recipient: result.invoice_email_recipient ?? email,
    });
  } catch (error) {
    console.error("[send-trip-receipt] unexpected", error);
    return errorResponse("Could not send receipt", 500);
  }
});
