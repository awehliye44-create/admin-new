import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  jsonHeaders,
  securityHeaders,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { loadDispatchSettings } from "../_shared/dispatch-settings.ts";
import {
  invokeSqlDispatchTripOffersIfAllowed,
  isManualEmergencyDispatchOnly,
} from "../_shared/dispatchOrchestrator.ts";
import { recordDispatchWaveSnapshot } from "../_shared/recordDispatchWaveSnapshot.ts";

Deno.serve(async (req) => {
  const preflight = handleCORSPreflight(req);
  if (preflight) return preflight;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("UNAUTHORIZED", "Missing authorization", 401);
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(token);
    if (userError || !userData?.user) {
      return errorResponse("UNAUTHORIZED", "Invalid token", 401);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userData.user.id,
      _role: "admin",
    });
    if (!isAdmin) {
      return errorResponse("FORBIDDEN", "Admin role required", 403);
    }

    const body = await req.json() as { trip_id?: string };
    if (!body?.trip_id) {
      return errorResponse("BAD_REQUEST", "trip_id is required", 400);
    }

    const settings = await loadDispatchSettings(supabase, null);
    if (!isManualEmergencyDispatchOnly(settings)) {
      return errorResponse(
        "DISPATCH_DISABLED",
        "Set dispatch_settings.manual_emergency_dispatch_only=true (global row) before admin SQL dispatch",
        403,
      );
    }

    const { data: tripRow } = await supabase
      .from("trips")
      .select("current_broadcast_round, service_area_id")
      .eq("id", body.trip_id)
      .maybeSingle();

    const nextRound = (tripRow?.current_broadcast_round ?? 0) + 1;
    await recordDispatchWaveSnapshot(supabase, {
      tripId: body.trip_id,
      dispatchRound: nextRound,
      stage: "considered",
      driverId: null,
      source: "manual_admin",
      metadata: { wave_context: "admin_emergency_sql_dispatch" },
    });

    console.warn(
      "[admin-emergency-dispatch] emergency SQL dispatch requested",
      {
        trip_id: body.trip_id,
        service_area_id: tripRow?.service_area_id ?? null,
        next_round: nextRound,
      },
    );

    const result = await invokeSqlDispatchTripOffersIfAllowed(
      supabase,
      body.trip_id,
      tripRow?.service_area_id ?? null,
    );

    if (!result.ok) {
      return errorResponse("DISPATCH_FAILED", result.error ?? "dispatch failed", 500);
    }

    return successResponse({
      success: true,
      trip_id: body.trip_id,
      path: result.path,
      source: "manual_admin",
    });
  } catch (e) {
    console.error("[admin-emergency-dispatch]", e);
    return errorResponse("INTERNAL_ERROR", String(e), 500);
  }
});
