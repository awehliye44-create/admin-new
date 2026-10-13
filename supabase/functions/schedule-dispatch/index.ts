import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  corsHeaders,
  successResponse,
  errorResponse,
  logAuditEvent,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
} from "../_shared/security.ts";
import { assertPaymentGate, PaymentGateError } from "../_shared/paymentGate.ts";
import { runScheduleDispatchConversionSweep } from "../_shared/scheduleDispatchConversionSweep.ts";

const RATE_LIMIT_CONFIG = {
  limit: 30,
  windowMs: 60_000,
  keyPrefix: "schedule-dispatch",
};

/**
 * pg_cron posts the project anon JWT (migration 20260330). assertServiceRole
 * 403'd every tick, so MK-260817 never converted at check-in. Same trust
 * model as scheduled-dispatch: rate-limit only. Vault-token cron is the
 * hardening follow-up (schedule_dispatch_sweep).
 */

async function triggerAutoDispatch(args: {
  supabaseUrl: string;
  supabaseServiceKey: string;
  tripId: string;
  triggerReason: string;
}): Promise<{ ok: boolean; data: unknown }> {
  const { supabaseUrl, supabaseServiceKey, tripId, triggerReason } = args;
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/auto-dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceKey}`,
        apikey: supabaseServiceKey,
      },
      body: JSON.stringify({
        trip_id: tripId,
        force_rebroadcast: true,
        trigger_reason: triggerReason,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error("[schedule-dispatch] auto-dispatch failed:", resp.status, data);
      return { ok: false, data };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("[schedule-dispatch] auto-dispatch exception:", err);
    return { ok: false, data: { error: String(err) } };
  }
}

/**
 * schedule-dispatch
 *
 * Cron-triggered (every 1 minute) — NO-PRECONFIRMED urgent fallback only:
 *  - No pre-confirmed driver: T−urgent convert to instant + wave (Admin fallback)
 *  - Confirmed driver: handled by scheduled-dispatch Local/Long T-minute NRO — NOT this Edge
 *
 * Customer bookings may be scheduled_status=`admin_held` / `scheduled` / `pending`.
 * Convert must flip dispatch_mode to instant and invoke auto-dispatch so Driver shows the nearby card.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) return rateLimitResponse(rateLimitResult);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const now = new Date();
    console.log(`[schedule-dispatch] Running at ${now.toISOString()}`);

    const sweep = await runScheduleDispatchConversionSweep({
      supabase,
      now,
      triggerAutoDispatch: (tripId, triggerReason) =>
        triggerAutoDispatch({ supabaseUrl, supabaseServiceKey, tripId, triggerReason }),
      assertPaymentGate: (tripId) => assertPaymentGate(supabase, tripId),
      isPaymentGateError: (err): err is Error => err instanceof PaymentGateError,
      logAudit: (event, payload) => logAuditEvent(supabase, event, payload),
    });

    if (!sweep.ok) {
      return errorResponse(sweep.error, sweep.status);
    }
    if (sweep.processed === 0) {
      return successResponse({ processed: 0, convertedToInstant: 0, message: sweep.message });
    }
    return successResponse({
      processed: sweep.processed,
      convertedToInstant: sweep.convertedToInstant,
      dispatched: sweep.dispatched,
      skipped: sweep.skipped,
      errors: sweep.errors,
      results: sweep.results,
    });
  } catch (err) {
    console.error("[schedule-dispatch] Fatal error:", err);
    return errorResponse(err instanceof Error ? err.message : "Unknown error", 500);
  }
});
