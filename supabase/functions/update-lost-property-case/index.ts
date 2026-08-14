import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface UpdateCaseRequest {
  case_id: string;
  action: "set_return_method" | "escalate" | "close" | "mark_collected" | "customer_confirm" | "customer_reject";
  return_method?: "collect" | "book_ride";
  return_trip_id?: string;
  same_driver_requested?: boolean;
}

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization header" }, 401);
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body: UpdateCaseRequest = await req.json();
    const { case_id, action, return_method, return_trip_id, same_driver_requested } = body;

    if (!case_id || !action) {
      return jsonResponse({ error: "Missing required fields" }, 400);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Resolve internal customer ID from auth user ID
    const { data: customer } = await supabase
      .from("customers")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (!customer) {
      return jsonResponse({ error: "Customer profile not found" }, 404);
    }

    // Get case and verify ownership
    const { data: existingCase, error: caseError } = await supabase
      .from("lost_property_cases")
      .select("*")
      .eq("id", case_id)
      .single();

    if (caseError || !existingCase) {
      return jsonResponse({ error: "Case not found" }, 404);
    }

    if (existingCase.customer_id !== customer.id) {
      return jsonResponse({ error: "You can only update your own cases" }, 403);
    }

    const caseStatus = (existingCase.status || "").toLowerCase();
    let updateData: Record<string, unknown> = {};
    let statusNote = "";

    switch (action) {
      case "customer_confirm": {
        if (!["item_found", "driver_confirmed_found", "awaiting_customer_confirmation"].includes(caseStatus)) {
          return jsonResponse({ error: "Can only confirm when item is found" }, 400);
        }
        // Customer confirmed the found item – move to retrieval selection
        // Status stays item_found but we could add a sub-state; for now the client
        // will show the retrieval method sheet after confirmation.
        // No status change needed – the retrieval method selection will trigger set_return_method.
        statusNote = "Customer confirmed the found item";
        // Just log the confirmation, no status change
        await supabase.from("lost_property_status_history").insert({
          case_id,
          old_status: existingCase.status,
          new_status: existingCase.status,
          changed_by: customer.id,
          changed_by_type: "customer",
          notes: statusNote,
        });
        await supabase.from("lost_property_messages").insert({
          case_id,
          sender_type: "system",
          message: "Customer confirmed: this is their item.",
        });
        return jsonResponse({ success: true, case: existingCase }, 200);
      }

      case "customer_reject": {
        if (!["item_found", "driver_confirmed_found", "awaiting_customer_confirmation"].includes(caseStatus)) {
          return jsonResponse({ error: "Can only reject when item is found" }, 400);
        }
        updateData = { status: "ESCALATED" };
        statusNote = "Customer rejected the found item — escalated to support";
        break;
      }

      case "set_return_method": {
        if (!return_method) {
          return jsonResponse({ error: "return_method is required" }, 400);
        }
        if (!["item_found", "driver_confirmed_found", "awaiting_customer_confirmation", "awaiting_return_method", "return_ride_declined", "return_ride_booked", "return_ride_requested"].includes(caseStatus)) {
          return jsonResponse({ error: `Can only set return method when item is found or ride was declined (current: ${existingCase.status})` }, 400);
        }

        // G3: Use RETURN_RIDE_REQUESTED for book_ride, only move to BOOKED when driver accepts
        const newStatus = return_method === "collect"
          ? "AWAITING_COLLECTION"
          : return_trip_id ? "RETURN_RIDE_BOOKED" : "RETURN_RIDE_REQUESTED";

        updateData = {
          return_method,
          same_driver_requested: same_driver_requested ?? true,
          status: newStatus,
        };

        if (return_trip_id) {
          updateData.return_trip_id = return_trip_id;
        }

        statusNote = return_method === "collect"
          ? "Customer chose to collect the item"
          : return_trip_id
            ? "Return ride booked with driver"
            : "Customer requested a return ride";
        break;
      }

      case "escalate": {
        if (!["item_not_found", "driver_not_found", "sent_to_driver", "return_ride_declined"].includes(caseStatus)) {
          return jsonResponse({ error: "Cannot escalate case in current status" }, 400);
        }
        updateData = { status: "ESCALATED" };
        statusNote = "Customer escalated to support";
        break;
      }

      case "close": {
        updateData = {
          status: "CLOSED",
          closed_at: new Date().toISOString(),
          chat_enabled: false,
        };
        statusNote = "Case closed by customer";
        break;
      }

      case "mark_collected": {
        if (!["awaiting_collection"].includes(caseStatus)) {
          return jsonResponse({ error: "Can only mark collected when awaiting collection" }, 400);
        }
        updateData = {
          status: "COLLECTED",
          collected_at: new Date().toISOString(),
          chat_enabled: false,
        };
        statusNote = "Item marked as collected";
        break;
      }

      default:
        return jsonResponse({ error: "Invalid action" }, 400);
    }

    // Update the case
    const { data: updatedCase, error: updateError } = await supabase
      .from("lost_property_cases")
      .update(updateData)
      .eq("id", case_id)
      .select()
      .single();

    if (updateError) {
      console.error("Update error:", updateError);
      return jsonResponse({ error: "Failed to update case" }, 500);
    }

    // Log status change
    if (updateData.status) {
      await supabase.from("lost_property_status_history").insert({
        case_id,
        old_status: existingCase.status,
        new_status: updateData.status as string,
        changed_by: customer.id,
        changed_by_type: "customer",
        notes: statusNote,
      });

      await supabase.from("lost_property_messages").insert({
        case_id,
        sender_type: "system",
        message: statusNote,
      });
    }

    console.log("Updated lost property case:", case_id, action);

    return jsonResponse({ success: true, case: updatedCase }, 200);
  } catch (error) {
    console.error("Unexpected error:", error);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
