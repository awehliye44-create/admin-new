import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface CreateCaseRequest {
  trip_id: string;
  item_category: "phone" | "wallet" | "keys" | "bag" | "other";
  item_description: string;
  photos?: string[];
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
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create client with user's token to get user ID
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body: CreateCaseRequest = await req.json();
    const { trip_id, item_category, item_description, photos = [] } = body;

    if (!trip_id || !item_category || !item_description) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use service role for database operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get trip details to validate ownership and get driver/region info
    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("id, driver_id, passenger_id, service_area_id, service_areas(region_id)")
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      console.error("Trip lookup error:", tripError);
      return new Response(
        JSON.stringify({ error: "Trip not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve internal customer ID from auth user ID
    const { data: customer } = await supabase
      .from("customers")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (!customer || trip.passenger_id !== customer.id) {
      return new Response(
        JSON.stringify({ error: "You can only report lost items for your own trips" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check for existing open case for this trip
    const { data: existingCase } = await supabase
      .from("lost_property_cases")
      .select("id, case_number")
      .eq("trip_id", trip_id)
      .not("status", "in", '("closed","collected")')
      .single();

    if (existingCase) {
      return new Response(
        JSON.stringify({ 
          error: "An open case already exists for this trip",
          existing_case_id: existingCase.id,
          case_number: existingCase.case_number
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const serviceAreaId = trip.service_area_id;
    const regionId = (trip.service_areas as any)?.region_id;

    if (!regionId) {
      return new Response(
        JSON.stringify({ error: "Could not determine region for trip" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate case number
    const { data: caseNumberResult, error: caseNumberError } = await supabase
      .rpc("generate_lost_property_case_number", { p_service_area_id: serviceAreaId });

    if (caseNumberError) {
      console.error("Case number generation error:", caseNumberError);
      return new Response(
        JSON.stringify({ error: "Failed to generate case number" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create the case
    const { data: newCase, error: createError } = await supabase
      .from("lost_property_cases")
      .insert({
        case_number: caseNumberResult,
        trip_id,
        driver_id: trip.driver_id,
        customer_id: customer.id,
        region_id: regionId,
        service_area_id: serviceAreaId,
        item_category,
        item_description,
        photos,
        status: "sent_to_driver",
      })
      .select()
      .single();

    if (createError) {
      console.error("Case creation error:", createError);
      return new Response(
        JSON.stringify({ error: "Failed to create case" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log initial status
    await supabase.from("lost_property_status_history").insert({
      case_id: newCase.id,
      old_status: null,
      new_status: "sent_to_driver",
      changed_by: customer.id,
      changed_by_type: "customer",
      notes: "Case created by customer",
    });

    // Add system message to chat
    await supabase.from("lost_property_messages").insert({
      case_id: newCase.id,
      sender_type: "system",
      message: `Lost property case ${caseNumberResult} created. The driver has been notified.`,
    });

    console.log("Created lost property case:", newCase.id);

    // Send push notification to the driver
    if (trip.driver_id) {
      // Look up the driver's auth user_id
      const { data: driver } = await supabase
        .from("drivers")
        .select("user_id")
        .eq("id", trip.driver_id)
        .single();

      if (driver?.user_id) {
        fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            userId: driver.user_id,
            title: "📦 Lost Item Reported",
            body: `A passenger reported a lost ${item_category}. Please check your vehicle.`,
            url: `/lost-property/${newCase.id}`,
            tag: "lost-property",
            requireInteraction: true,
          }),
        }).catch(err => console.warn("Push notification error:", err));
      } else {
        console.warn("Could not find driver user_id for driver:", trip.driver_id);
      }
    }

    return new Response(
      JSON.stringify({ success: true, case: newCase }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
