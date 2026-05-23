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

// Canonical offer table used by accept-trip and decline-trip
const OFFER_TABLE = "trip_offers";
// Canonical status values matching accept-trip/decline-trip
const STATUS_OFFERED = "offered";
const STATUS_ACCEPTED = "accepted";
const STATUS_EXPIRED = "expired";

interface DispatchSettings {
  start_radius_meters: number;
  expand_radius_meters: number;
  max_radius_meters: number;
  shortlist_limit: number;
  wave1_size: number;
  wave2_size: number;
  wave3_size: number;
  offer_expiry_seconds: number;
  wave1_offer_expiry_seconds: number;
  wave2_offer_expiry_seconds: number;
  wave3_offer_expiry_seconds: number;
  distance_penalty_per_meter: number;
  waiting_bonus_per_minute: number;
  max_waiting_bonus_minutes: number;
  fairness_idle_minutes: number;
  fairness_boost_score: number;
  accept_timeout_seconds: number;
  max_driver_find_time_minutes: number;
  // Stacked rides — Admin-configured (global)
  stacked_rides_enabled: boolean;
  max_stacked_rides: number;
  stacked_min_trip_distance_meters: number;
  stacked_max_detour_minutes: number;
  stacked_priority_mode: string;
  // System settings — operational flags
  simulate_mode: boolean;
  block_multiple_active_rides: boolean;
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
    start_radius_meters: Number(row.start_radius_meters),
    expand_radius_meters: Number(row.expand_radius_meters),
    max_radius_meters: Number(row.max_radius_meters),
    shortlist_limit: Number(row.shortlist_limit),
    wave1_size: Number(row.wave1_size),
    wave2_size: Number(row.wave2_size),
    wave3_size: Number(row.wave3_size),
    offer_expiry_seconds: Number(row.offer_expiry_seconds),
    wave1_offer_expiry_seconds: Number(row.wave1_offer_expiry_seconds),
    wave2_offer_expiry_seconds: Number(row.wave2_offer_expiry_seconds),
    wave3_offer_expiry_seconds: Number(row.wave3_offer_expiry_seconds),
    distance_penalty_per_meter: Number(row.distance_penalty_per_meter),
    waiting_bonus_per_minute: Number(row.waiting_bonus_per_minute),
    max_waiting_bonus_minutes: Number(row.max_waiting_bonus_minutes),
    fairness_idle_minutes: Number(row.fairness_idle_minutes),
    fairness_boost_score: Number(row.fairness_boost_score),
    accept_timeout_seconds: Number(row.accept_timeout_seconds),
    max_driver_find_time_minutes: Number(row.max_driver_find_time_minutes),
    stacked_rides_enabled: Boolean(row.stacked_rides_enabled),
    max_stacked_rides: Number(row.max_stacked_rides),
    stacked_min_trip_distance_meters: Number(row.stacked_min_trip_distance_meters),
    stacked_max_detour_minutes: Number(row.stacked_max_detour_minutes),
    stacked_priority_mode: String(row.stacked_priority_mode || "same_direction"),
    simulate_mode: Boolean(row.simulate_mode),
    block_multiple_active_rides: Boolean(row.block_multiple_active_rides),
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

    // ====== GLOBAL TIMEOUT TRACKING ======
    const dispatchStartTime = Date.now();

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

