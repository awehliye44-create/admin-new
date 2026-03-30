import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  securityHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  errorResponse,
  successResponse,
  logAuditEvent,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = { limit: 20, windowMs: 60 * 1000 };

interface DispatchSettings {
  search_radius_start_km: number;
  search_radius_expand_km: number;
  search_radius_max_km: number;
  shortlist_limit: number;
  wave1_size: number;
  wave2_size: number;
  wave3_size: number;
  offer_expiry_seconds: number;
  wave1_offer_expiry_seconds: number;
  wave2_offer_expiry_seconds: number;
  wave3_offer_expiry_seconds: number;
  distance_penalty_per_km: number;
  waiting_bonus_per_minute: number;
  max_waiting_bonus_minutes: number;
  fairness_idle_minutes: number;
  fairness_boost_score: number;
  accept_timeout_seconds: number;
  // Stacked rides — Admin-configured
  stacked_rides_enabled: boolean;
  max_stacked_rides: number;
  stacked_min_trip_distance_km: number;
  stacked_max_detour_minutes: number;
  stacked_priority_mode: string;
}

interface ScoredCandidate {
  driver_id: string;
  distance_km: number;
  waiting_minutes: number;
  category_name: string | null;
  category_priority: number;
  dispatch_score: number;
  lat: number;
  lng: number;
  is_stacked: boolean;
}

function minutesSince(dateStr: string | null, fallback: string | null): number {
  const ref = dateStr || fallback;
  if (!ref) return 0;
  return Math.max(0, (Date.now() - new Date(ref).getTime()) / 60000);
}

