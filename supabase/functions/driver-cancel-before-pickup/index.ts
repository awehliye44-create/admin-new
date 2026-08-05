/**
 * driver-cancel-before-pickup
 *
 * Production Edge for pre-start driver cancel → rematch.
 * Core mutation lives in _shared/executeDriverCancelRematch.ts (also used by stop-workflow).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { executeDriverCancelBeforePickupRematch } from "../_shared/executeDriverCancelRematch.ts";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("UNAUTHORIZED", "Unauthorized", 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: authError } = await supabase.auth.getUser(token);

    if (authError || !userData?.user) {
      return errorResponse("UNAUTHORIZED", "Unauthorized", 401);
    }

    const body = await req.json() as {
      tripId?: string;
      trip_id?: string;
      reason?: string;
      cancel_reason?: string;
      idempotency_key?: string;
      idempotencyKey?: string;
    };
    const tripId = body?.tripId ?? body?.trip_id;
    if (!tripId) {
      return errorResponse("VALIDATION", "Missing tripId", 400);
    }

    const reason = String(body?.reason ?? body?.cancel_reason ?? "").trim();
    if (!reason) {
      return errorResponse("REASON_REQUIRED", "Cancellation reason is required", 400);
    }

    console.log("DRIVER_CANCEL_PATH_ENTERED", JSON.stringify({
      trip_id: tripId,
      actor: "driver",
      edge: "driver-cancel-before-pickup",
      idempotency_key: body?.idempotency_key ?? body?.idempotencyKey ?? null,
    }));

    const { data: driver, error: driverError } = await supabase
      .from("drivers")
      .select("id, user_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (driverError || !driver) {
      return errorResponse("FORBIDDEN", "Driver not found", 403);
    }

    const result = await executeDriverCancelBeforePickupRematch(supabase, {
      tripId,
      driverId: driver.id,
      reason,
      source: "driver-cancel-before-pickup",
    });

    if (!result.ok) {
      return errorResponse(result.code, result.message, result.status);
    }

    return successResponse({
      success: true,
      ...result.detail,
    });
  } catch (e: unknown) {
    console.error("[driver-cancel-before-pickup]", e);
    const message = e instanceof Error ? e.message : "Unknown error";
    return errorResponse("INTERNAL_ERROR", message, 500);
  }
});
