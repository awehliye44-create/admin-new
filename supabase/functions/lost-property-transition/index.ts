import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Valid state machine transitions
const VALID_TRANSITIONS: Record<string, Record<string, string>> = {
  MARK_FOUND: {
    REPORTED: "AWAITING_CUSTOMER_CONFIRMATION",
    AWAITING_DRIVER_CHECK: "AWAITING_CUSTOMER_CONFIRMATION",
  },
  MARK_NOT_FOUND: {
    REPORTED: "DRIVER_NOT_FOUND",
    AWAITING_DRIVER_CHECK: "DRIVER_NOT_FOUND",
  },
  ACCEPT_RETURN: {
    CUSTOMER_CONFIRMED: "RETURN_RIDE_BOOKED",
  },
  DECLINE_RETURN: {
    CUSTOMER_CONFIRMED: "CUSTOMER_CONFIRMED", // stays same, resets flag
  },
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // --- Auth: verify user session securely ---
    const auth = await requireAuthenticatedUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth.ok) {
      // Inject CORS headers to auth fail response if not present
      const response = auth.response;
      for (const [k, v] of Object.entries(corsHeaders)) {
        response.headers.set(k, v);
      }
      return response;
    }
    const userId = auth.userId;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // --- Get driver ID for this user ---
    const { data: driver } = await admin
      .from("drivers")
      .select("id")
      .eq("user_id", userId)
      .single();

    if (!driver) {
      return new Response(JSON.stringify({ error: "Driver not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { case_id, action, photos } = body;

    if (!case_id || typeof case_id !== "string") {
      return new Response(
        JSON.stringify({ error: "case_id is required and must be a string" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!action || typeof action !== "string") {
      return new Response(
        JSON.stringify({ error: "action is required and must be a string" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Fetch case and validate ownership ---
    const { data: lpCase, error: caseErr } = await admin
      .from("lost_property_cases")
      .select("*")
      .eq("id", case_id)
      .single();

    if (caseErr || !lpCase) {
      return new Response(JSON.stringify({ error: "Case not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (lpCase.driver_id !== driver.id) {
      return new Response(JSON.stringify({ error: "Not your case" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Validate transition ---
    const transitions = VALID_TRANSITIONS[action];
    if (!transitions) {
      return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const newStatus = transitions[lpCase.status];
    if (!newStatus) {
      return new Response(
        JSON.stringify({
          error: `Cannot ${action} from status ${lpCase.status}`,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const now = new Date().toISOString();
    const updatePayload: Record<string, unknown> = {
      status: newStatus,
      driver_responded_at: now,
      updated_at: now,
    };

    // --- Action-specific logic ---
    if (action === "MARK_FOUND") {
      if (photos && Array.isArray(photos) && photos.length > 0) {
        const uploadedPaths: string[] = [];
        for (const photo of photos) {
          const ext = photo.name?.split(".").pop() ?? "jpg";
          const path = `lost-property/${case_id}/found/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
          const binary = Uint8Array.from(atob(photo.data), (c: string) => c.charCodeAt(0));
          const { error: uploadErr } = await admin.storage
            .from("driver-documents")
            .upload(path, binary, { contentType: photo.type || "image/jpeg" });
          if (uploadErr) {
            console.error("Photo upload error:", uploadErr);
            continue;
          }
          uploadedPaths.push(path);
        }

        if (uploadedPaths.length === 0) {
          return new Response(
            JSON.stringify({ error: "Photo upload failed. At least one photo is required." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        updatePayload.found_item_photos = uploadedPaths;
        updatePayload.item_found_at = now;
      } else {
        return new Response(
          JSON.stringify({ error: "At least one photo is required when marking as found" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (action === "DECLINE_RETURN") {
      updatePayload.same_driver_requested = false;
      updatePayload.driver_declined_return_at = now;
    }

    // --- Apply update ---
    const { error: updateErr } = await admin
      .from("lost_property_cases")
      .update(updatePayload)
      .eq("id", case_id);

    if (updateErr) {
      console.error("Case update error:", updateErr);
      return new Response(JSON.stringify({ error: "Failed to update case" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Status history ---
    await admin.from("lost_property_status_history").insert({
      case_id,
      old_status: lpCase.status,
      new_status: newStatus,
      changed_by: driver.id,
      changed_by_type: "driver",
      notes: getActionNote(action, photos?.length),
    });

    // --- Notify customer (push + in-app) ---
    const notifTitle = getNotifTitle(action);
    const notifBody = getNotifBody(action, lpCase.item_description);

    if (notifTitle) {
      // Push notification
      try {
        await admin.functions.invoke("send-customer-notification", {
          body: {
            customer_id: lpCase.customer_id,
            title: notifTitle,
            body: notifBody,
            type: "lost_property_update",
            data: { case_id, status: newStatus },
          },
        });
      } catch (notifErr) {
        console.error("Failed to send customer push notification:", notifErr);
      }

      // In-app notification record (best-effort)
      try {
        await admin.from("notifications").insert({
          user_id: lpCase.customer_id,
          title: notifTitle,
          body: notifBody,
          type: "lost_property_update",
          data: { case_id, status: newStatus, action },
        });
      } catch (inAppErr) {
        // notifications table may not exist yet - non-fatal
        console.error("Failed to insert in-app notification:", inAppErr);
      }

      // Insert a guaranteed system message for every action
      try {
        await admin.from("lost_property_messages").insert({
          case_id,
          sender_type: "system",
          sender_id: driver.id,
          message: getSystemMessage(action, lpCase.item_description),
        });
      } catch (msgErr) {
        console.error("Failed to send system message:", msgErr);
      }
    }

    // --- For ACCEPT_RETURN: create a return trip ---
    if (action === "ACCEPT_RETURN" && lpCase.trip_id) {
      try {
        const { data: origTrip } = await admin
          .from("trips")
          .select("pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, service_area_id, passenger_id, customer_id, financial_model, commission_wallet_enabled, customer_payment_policy")
          .eq("id", lpCase.trip_id)
          .single();

        if (origTrip) {
          let financialModel = origTrip.financial_model ?? null;
          let commissionWalletEnabled = origTrip.commission_wallet_enabled ?? null;
          let customerPaymentPolicy = origTrip.customer_payment_policy ?? null;
          if (!financialModel && origTrip.service_area_id) {
            const { data: sa } = await admin
              .from("service_areas")
              .select("financial_model, commission_wallet_enabled, customer_payment_policy")
              .eq("id", origTrip.service_area_id)
              .maybeSingle();
            financialModel = sa?.financial_model ?? null;
            commissionWalletEnabled = sa?.commission_wallet_enabled ?? null;
            customerPaymentPolicy = sa?.customer_payment_policy ?? null;
          }
          const passengerId =
            typeof origTrip.passenger_id === "string" && origTrip.passenger_id.trim()
              ? origTrip.passenger_id.trim()
              : typeof origTrip.customer_id === "string" && origTrip.customer_id.trim()
                ? origTrip.customer_id.trim()
                : typeof lpCase.customer_id === "string"
                  ? lpCase.customer_id
                  : null;
          const { data: returnTrip } = await admin.from("trips").insert({
            passenger_id: passengerId,
            customer_id: origTrip.customer_id ?? passengerId,
            driver_id: driver.id,
            confirmed_driver_id: driver.id,
            service_area_id: origTrip.service_area_id,
            financial_model: financialModel,
            commission_wallet_enabled: commissionWalletEnabled,
            customer_payment_policy: customerPaymentPolicy,
            pickup_address: origTrip.dropoff_address ?? "Item location",
            pickup_lat: origTrip.dropoff_lat,
            pickup_lng: origTrip.dropoff_lng,
            dropoff_address: origTrip.pickup_address ?? "Customer location",
            dropoff_lat: origTrip.pickup_lat,
            dropoff_lng: origTrip.pickup_lng,
            status: "driver_assigned",
            notes: `Lost Property Return - Case ${lpCase.case_number}`,
          }).select("id").single();

          if (returnTrip) {
            await admin
              .from("lost_property_cases")
              .update({ return_trip_id: returnTrip.id })
              .eq("id", case_id);

            if (passengerId) {
              try {
                const { notifyCustomerTripLifecycle } = await import(
                  "../_shared/customerTripLifecycleNotify.ts"
                );
                await notifyCustomerTripLifecycle(admin, {
                  passengerId,
                  tripId: returnTrip.id,
                  event: "driver_assigned",
                  title: "ONECAB DRIVER ASSIGNED",
                  body: "Your driver is on the way for your lost-property return.",
                  notificationId: `driver_assigned-${returnTrip.id}-lost_property`,
                });
              } catch (assignNotifErr) {
                console.warn(
                  "[lost-property-transition] return-trip driver_assigned push failed:",
                  assignNotifErr,
                );
              }
            }
          }
        }
      } catch (tripErr) {
        console.error("Failed to create return trip:", tripErr);
        // Non-fatal: case status already updated
      }
    }

    return new Response(
      JSON.stringify({ success: true, status: newStatus }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("lost-property-transition error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function getActionNote(action: string, photoCount?: number): string {
  switch (action) {
    case "MARK_FOUND":
      return `Driver found item and uploaded ${photoCount ?? 0} photo(s)`;
    case "MARK_NOT_FOUND":
      return "Driver could not find the item";
    case "ACCEPT_RETURN":
      return "Driver accepted return ride";
    case "DECLINE_RETURN":
      return "Driver declined return ride. Customer offered collect/support options.";
    default:
      return action;
  }
}

function getNotifTitle(action: string): string | null {
  switch (action) {
    case "MARK_FOUND":
      return "Item Found!";
    case "MARK_NOT_FOUND":
      return "Item Not Found";
    case "ACCEPT_RETURN":
      return "Return Ride Accepted";
    case "DECLINE_RETURN":
      return "Return Ride Update";
    default:
      return null;
  }
}

function getNotifBody(action: string, itemDesc: string): string {
  switch (action) {
    case "MARK_FOUND":
      return `Your driver found "${itemDesc}". Please confirm if this is your item.`;
    case "MARK_NOT_FOUND":
      return `Your driver could not find "${itemDesc}" in the vehicle. Chat remains open if you need to discuss.`;
    case "ACCEPT_RETURN":
      return `Your driver has accepted the return ride for "${itemDesc}". You'll receive trip details shortly.`;
    case "DECLINE_RETURN":
      return `The driver is unable to return "${itemDesc}". You can collect the item yourself or contact support for help.`;
    default:
      return "";
  }
}

function getSystemMessage(action: string, itemDesc: string): string {
  switch (action) {
    case "MARK_FOUND":
      return `The driver has found "${itemDesc}" and uploaded photos. Please confirm if this is your item.`;
    case "MARK_NOT_FOUND":
      return `The driver checked their vehicle but could not find "${itemDesc}". Chat remains open if you need to discuss further.`;
    case "ACCEPT_RETURN":
      return `The driver has accepted the return ride for "${itemDesc}". A return trip is being arranged.`;
    case "DECLINE_RETURN":
      return `The driver has declined the return ride. You can collect the item yourself or contact support for further assistance.`;
    default:
      return `Case updated: ${action}`;
  }
}