      const { error: offerErr } = await supabase.from(OFFER_TABLE).insert({
        trip_id,
        driver_id: assigned_driver_id,
        status: STATUS_OFFERED,
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

    // ====== LOAD GLOBAL DISPATCH SETTINGS (singleton, single source of truth) ======
    const { data: globalSettings, error: gsErr } = await supabase
      .from("global_dispatch_settings")
      .select("*")
      .eq("singleton", true)
      .maybeSingle();

    if (gsErr || !globalSettings) {
      return errorResponse(
        "No global_dispatch_settings row found. Configure in Admin Panel → Auto-Dispatch Rules.",
        422
      );
    }

    const settings = parseSettings(globalSettings);

    // ====== SIMULATE MODE ======
    if (settings.simulate_mode) {
      console.log(`[dispatch-drivers] SIMULATE MODE — no offers will be sent`);
    }

    // Edge function execution cap: 50s (Supabase ~60s limit)
    const EDGE_FUNCTION_SAFE_LIMIT_MS = 50_000;
    const adminMaxMs = settings.max_driver_find_time_minutes * 60 * 1000;
    const maxFindTimeMs = Math.min(adminMaxMs, EDGE_FUNCTION_SAFE_LIMIT_MS);

    console.log(
      `[dispatch-drivers] Settings: radii=${settings.start_radius_meters}/${settings.expand_radius_meters}/${settings.max_radius_meters}m, waves=${settings.wave1_size}/${settings.wave2_size}/${settings.wave3_size}, stacked=${settings.stacked_rides_enabled}, max_stacked=${settings.max_stacked_rides}, max_find_time=${settings.max_driver_find_time_minutes}min, simulate=${settings.simulate_mode}, block_multi=${settings.block_multiple_active_rides}`
    );

    // ====== EXPANDING RADIUS SEARCH + SCORING ======
    // Always use the CURRENT expanded radius on each iteration.
    const radiusStepsMeters: number[] = [
      settings.start_radius_meters,
      settings.expand_radius_meters,
      settings.max_radius_meters,
    ].filter((m, i, arr) => Number.isFinite(m) && m > 0 && (i === 0 || m > arr[i - 1]));

    let allCandidates: ScoredCandidate[] = [];
    const offeredDriverIds = new Set<string>();
    // Track which wave each driver was actually offered in
    const driverWaveMap = new Map<string, number>();
    let accepted = false;

    for (let stepIdx = 0; stepIdx < radiusStepsMeters.length; stepIdx++) {
      const radiusMeters = radiusStepsMeters[stepIdx];
      if (accepted) break;

      // ====== ENFORCE MAX FIND TIME ======
      const elapsedMs = Date.now() - dispatchStartTime;
      if (elapsedMs >= maxFindTimeMs) {
        console.log(`[dispatch-drivers] Max find time reached (${settings.max_driver_find_time_minutes}min) — stopping search`);
        break;
      }

      console.log(`[dispatch-drivers] Radius step ${stepIdx + 1}/${radiusStepsMeters.length}: searching ${radiusMeters}m`);


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
        console.log(`[dispatch-drivers] No drivers at ${radiusMeters}m`);
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

      // Exclude drivers with pending/offered offers (check BOTH tables for safety)
      const { data: pendingOffers } = await supabase
        .from(OFFER_TABLE)
        .select("driver_id")
        .eq("status", STATUS_OFFERED)
        .in("driver_id", driverIds)
        .gt("expires_at", new Date().toISOString());

      const busyIds = new Set((pendingOffers || []).map((o: any) => o.driver_id));

      // ====== STACKED RIDES: count active trips per driver ======
      const activeTripsCountMap = new Map<string, number>();
      if (settings.stacked_rides_enabled) {
        const driversOnTrip = (driverDetails || []).filter((d: any) => d.current_trip_id);
        if (driversOnTrip.length > 0) {
          const onTripIds = driversOnTrip.map((d: any) => d.id);
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

        // ====== BLOCK MULTIPLE ACTIVE RIDES ======
        const hasActiveTrip = !!detail.current_trip_id;

        if (hasActiveTrip && settings.block_multiple_active_rides) {
          continue; // Admin has blocked drivers from having multiple active rides
        }

        // ====== STACKED RIDES GATE ======
        let isStackedCandidate = false;

        if (hasActiveTrip) {
          if (!settings.stacked_rides_enabled) continue;

          const currentActiveCount = activeTripsCountMap.get(nd.driver_id) || 1;
          if (currentActiveCount >= settings.max_stacked_rides + 1) {
            console.log(`[dispatch-drivers] Driver ${nd.driver_id} at stacked limit (${currentActiveCount}/${settings.max_stacked_rides + 1})`);
            continue;
          }

          // Stacked min-trip-distance gate (compare meters directly — no km conversion)
          if (nd.distance_meters > settings.stacked_min_trip_distance_meters) {
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

        // Distance penalty applied per-meter (config in meters, all internal units in meters)
        const distancePenalty = nd.distance_meters * settings.distance_penalty_per_meter;
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

        // ====== CHECK MAX FIND TIME BEFORE EACH WAVE ======
        const waveElapsedMs = Date.now() - dispatchStartTime;
        if (waveElapsedMs >= maxFindTimeMs) {
          console.log(`[dispatch-drivers] Max find time reached before wave ${wave.num} — stopping`);
          break;
        }

        const waveDrivers = candidates.slice(candidateIdx, candidateIdx + wave.size);
        candidateIdx += wave.size;

        if (waveDrivers.length === 0) break;

        // Cap wave expiry to remaining time
        const remainingMs = maxFindTimeMs - (Date.now() - dispatchStartTime);
        const waveExpirySeconds = Math.min(wave.expiry, Math.floor(remainingMs / 1000));
        if (waveExpirySeconds <= 0) break;

        const expiresAt = new Date(Date.now() + waveExpirySeconds * 1000).toISOString();

        // ====== SIMULATE MODE: log but don't create offers ======
        if (settings.simulate_mode) {
          console.log(`[dispatch-drivers] SIMULATE: Wave ${wave.num} would send ${waveDrivers.length} offers: ${waveDrivers.map(c => c.driver_id).join(', ')}`);
          for (const c of waveDrivers) {
            offeredDriverIds.add(c.driver_id);
            driverWaveMap.set(c.driver_id, wave.num);
          }
          continue; // Skip actual offer creation in simulate mode
        }

        // Create offers in trip_offers (matching accept-trip/decline-trip)
        const offers = waveDrivers.map((c) => ({
          trip_id,
          driver_id: c.driver_id,
          status: STATUS_OFFERED,
          distance_km: c.distance_km,
          priority_score: c.dispatch_score,
          expires_at: expiresAt,
        }));

        const { error: offerErr } = await supabase.from(OFFER_TABLE).insert(offers);
        if (offerErr) {
          console.error(`[dispatch-drivers] Wave ${wave.num} offer error:`, offerErr);
          continue;
        }

        // Update last_offer_at for offered drivers
        for (const c of waveDrivers) {
          offeredDriverIds.add(c.driver_id);
          driverWaveMap.set(c.driver_id, wave.num);
          await supabase
            .from("drivers")
            .update({ last_offer_at: new Date().toISOString() })
            .eq("id", c.driver_id);
        }

        console.log(`[dispatch-drivers] Wave ${wave.num}: sent ${waveDrivers.length} offers (expiry ${waveExpirySeconds}s)`);

        // Update trip status
        await supabase.from("trips").update({
          status: "offered",
          confirm_deadline_at: expiresAt,
          dispatch_status: `wave_${wave.num}`,
        }).eq("id", trip_id);

        // Wait for acceptance (poll)
        const waitStart = Date.now();
        const pollDeadline = Math.min(waitStart + waveExpirySeconds * 1000, dispatchStartTime + maxFindTimeMs);

        while (Date.now() < pollDeadline) {
          await new Promise((r) => setTimeout(r, 1500)); // Poll every 1.5s

          const { data: acceptedOffer } = await supabase
            .from(OFFER_TABLE)
            .select("driver_id")
            .eq("trip_id", trip_id)
            .eq("status", STATUS_ACCEPTED)
            .maybeSingle();

          if (acceptedOffer) {
            accepted = true;
            console.log(`[dispatch-drivers] ACCEPTED by ${acceptedOffer.driver_id} in wave ${wave.num}`);
            break;
          }

          // Check if trip was cancelled or already accepted
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
            .from(OFFER_TABLE)
            .update({ status: STATUS_EXPIRED, updated_at: new Date().toISOString() })
            .eq("trip_id", trip_id)
            .eq("status", STATUS_OFFERED);
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
        wave: driverWaveMap.get(c.driver_id) ?? null,
        offer_result: offeredDriverIds.has(c.driver_id)
          ? (accepted ? "SENT" : "TIMEOUT")
          : "SKIPPED",
      }));

      await supabase.from("dispatch_candidates_log").insert(logEntries);
    }

    // ====== SIMULATE MODE: return results without modifying trip ======
    if (settings.simulate_mode) {
      console.log(`[dispatch-drivers] SIMULATE complete: ${allCandidates.length} candidates scored, ${offeredDriverIds.size} would-be offers`);
      return successResponse({
        dispatched: false,
        simulate: true,
        candidates_scored: allCandidates.length,
        offers_would_send: offeredDriverIds.size,
        top_candidates: allCandidates.slice(0, 10).map((c) => ({
          driver_id: c.driver_id,
          category: c.category_name,
          category_priority: c.category_priority,
          distance_km: c.distance_km,
          waiting_minutes: c.waiting_minutes,
          score: c.dispatch_score,
          is_stacked: c.is_stacked,
          wave: driverWaveMap.get(c.driver_id) ?? null,
        })),
        message: "Simulation complete — no offers sent",
      });
    }

    if (!accepted) {
      await supabase.from("trips").update({
        status: "no_drivers",
        dispatch_status: "no_drivers_found",
      }).eq("id", trip_id);

      await logAuditEvent(supabase, "dispatch_no_drivers", {
        tripId: trip_id,
        details: {
          candidates_scored: allCandidates.length,
          offers_sent: offeredDriverIds.size,
          elapsed_ms: Date.now() - dispatchStartTime,
          max_find_time_minutes: settings.max_driver_find_time_minutes,
        },
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
      details: {
        candidates_scored: allCandidates.length,
        offers_sent: offeredDriverIds.size,
        elapsed_ms: Date.now() - dispatchStartTime,
      },
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