function parseSettings(row: Record<string, any>): DispatchSettings {
  return {
    search_radius_start_km: row.search_radius_start_km,
    search_radius_expand_km: row.search_radius_expand_km,
    search_radius_max_km: row.search_radius_max_km,
    shortlist_limit: row.shortlist_limit,
    wave1_size: row.wave1_size,
    wave2_size: row.wave2_size,
    wave3_size: row.wave3_size,
    offer_expiry_seconds: row.offer_expiry_seconds,
    wave1_offer_expiry_seconds: row.wave1_offer_expiry_seconds,
    wave2_offer_expiry_seconds: row.wave2_offer_expiry_seconds,
    wave3_offer_expiry_seconds: row.wave3_offer_expiry_seconds,
    distance_penalty_per_km: row.distance_penalty_per_km,
    waiting_bonus_per_minute: row.waiting_bonus_per_minute,
    max_waiting_bonus_minutes: row.max_waiting_bonus_minutes,
    fairness_idle_minutes: row.fairness_idle_minutes,
    fairness_boost_score: row.fairness_boost_score,
    accept_timeout_seconds: row.accept_timeout_seconds,
    stacked_rides_enabled: row.stacked_rides_enabled,
    max_stacked_rides: row.max_stacked_rides,
    stacked_min_trip_distance_km: row.stacked_min_trip_distance_km,
    stacked_max_detour_minutes: row.stacked_max_detour_minutes,
    stacked_priority_mode: row.stacked_priority_mode,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const userAgent = req.headers.get("user-agent") || "unknown";

  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  try {
    let body: {
      trip_id: string;
      pickup_lat: number;
      pickup_lng: number;
      vehicle_type_id?: string;
      service_area_id?: string;
      booking_type?: string;
      assigned_driver_id?: string;
    };

    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const { trip_id, pickup_lat, pickup_lng, vehicle_type_id, service_area_id, booking_type, assigned_driver_id } = body;

    if (!trip_id || typeof pickup_lat !== "number" || typeof pickup_lng !== "number") {
      return errorResponse("Missing trip_id, pickup_lat, or pickup_lng", 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[dispatch-drivers] Trip ${trip_id} | Pickup: ${pickup_lat},${pickup_lng} | Type: ${booking_type || "normal"}`);

    // Validate trip
    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select("id, status, service_area_id")
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) return errorResponse("Trip not found", 404);

    const terminalStatuses = ["accepted", "driver_arriving", "arrived", "in_progress", "completed", "cancelled"];
    if (terminalStatuses.includes(trip.status)) {
      return errorResponse("Trip already processed", 400, { status: trip.status });
    }

    // ====== SCAN&GO: direct assignment ======
    if (booking_type === "SCAN_GO" && assigned_driver_id) {
      console.log(`[dispatch-drivers] SCAN_GO: direct offer to ${assigned_driver_id}`);
      const expiresAt = new Date(Date.now() + 30 * 1000).toISOString();

      const { error: offerErr } = await supabase.from("ride_offers").insert({
        trip_id,
        driver_id: assigned_driver_id,
        status: "pending",
        distance_km: 0,
        expires_at: expiresAt,
      });

      if (offerErr) {
        console.error("[dispatch-drivers] Scan&Go offer error:", offerErr);
        return errorResponse("Failed to create Scan&Go offer", 500);
      }

      await supabase.from("trips").update({ status: "offered", confirm_deadline_at: expiresAt }).eq("id", trip_id);
      await supabase.from("drivers").update({ last_offer_at: new Date().toISOString() }).eq("id", assigned_driver_id);

      return successResponse({ dispatched: true, scan_go: true, offers_sent: 1 });
    }

    // ====== LOAD DISPATCH SETTINGS (strict — no hardcoded defaults) ======
    const resolvedSaId = service_area_id || trip.service_area_id;

    if (!resolvedSaId) {
      return errorResponse("No service area resolved for trip. Configure dispatch_settings in Admin.", 422);
    }

    const { data: saSettings } = await supabase
      .from("dispatch_settings")
      .select("*")
      .eq("service_area_id", resolvedSaId)
      .maybeSingle();

    if (!saSettings) {
      return errorResponse(
        `No dispatch_settings configured for service area ${resolvedSaId}. Configure in Admin Panel → Auto-Dispatch Rules.`,
        422
      );
    }

    const settings = parseSettings(saSettings);

    console.log(`[dispatch-drivers] Settings loaded: start=${settings.search_radius_start_km}km, waves=${settings.wave1_size}/${settings.wave2_size}/${settings.wave3_size}, stacked=${settings.stacked_rides_enabled}, max_stacked=${settings.max_stacked_rides}`);

    // ====== EXPANDING RADIUS SEARCH + SCORING ======
    const radiusSteps = [
      settings.search_radius_start_km,
      settings.search_radius_expand_km,
      settings.search_radius_max_km,
    ];

    let allCandidates: ScoredCandidate[] = [];
    const offeredDriverIds = new Set<string>();
    let accepted = false;

    for (const radiusKm of radiusSteps) {
      if (accepted) break;

      const radiusMeters = radiusKm * 1000;
      console.log(`[dispatch-drivers] Searching radius ${radiusKm}km (${radiusMeters}m)`);

      // PostGIS query via RPC
      const { data: nearbyDrivers, error: nearbyErr } = await supabase.rpc("find_nearby_drivers", {
        p_lat: pickup_lat,
        p_lng: pickup_lng,
        p_radius_meters: radiusMeters,
        p_limit: settings.shortlist_limit,
        p_stale_seconds: 60,
      });

      if (nearbyErr) {
        console.error("[dispatch-drivers] PostGIS query error:", nearbyErr);
        continue;
      }

      if (!nearbyDrivers || nearbyDrivers.length === 0) {
        console.log(`[dispatch-drivers] No drivers at ${radiusKm}km`);
        continue;
      }

      const driverIds = nearbyDrivers.map((d: any) => d.driver_id);

      // Fetch driver details + category info
      const { data: driverDetails } = await supabase
        .from("drivers")
        .select("id, last_offer_at, last_trip_end_at, online_since, category_id, current_trip_id")
        .in("id", driverIds);

      // Fetch categories for category_priority (single source of truth)
      const { data: categories } = await supabase
        .from("driver_categories")
        .select("id, name, category_priority");

      const categoryMap = new Map<string, { name: string; priority: number }>();
      for (const cat of categories || []) {
        categoryMap.set(cat.id, { name: cat.name, priority: (cat as any).category_priority ?? 10 });
      }

      const driverMap = new Map<string, any>();
      for (const d of driverDetails || []) {
        driverMap.set(d.id, d);
      }

      // Filter by vehicle type if specified
      let eligibleIds = new Set(driverIds);
      if (vehicle_type_id) {
        const { data: vehicleCats } = await supabase
          .from("driver_vehicle_categories")
          .select("driver_id")
          .eq("vehicle_type_id", vehicle_type_id)
          .eq("is_enabled", true)
          .in("driver_id", driverIds);

        eligibleIds = new Set((vehicleCats || []).map((v: any) => v.driver_id));
      }

      // Exclude drivers with pending offers
      const { data: pendingOffers } = await supabase
        .from("ride_offers")
        .select("driver_id")
        .eq("status", "pending")
        .in("driver_id", driverIds)
        .gt("expires_at", new Date().toISOString());

      const busyIds = new Set((pendingOffers || []).map((o: any) => o.driver_id));

      // ====== STACKED RIDES: count active trips per driver ======
      // Build a map of driver_id → count of active trips for stacking eligibility
      const activeTripsCountMap = new Map<string, number>();
      if (settings.stacked_rides_enabled) {
        // Get drivers who have current_trip_id set (on active trip)
        const driversOnTrip = (driverDetails || []).filter((d: any) => d.current_trip_id);
        if (driversOnTrip.length > 0) {
          const onTripIds = driversOnTrip.map((d: any) => d.id);
          // Count active (non-completed, non-cancelled) trips per driver
          const { data: activeTripCounts } = await supabase
            .from("trips")
            .select("driver_id")
            .in("driver_id", onTripIds)
            .in("status", ["accepted", "driver_arriving", "arrived", "in_progress"]);

          for (const row of activeTripCounts || []) {
            activeTripsCountMap.set(row.driver_id, (activeTripsCountMap.get(row.driver_id) || 0) + 1);
          }
        }
      }

      // Score candidates using category_priority
      const candidates: ScoredCandidate[] = [];
      for (const nd of nearbyDrivers) {
        if (!eligibleIds.has(nd.driver_id)) continue;
        if (busyIds.has(nd.driver_id)) continue;
        if (offeredDriverIds.has(nd.driver_id)) continue;

        const detail = driverMap.get(nd.driver_id);
        if (!detail) continue;

        // ====== STACKED RIDES GATE ======
        const hasActiveTrip = !!detail.current_trip_id;
        let isStackedCandidate = false;

        if (hasActiveTrip) {
          // If stacked rides disabled → skip driver entirely
          if (!settings.stacked_rides_enabled) continue;

          // Check max stacked rides limit from Admin config
          const currentActiveCount = activeTripsCountMap.get(nd.driver_id) || 1;
          if (currentActiveCount >= settings.max_stacked_rides + 1) {
            // Already at max capacity (current trip + max stacked)
            console.log(`[dispatch-drivers] Driver ${nd.driver_id} at stacked limit (${currentActiveCount}/${settings.max_stacked_rides + 1})`);
            continue;
          }

          // Check minimum trip distance for stacking eligibility
          const distanceKm = nd.distance_meters / 1000;
          if (distanceKm > settings.stacked_min_trip_distance_km) {
            continue;
          }

          isStackedCandidate = true;
        }

        const distanceKm = nd.distance_meters / 1000;
        const waitingMin = Math.min(
          settings.max_waiting_bonus_minutes,
          minutesSince(detail.last_trip_end_at, detail.online_since)
        );

        const catInfo = detail.category_id ? categoryMap.get(detail.category_id) : null;
        const categoryPriority = catInfo?.priority ?? 10;

        const distancePenalty = distanceKm * settings.distance_penalty_per_km;
        const waitingBonus = isStackedCandidate ? 0 : waitingMin * settings.waiting_bonus_per_minute;

        let fairnessBoost = 0;
        if (!isStackedCandidate) {
          if (detail.last_offer_at) {
            const minSinceOffer = minutesSince(detail.last_offer_at, null);
            if (minSinceOffer >= settings.fairness_idle_minutes) {
              fairnessBoost = settings.fairness_boost_score;
            }
          } else {
            fairnessBoost = settings.fairness_boost_score;
          }
        }

        // PostGIS Dispatch Score
        const dispatchScore = categoryPriority + waitingBonus + fairnessBoost - distancePenalty;

        candidates.push({
          driver_id: nd.driver_id,
          distance_km: Math.round(distanceKm * 100) / 100,
          waiting_minutes: Math.round(waitingMin * 10) / 10,
          category_name: catInfo?.name ?? "Bronze",
          category_priority: categoryPriority,
          dispatch_score: Math.round(dispatchScore * 100) / 100,
          lat: nd.lat,
          lng: nd.lng,
          is_stacked: isStackedCandidate,
        });
      }

      // Sort by score DESC — idle drivers first, stacked drivers after
      candidates.sort((a, b) => {
        // Non-stacked (idle) always rank above stacked
        if (a.is_stacked !== b.is_stacked) return a.is_stacked ? 1 : -1;
        return b.dispatch_score - a.dispatch_score;
      });
      allCandidates = [...allCandidates, ...candidates];

      console.log(`[dispatch-drivers] ${candidates.length} scored candidates at ${radiusKm}km (${candidates.filter(c => c.is_stacked).length} stacked)`);

      // ====== WAVE DISPATCH ======
      const waves = [
        { size: settings.wave1_size, num: 1, expiry: settings.wave1_offer_expiry_seconds },
        { size: settings.wave2_size, num: 2, expiry: settings.wave2_offer_expiry_seconds },
        { size: settings.wave3_size, num: 3, expiry: settings.wave3_offer_expiry_seconds },
      ];

      let candidateIdx = 0;

      for (const wave of waves) {
        if (accepted || candidateIdx >= candidates.length) break;

        const waveDrivers = candidates.slice(candidateIdx, candidateIdx + wave.size);
        candidateIdx += wave.size;

        if (waveDrivers.length === 0) break;

        const waveExpirySeconds = wave.expiry;
        const expiresAt = new Date(Date.now() + waveExpirySeconds * 1000).toISOString();

        // Create ride_offers
        const offers = waveDrivers.map((c) => ({
          trip_id,
          driver_id: c.driver_id,
          status: "pending",
          distance_km: c.distance_km,
          expires_at: expiresAt,
        }));

        const { error: offerErr } = await supabase.from("ride_offers").insert(offers);
        if (offerErr) {
          console.error(`[dispatch-drivers] Wave ${wave.num} offer error:`, offerErr);
          continue;
        }

        // Update last_offer_at for offered drivers
        for (const c of waveDrivers) {
          offeredDriverIds.add(c.driver_id);
          await supabase
            .from("drivers")
            .update({ last_offer_at: new Date().toISOString() })
            .eq("id", c.driver_id);
        }

        console.log(`[dispatch-drivers] Wave ${wave.num}: sent ${waveDrivers.length} offers (expiry ${waveExpirySeconds}s, accept_timeout ${settings.accept_timeout_seconds}s)`);

        // Update trip status
        await supabase.from("trips").update({
          status: "offered",
          confirm_deadline_at: expiresAt,
          dispatch_status: `wave_${wave.num}`,
        }).eq("id", trip_id);

        // Wait for acceptance (poll)
        const waitStart = Date.now();
        while (Date.now() - waitStart < waveExpirySeconds * 1000) {
          await new Promise((r) => setTimeout(r, 1500)); // Poll every 1.5s

          const { data: acceptedOffer } = await supabase
            .from("ride_offers")
            .select("driver_id")
            .eq("trip_id", trip_id)
            .eq("status", "accepted")
            .maybeSingle();

          if (acceptedOffer) {
            accepted = true;
            console.log(`[dispatch-drivers] ACCEPTED by ${acceptedOffer.driver_id} in wave ${wave.num}`);
            break;
          }

          // Check if trip was cancelled
          const { data: tripCheck } = await supabase
            .from("trips")
            .select("status")
            .eq("id", trip_id)
            .single();

          if (tripCheck && ["cancelled", "accepted"].includes(tripCheck.status)) {
            accepted = tripCheck.status === "accepted";
            break;
          }
        }

        // Expire remaining pending offers from this wave
        if (!accepted) {
          await supabase
            .from("ride_offers")
            .update({ status: "expired", updated_at: new Date().toISOString() })
            .eq("trip_id", trip_id)
            .eq("status", "pending");
        }
      }

      if (accepted) break;
    }

    // Log top 10 candidates for admin debugging
    const topCandidates = allCandidates.slice(0, 10);
    if (topCandidates.length > 0) {
      const logEntries = topCandidates.map((c, idx) => ({
        trip_id,
        driver_id: c.driver_id,
        category_name: c.category_name,
        category_priority: c.category_priority,
        distance_km: c.distance_km,
        waiting_minutes: c.waiting_minutes,
        dispatch_score: c.dispatch_score,
        wave: offeredDriverIds.has(c.driver_id) ? (idx < settings.wave1_size ? 1 : idx < settings.wave1_size + settings.wave2_size ? 2 : 3) : null,
        offer_result: offeredDriverIds.has(c.driver_id)
          ? (accepted ? "SENT" : "TIMEOUT")
          : "SKIPPED",
      }));

      await supabase.from("dispatch_candidates_log").insert(logEntries);
    }

    if (!accepted) {
      await supabase.from("trips").update({
        status: "no_drivers",
        dispatch_status: "no_drivers_found",
      }).eq("id", trip_id);

      await logAuditEvent(supabase, "dispatch_no_drivers", {
        tripId: trip_id,
        details: { candidates_scored: allCandidates.length, offers_sent: offeredDriverIds.size },
        ipAddress: clientIP,
        userAgent,
      });

      return successResponse({
        dispatched: false,
        message: "No drivers available right now",
        subtext: "All nearby drivers are busy. Please try again shortly.",
        candidates_scored: allCandidates.length,
        offers_sent: offeredDriverIds.size,
      });
    }

    await logAuditEvent(supabase, "dispatch_success", {
      tripId: trip_id,
      details: { candidates_scored: allCandidates.length, offers_sent: offeredDriverIds.size },
      ipAddress: clientIP,
      userAgent,
    });

    return successResponse({
      dispatched: true,
      candidates_scored: allCandidates.length,
      offers_sent: offeredDriverIds.size,
      top_candidates: topCandidates.map((c) => ({
        driver_id: c.driver_id,
        category: c.category_name,
        category_priority: c.category_priority,
        distance_km: c.distance_km,
        waiting_minutes: c.waiting_minutes,
        score: c.dispatch_score,
        is_stacked: c.is_stacked,
      })),
    });
  } catch (err) {
    console.error("[dispatch-drivers] Error:", err);
    return errorResponse(err instanceof Error ? err.message : "Unknown error", 500);
  }
});
