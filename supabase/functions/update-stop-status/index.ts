const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface UpdateStopRequest {
  trip_id: string;
  stop_id?: string;
  action: "arrived" | "completed" | "skip";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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

    // Verify user token and get driver
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

    // Check if user is a driver
    const driverRes = await fetch(
      `${supabaseUrl}/rest/v1/drivers?user_id=eq.${userId}&select=id`,
      {
        headers: {
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
      }
    );

    if (!driverRes.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to verify driver" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const drivers = await driverRes.json();
    if (!drivers || drivers.length === 0) {
      return new Response(
        JSON.stringify({ error: "Not a driver" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const driverId = drivers[0].id;

    const body: UpdateStopRequest = await req.json();
    console.log("Update stop request:", JSON.stringify(body, null, 2));

    if (!body.trip_id || !body.action) {
      return new Response(
        JSON.stringify({ error: "trip_id and action are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify driver is assigned to this trip
    const tripRes = await fetch(
      `${supabaseUrl}/rest/v1/trips?id=eq.${body.trip_id}&driver_id=eq.${driverId}&select=id,status,current_stop_index,total_stops`,
      {
        headers: {
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
      }
    );

    if (!tripRes.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch trip" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const tripData = await tripRes.json();
    if (!tripData || tripData.length === 0) {
      return new Response(
        JSON.stringify({ error: "Trip not found or not assigned to you" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const trip = tripData[0];
    const currentStopIndex = trip.current_stop_index || 0;
    const totalStops = trip.total_stops || 2;

    // Get current stop
    const currentStopRes = await fetch(
      `${supabaseUrl}/rest/v1/trip_stops?trip_id=eq.${body.trip_id}&stop_index=eq.${currentStopIndex}&select=*`,
      {
        headers: {
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
      }
    );

    if (!currentStopRes.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch current stop" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const currentStops = await currentStopRes.json();
    if (!currentStops || currentStops.length === 0) {
      return new Response(
        JSON.stringify({ error: "Current stop not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const currentStop = currentStops[0];
    const now = new Date().toISOString();

    if (body.action === "arrived") {
      // Mark current stop as arrived
      const updateRes = await fetch(
        `${supabaseUrl}/rest/v1/trip_stops?id=eq.${currentStop.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            status: "arrived",
            arrived_at: now,
          }),
        }
      );

      if (!updateRes.ok) {
        const err = await updateRes.text();
        console.error("Failed to update stop:", err);
        return new Response(
          JSON.stringify({ error: "Failed to update stop" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Update trip status based on stop type
      let newTripStatus = trip.status;
      if (currentStop.type === "pickup") {
        newTripStatus = "arrived"; // Driver arrived at pickup
      }

      await fetch(
        `${supabaseUrl}/rest/v1/trips?id=eq.${body.trip_id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ status: newTripStatus }),
        }
      );

      if (currentStop.type === "pickup" && newTripStatus === "arrived") {
        try {
          const tripInfoRes = await fetch(
            `${supabaseUrl}/rest/v1/trips?id=eq.${body.trip_id}&select=passenger_id`,
            {
              headers: {
                apikey: supabaseServiceKey,
                Authorization: `Bearer ${supabaseServiceKey}`,
              },
            },
          );
          const tripInfo = tripInfoRes.ok ? await tripInfoRes.json() : null;
          const passengerId = tripInfo?.[0]?.passenger_id as string | undefined;
          if (passengerId) {
            await fetch(`${supabaseUrl}/functions/v1/send-trip-notification`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${supabaseServiceKey}`,
                apikey: supabaseServiceKey,
              },
              body: JSON.stringify({
                userId: passengerId,
                tripId: body.trip_id,
                event: "driver_arrived",
                notificationId: `driver_arrived-${body.trip_id}`,
              }),
            });
          }
        } catch (notifErr) {
          console.warn("[update-stop-status] driver_arrived push failed:", notifErr);
        }
      }

      console.log(`Stop ${currentStopIndex} marked as arrived`);

      return new Response(
        JSON.stringify({
          success: true,
          message: `Arrived at ${currentStop.type}`,
          current_stop_index: currentStopIndex,
          stop_status: "arrived",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.action === "completed" || body.action === "skip") {
      const newStatus = body.action === "skip" ? "skipped" : "completed";
      
      // ── Calculate waiting charge for intermediate stops ──
      let waitingChargePence = 0;
      if (currentStop.type === "stop" && currentStop.arrived_at && newStatus === "completed") {
        // Fetch fare_pricing_settings for waiting rate
        const tripDetailRes = await fetch(
          `${supabaseUrl}/rest/v1/trips?id=eq.${body.trip_id}&select=service_area_id,vehicle_type_id`,
          { headers: { apikey: supabaseServiceKey, Authorization: `Bearer ${supabaseServiceKey}` } },
        );
        const tripDetail = (await tripDetailRes.json())?.[0];

        if (tripDetail?.service_area_id) {
          let fareQuery = `${supabaseUrl}/rest/v1/fare_pricing_settings?service_area_id=eq.${tripDetail.service_area_id}&select=free_waiting_minutes,waiting_per_minute_pence`;
          if (tripDetail.vehicle_type_id) {
            fareQuery += `&vehicle_type_id=eq.${tripDetail.vehicle_type_id}`;
          }
          fareQuery += "&limit=1";
          const fareRes = await fetch(fareQuery, {
            headers: { apikey: supabaseServiceKey, Authorization: `Bearer ${supabaseServiceKey}` },
          });
          const fareRules = (await fareRes.json())?.[0];

          if (fareRules) {
            const graceSeconds = ((fareRules.free_waiting_minutes as number) ?? 0) * 60;
            const ratePencePerMin = (fareRules.waiting_per_minute_pence as number) ?? 0;
            const arrivedAt = new Date(currentStop.arrived_at).getTime();
            const elapsed = (Date.now() - arrivedAt) / 1000;
            const paidSeconds = Math.max(0, elapsed - graceSeconds);
            waitingChargePence = Math.floor((paidSeconds / 60) * ratePencePerMin);
            console.log(`Stop waiting charge: ${waitingChargePence}p (${Math.round(paidSeconds)}s paid @ ${ratePencePerMin}p/min)`);
          }
        }
      }
      
      // Mark current stop as completed/skipped with waiting charge
      const stopUpdate: Record<string, unknown> = {
        status: newStatus,
        completed_at: now,
      };
      if (waitingChargePence > 0) {
        stopUpdate.waiting_charge_pence = waitingChargePence;
      }

      const updateRes = await fetch(
        `${supabaseUrl}/rest/v1/trip_stops?id=eq.${currentStop.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify(stopUpdate),
        }
      );

      if (!updateRes.ok) {
        const err = await updateRes.text();
        console.error("Failed to update stop:", err);
        return new Response(
          JSON.stringify({ error: "Failed to update stop" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const nextStopIndex = currentStopIndex + 1;
      const isLastStop = nextStopIndex >= totalStops;

      if (isLastStop) {
        // Trip is complete
        await fetch(
          `${supabaseUrl}/rest/v1/trips?id=eq.${body.trip_id}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: supabaseServiceKey,
              Authorization: `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              status: "completed",
              completed_at: now,
              current_stop_index: currentStopIndex,
            }),
          }
        );

        // Clear driver's current trip
        await fetch(
          `${supabaseUrl}/rest/v1/drivers?id=eq.${driverId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: supabaseServiceKey,
              Authorization: `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({ current_trip_id: null }),
          }
        );

        // Clear customer's active trip
        const customerRes = await fetch(
          `${supabaseUrl}/rest/v1/trips?id=eq.${body.trip_id}&select=passenger_id`,
          {
            headers: {
              apikey: supabaseServiceKey,
              Authorization: `Bearer ${supabaseServiceKey}`,
            },
          }
        );

        if (customerRes.ok) {
          const tripInfo = await customerRes.json();
          if (tripInfo?.[0]?.passenger_id) {
            const passengerId = tripInfo[0].passenger_id as string;
            await fetch(
              `${supabaseUrl}/rest/v1/customers?id=eq.${passengerId}`,
              {
                method: "PATCH",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabaseServiceKey,
                  Authorization: `Bearer ${supabaseServiceKey}`,
                },
                body: JSON.stringify({ active_trip_id: null }),
              }
            );

            // Legacy complete path — same Customer trip_completed lifecycle as stop-workflow.
            try {
              await fetch(`${supabaseUrl}/functions/v1/send-trip-notification`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${supabaseServiceKey}`,
                  apikey: supabaseServiceKey,
                },
                body: JSON.stringify({
                  userId: passengerId,
                  tripId: body.trip_id,
                  event: "trip_completed",
                  notificationId: `trip_completed-${body.trip_id}`,
                }),
              });
            } catch (notifErr) {
              console.warn("[update-stop-status] trip_completed push failed:", notifErr);
            }
          }
        }

        console.log("Trip completed");

        return new Response(
          JSON.stringify({
            success: true,
            message: "Trip completed",
            trip_status: "completed",
            is_complete: true,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Move to next stop
      // Set next stop as current
      await fetch(
        `${supabaseUrl}/rest/v1/trip_stops?trip_id=eq.${body.trip_id}&stop_index=eq.${nextStopIndex}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ status: "current" }),
        }
      );

      // Update trip current_stop_index and status
      let newTripStatus = "in_progress";
      if (currentStop.type === "pickup") {
        newTripStatus = "in_progress"; // Passenger picked up, now in transit
      }

      await fetch(
        `${supabaseUrl}/rest/v1/trips?id=eq.${body.trip_id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            current_stop_index: nextStopIndex,
            status: newTripStatus,
            started_at: currentStop.type === "pickup" ? now : undefined,
          }),
        }
      );

      if (currentStop.type === "pickup" && newTripStatus === "in_progress") {
        try {
          const tripInfoRes = await fetch(
            `${supabaseUrl}/rest/v1/trips?id=eq.${body.trip_id}&select=passenger_id`,
            {
              headers: {
                apikey: supabaseServiceKey,
                Authorization: `Bearer ${supabaseServiceKey}`,
              },
            },
          );
          const tripInfo = tripInfoRes.ok ? await tripInfoRes.json() : null;
          const passengerId = tripInfo?.[0]?.passenger_id as string | undefined;
          if (passengerId) {
            await fetch(`${supabaseUrl}/functions/v1/send-trip-notification`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${supabaseServiceKey}`,
                apikey: supabaseServiceKey,
              },
              body: JSON.stringify({
                userId: passengerId,
                tripId: body.trip_id,
                event: "trip_started",
                notificationId: `trip_started-${body.trip_id}`,
              }),
            });
          }
        } catch (notifErr) {
          console.warn("[update-stop-status] trip_started push failed:", notifErr);
        }
      }

      // Get next stop info
      const nextStopRes = await fetch(
        `${supabaseUrl}/rest/v1/trip_stops?trip_id=eq.${body.trip_id}&stop_index=eq.${nextStopIndex}&select=*`,
        {
          headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
        }
      );

      let nextStop = null;
      if (nextStopRes.ok) {
        const nextStops = await nextStopRes.json();
        nextStop = nextStops?.[0] || null;
      }

      console.log(`Moved to stop ${nextStopIndex}`);

      return new Response(
        JSON.stringify({
          success: true,
          message: `Proceeding to ${nextStop?.type || "next stop"}`,
          current_stop_index: nextStopIndex,
          next_stop: nextStop,
          stops_remaining: totalStops - nextStopIndex - 1,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Update stop error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
