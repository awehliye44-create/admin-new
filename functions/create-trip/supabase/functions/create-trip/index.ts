const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface CreateTripRequest {
  passenger_name: string;
  passenger_phone: string;
  pickup_address: string;
  pickup_latitude: number;
  pickup_longitude: number;
  dropoff_address: string;
  dropoff_latitude: number;
  dropoff_longitude: number;
  estimated_fare: number;
  estimated_distance: number;
  estimated_duration: number;
  special_instructions?: string;
  assigned_driver_id?: string;
  payment_method?: string;
  vehicle_type?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  return new Response(
    JSON.stringify({
      error: "create-trip is retired. Use create-trip-after-payment for all paid bookings.",
      code: "USE_CREATE_TRIP_AFTER_PAYMENT",
      redirect: "create-trip-after-payment",
    }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify user token
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: authHeader,
        apikey: supabaseServiceKey,
      },
    });

    if (!userRes.ok) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userData = await userRes.json();
    const userId = userData.id;

    const body: CreateTripRequest = await req.json();
    console.log("Creating trip:", body);

    if (!body.pickup_address || !body.dropoff_address) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!body.passenger_name || !body.passenger_phone) {
      return new Response(
        JSON.stringify({ error: "Passenger name and phone are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Never create a trip without a valid fare
    if (!body.estimated_fare || body.estimated_fare <= 0) {
      console.error("Rejected — no valid fare provided:", body.estimated_fare);
      return new Response(
        JSON.stringify({ error: "A valid fare is required to create a trip. Please select a vehicle first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const fareValue = body.estimated_fare;

    // Find service area and Region currency/units (Region is sole source of truth)
    let serviceAreaId: string | null = null;
    let regionCurrencyCode: string | null = null;
    let regionDistanceUnit: string | null = null;
    try {
      const saRes = await fetch(
        `${supabaseUrl}/rest/v1/rpc/find_service_area_by_location`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            p_lat: body.pickup_latitude || 0,
            p_lng: body.pickup_longitude || 0,
          }),
        }
      );
      if (saRes.ok) {
        const saData = await saRes.json();
        serviceAreaId = saData;
        console.log("Resolved service area:", serviceAreaId);

        // Fetch Region currency/units via service_area → region join
        if (serviceAreaId) {
          const saDetailRes = await fetch(
            `${supabaseUrl}/rest/v1/service_areas?select=region_id,regions!inner(currency_code,distance_unit)&id=eq.${serviceAreaId}`,
            {
              headers: {
                apikey: supabaseServiceKey,
                Authorization: `Bearer ${supabaseServiceKey}`,
              },
            }
          );
          if (saDetailRes.ok) {
            const saDetails = await saDetailRes.json();
            const region = saDetails?.[0]?.regions;
            if (region?.currency_code) regionCurrencyCode = region.currency_code;
            if (region?.distance_unit) regionDistanceUnit = region.distance_unit;
            console.log("Region currency:", regionCurrencyCode, "distance_unit:", regionDistanceUnit);
          }
        }
      }
    } catch (e) {
      console.warn("Failed to resolve service area:", e);
    }

    // Digital-only — reject cash payment method
    const requestedMethod = (body.payment_method || "card").toLowerCase();
    if (requestedMethod === "cash") {
      return new Response(
        JSON.stringify({
          error: "Cash payment is no longer supported. ONECAB is a digital-only platform.",
          code: "CASH_NOT_SUPPORTED",
        }),
        { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Validate payment method against service area config
    if (serviceAreaId && body.payment_method) {
      const pmRes = await fetch(
        `${supabaseUrl}/rest/v1/service_area_payment_methods?select=card_enabled,wallet_enabled,apple_pay_enabled,google_pay_enabled&service_area_id=eq.${serviceAreaId}`,
        {
          headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
        }
      );
      if (pmRes.ok) {
        const pmRows = await pmRes.json();
        const pmConfig = pmRows?.[0];
        if (pmConfig) {
          const methodAllowed: Record<string, boolean> = {
            card: pmConfig.card_enabled,
            wallet: pmConfig.wallet_enabled,
            apple_pay: pmConfig.apple_pay_enabled,
            google_pay: pmConfig.google_pay_enabled,
          };
          const selected = body.payment_method;
          if (selected in methodAllowed && !methodAllowed[selected]) {
            console.error("REJECTED — payment method not allowed", { selected, serviceAreaId });
            return new Response(
              JSON.stringify({ error: `Payment method "${selected}" is not available in this service area` }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        }
      }
    }

    // Validate Region configuration — currency and distance unit are required
    if (!regionCurrencyCode || !regionDistanceUnit) {
      console.error("Region missing currency_code or distance_unit", { serviceAreaId, regionCurrencyCode, regionDistanceUnit });
      return new Response(
        JSON.stringify({ error: "Region configuration incomplete — missing currency or distance unit. Please contact support." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build trip data — include service_area_id so the
    // trigger_assign_trip_number trigger fires on insert and
    // generates the proper service-area-based trip number (e.g. MK001)
    const tripData: Record<string, unknown> = {
      passenger_id: userId,
      passenger_name: body.passenger_name,
      passenger_phone: body.passenger_phone,
      pickup_address: body.pickup_address,
      pickup_latitude: body.pickup_latitude || 0,
      pickup_longitude: body.pickup_longitude || 0,
      dropoff_address: body.dropoff_address,
      dropoff_latitude: body.dropoff_latitude || 0,
      dropoff_longitude: body.dropoff_longitude || 0,
      fare: fareValue,
      estimated_fare: fareValue,
      estimated_distance_km: body.estimated_distance || 0,
      estimated_duration_minutes: body.estimated_duration || 0,
      special_instructions: body.special_instructions || null,
      payment_method: requestedMethod,
      payment_type: requestedMethod,
      payment_status: "pending",
      status: "pending",
      trip_type: "immediate",
      currency: regionCurrencyCode.toUpperCase(),
      currency_code: regionCurrencyCode.toLowerCase(),
      distance_unit: regionDistanceUnit,
      surge_multiplier: 1.0,
      is_scheduled: false,
      job_type: "ride",
      driver_id: body.assigned_driver_id || null,
    };

    // Attach service area so the DB trigger assigns the trip number automatically
    if (serviceAreaId) {
      tripData.service_area_id = serviceAreaId;
    }

    console.log("Inserting trip data:", tripData);

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/trips`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseServiceKey,
        Authorization: `Bearer ${supabaseServiceKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(tripData),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error("Trip insert error:", errText);
      return new Response(
        JSON.stringify({ error: errText }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const trips = await insertRes.json();
    const trip = Array.isArray(trips) ? trips[0] : trips;

    console.log("Trip created successfully:", trip.id);

    // If the trigger already assigned a trip number we can skip the manual call
    let tripNumber: string | null = trip.trip_number || null;

    if (!tripNumber && serviceAreaId) {
      try {
        const assignRes = await fetch(
          `${supabaseUrl}/rest/v1/rpc/assign_trip_number`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: supabaseServiceKey,
              Authorization: `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              p_trip_id: trip.id,
              p_service_area_id: serviceAreaId,
            }),
          }
        );
        if (assignRes.ok) {
          const assignData = await assignRes.json();
          if (assignData?.success) {
            tripNumber = assignData.trip_number;
            console.log("Assigned trip number:", tripNumber);
          } else {
            console.warn("Failed to assign trip number:", assignData?.error);
          }
        }
      } catch (e) {
        console.warn("Error assigning trip number:", e);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        tripId: trip.id,
        tripNumber,
        status: "pending",
        assignedDriverId: null,
        dispatchMode: "broadcast",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Create trip error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
