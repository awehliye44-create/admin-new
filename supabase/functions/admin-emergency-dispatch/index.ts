import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { loadDispatchSettings } from "../_shared/dispatch-settings.ts";
import {
  invokeSqlDispatchTripOffersIfAllowed,
  isManualEmergencyDispatchOnly,
} from "../_shared/dispatchOrchestrator.ts";
import { recordDispatchWaveSnapshot } from "../_shared/recordDispatchWaveSnapshot.ts";
import { authorizeAdminEmergencyDispatch } from "../_shared/adminEmergencyDispatchAuth.ts";

Deno.serve(async (req) => {
  // handleCORSPreflight always returns 204 — only use it for OPTIONS.
  if (req.method === "OPTIONS") return handleCORSPreflight();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const gate = await authorizeAdminEmergencyDispatch(req, {
      supabaseUrl,
      anonKey: supabaseAnonKey,
    });
    if (!gate.ok) return gate.response;

    // Privileged database work starts only after JWT + user-scoped has_role succeed.
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => ({})) as {
      trip_id?: string;
      user_id?: string;
      actor_id?: string;
      actor_user_id?: string;
    };
    if (!body?.trip_id) {
      return errorResponse("BAD_REQUEST", "trip_id is required", 400);
    }
    // Spoofed actor fields are ignored. Authorization used gate.actorUserId only.
    void body.user_id;
    void body.actor_id;
    void body.actor_user_id;
    void gate.actorUserId;

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
