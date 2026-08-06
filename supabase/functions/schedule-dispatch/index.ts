import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  corsHeaders,
  successResponse,
  errorResponse,
  logAuditEvent,
} from "../_shared/security.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { assertPaymentGate, PaymentGateError } from "../_shared/paymentGate.ts";
import {
  computeNoPreconfirmedPriorityLeadMinutes,
  isPastNoPreconfirmedOverdueGrace,
  mapCommitmentPolicyFromDb,
  resolveNoPreconfirmedOverdueGraceMinutes,
  resolveScheduledDispatchPath,
  shouldAlertAdminForNoPreconfirmedEscalation,
  shouldStartNoPreconfirmedPriorityDispatch,
  SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
} from "../_shared/scheduledRidesPolicy.ts";
import { opsLog } from "../_shared/opsLog.ts";
import { cancelRevolutOrder } from "../_shared/revolutOrders.ts";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";

/**
 * schedule-dispatch
 *
 * Cron (every minute): no-preconfirmed scheduled bookings → priority instant offers
 * via auto-dispatch. Confirmed-driver commitment runtime stays separate.
 *
 * Policy:
 * - urgent_dispatch_trigger_minutes_before_pickup = LATEST permitted fallback start
 * - effective lead = max(dynamic ETA+buffers, fallback threshold)
 * - retry while within overdue grace; then unfulfilled + release + notify + incident
 */

const CANDIDATE_SCHEDULED_STATUSES = [
  "pending",
  "driver_assigned",
  "broadcasting",
  "scheduled",
  "awaiting_confirmation",
  "dispatching",
] as const;

async function estimateNearbyDriverEtaMinutes(
  supabase: SupabaseClient,
  trip: {
    pickup_latitude: number;
    pickup_longitude: number;
    vehicle_type_id: string | null;
    service_area_id: string | null;
  },
): Promise<number | null> {
  try {
    // Live schema: is_online + current_lat/lng (not status/current_latitude).
    let q = supabase
      .from("drivers")
      .select("id, current_lat, current_lng, service_area_id, is_online")
      .eq("is_online", true)
      .not("current_lat", "is", null)
      .not("current_lng", "is", null)
      .limit(60);
    if (trip.service_area_id) {
      q = q.eq("service_area_id", trip.service_area_id);
    }
    const { data: drivers } = await q;

    if (!drivers?.length) return null;

    const toRad = (d: number) => (d * Math.PI) / 180;
    const haversineKm = (aLat: number, aLng: number, bLat: number, bLng: number) => {
      const R = 6371;
      const dLat = toRad(bLat - aLat);
      const dLng = toRad(bLng - aLng);
      const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(x));
    };

    let bestMinutes: number | null = null;
    for (const d of drivers) {
      const lat = Number(d.current_lat);
      const lng = Number(d.current_lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const km = haversineKm(
        Number(trip.pickup_latitude),
        Number(trip.pickup_longitude),
        lat,
        lng,
      );
      // Conservative urban speed ~22 km/h → minutes
      const mins = (km / 22) * 60;
      if (bestMinutes == null || mins < bestMinutes) bestMinutes = mins;
    }
    return bestMinutes != null ? Math.ceil(bestMinutes) : null;
  } catch (err) {
    console.warn("[schedule-dispatch] nearby ETA estimate failed", err);
    return null;
  }
}

async function countPendingOffers(
  supabase: SupabaseClient,
  tripId: string,
): Promise<number> {
  const { count } = await supabase
    .from("ride_offers")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .eq("status", "pending");
  return count ?? 0;
}

async function hasAdminEscalationLogged(
  supabase: SupabaseClient,
  tripId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from("ops_logs")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .eq("error_code", "SCHEDULED_ADMIN_ESCALATION")
    .limit(1);
  return (count ?? 0) > 0;
}

async function invokeAutoDispatch(args: {
  supabaseUrl: string;
  serviceKey: string;
  tripId: string;
  source: string;
}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${args.supabaseUrl}/functions/v1/auto-dispatch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.serviceKey}`,
      apikey: args.serviceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      trip_id: args.tripId,
      force_rebroadcast: true,
      source: args.source,
    }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { ok: res.ok, status: res.status, body };
}

async function markUnfulfilledAndRelease(args: {
  supabase: SupabaseClient;
  tripId: string;
  customerId: string | null;
  reason: string;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  await args.supabase
    .from("trips")
    .update({
      scheduled_status: "unfulfilled",
      status: "cancelled",
      cancellation_reason: args.reason,
      cancelled_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", args.tripId)
    .eq("is_scheduled", true);

  // Best-effort payment hold release for Revolut sessions linked to this trip.
  try {
    let session: {
      id: string;
      provider_order_id: string | null;
      status: string | null;
      payment_provider: string | null;
    } | null = null;

    const byTrip = await args.supabase
      .from("payment_sessions")
      .select("id, provider_order_id, status, payment_provider")
      .eq("trip_id", args.tripId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    session = byTrip.data ?? null;

    if (!session) {
      const byMeta = await args.supabase
        .from("payment_sessions")
        .select("id, provider_order_id, status, payment_provider")
        .contains("metadata", { trip_id: args.tripId })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      session = byMeta.data ?? null;
    }

    if (
      session?.provider_order_id &&
      String(session.payment_provider ?? "").toLowerCase() === "revolut" &&
      !["captured", "released", "cancelled"].includes(String(session.status ?? ""))
    ) {
      const merchant = await resolveRevolutMerchantContext(args.supabase, "live");
      await cancelRevolutOrder(
        merchant.environment,
        merchant.secretKey,
        String(session.provider_order_id),
      );
      await args.supabase
        .from("payment_sessions")
        .update({
          status: "released",
          hold_release_state: "released",
          released_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", session.id);
    }
  } catch (err) {
    console.error("[schedule-dispatch] payment release failed", args.tripId, err);
  }

  await opsLog(args.supabase, {
    level: "error",
    source: "schedule-dispatch",
    message: `Scheduled booking unfulfilled: ${args.reason}`,
    event_type: "dispatch_timeout_exceeded",
    workflow_event_type: "dispatch_timeout_exceeded",
    severity: "critical",
    trip_id: args.tripId,
    customer_id: args.customerId,
    error_code: "SCHEDULED_UNFULFILLED",
    metadata: { reason: args.reason },
  });

  // Customer notification (best-effort)
  try {
    if (args.customerId) {
      await args.supabase.from("notifications").insert({
        target_user_id: args.customerId,
        target_audience: "specific_user",
        title: "Scheduled ride unavailable",
        message:
          "We could not find an available driver for your scheduled pickup. Any payment hold will be released.",
        type: "trip_scheduled_unfulfilled",
        category: "trip",
        priority: "high",
        metadata: { trip_id: args.tripId },
      });
    }
  } catch (err) {
    console.warn("[schedule-dispatch] customer notify failed", err);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Accept service-role JWT OR CRON_SECRET — cron_edge_auth_token() may differ
  // from edge env SUPABASE_SERVICE_ROLE_KEY; exact assertServiceRole rejected valid cron (403).
  const auth = await assertCronOrServiceRoleAuth(req);
  if (!auth.ok) return auth.response;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const now = new Date();
    console.log(`[schedule-dispatch] Running at ${now.toISOString()} auth=${auth.source}`);

    const { data: pendingTrips, error: tripsErr } = await supabase
      .from("trips")
      .select(
        "id, passenger_id, scheduled_at, pickup_latitude, pickup_longitude, vehicle_type_id, service_area_id, confirmed_driver_id, scheduled_status, status, driver_id, current_broadcast_round, max_broadcast_rounds",
      )
      .eq("is_scheduled", true)
      // Include 'expired' so a prior auto-dispatch max-rounds expire cannot
      // silently strand a no-preconfirmed scheduled booking outside this loop.
      .in("status", ["scheduled", "pending", "searching", "expired"])
      .in("scheduled_status", [...CANDIDATE_SCHEDULED_STATUSES])
      .is("driver_id", null)
      .not("scheduled_at", "is", null)
      .not("pickup_latitude", "is", null)
      .not("pickup_longitude", "is", null)
      .order("scheduled_at", { ascending: true })
      .limit(50);

    if (tripsErr) {
      console.error("[schedule-dispatch] Query error:", tripsErr);
      return errorResponse("Failed to query scheduled trips", 500);
    }

    if (!pendingTrips || pendingTrips.length === 0) {
      console.log("[schedule-dispatch] No pending scheduled trips found");
      return successResponse({ processed: 0, message: "No trips to dispatch", auth: auth.source });
    }

    console.log(`[schedule-dispatch] Found ${pendingTrips.length} candidate trips`);

    const { data: globalCfg } = await supabase
      .from("global_dispatch_settings")
      .select("*")
      .eq("singleton", true)
      .maybeSingle();

    if (!globalCfg) {
      return errorResponse(
        "No global_dispatch_settings row found. Configure in Admin Panel → Auto-Dispatch Rules.",
        422,
      );
    }

    const fallbackThreshold = Number(
      globalCfg.urgent_dispatch_trigger_minutes_before_pickup ?? 15,
    );
    const scheduledEnabled = Boolean(globalCfg.scheduled_rides_enabled);
    const urgentConversionEnabled = globalCfg.enable_scheduled_to_urgent_conversion !== false;
    const maxDispatchRounds = Math.max(
      1,
      Number(globalCfg.max_dispatch_rounds ?? 3),
    );
    const commitment = {
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      ...mapCommitmentPolicyFromDb(globalCfg as Record<string, unknown>),
    };
    const overdueGrace = resolveNoPreconfirmedOverdueGraceMinutes({
      checkInGraceMinutes: commitment.check_in_grace_minutes,
      scheduledResponseWindowMinutes: Number(
        globalCfg.scheduled_response_window_minutes ?? 8,
      ),
    });
    // Priority retry interval: cron is every 1 minute; next wave only after
    // pending offers clear (wave expiry from Admin Auto-Dispatch Rules).
    const priorityRetryIntervalMinutes = 1;

    let dispatched = 0;
    let skipped = 0;
    let errors = 0;
    let unfulfilled = 0;
    const results: Array<{ trip_id: string; action: string; detail?: string }> = [];

    for (const trip of pendingTrips) {
      try {
        const scheduledAt = new Date(trip.scheduled_at);
        const minutesUntilPickup = (scheduledAt.getTime() - now.getTime()) / 60000;

        if (!scheduledEnabled) {
          skipped++;
          results.push({ trip_id: trip.id, action: "skipped", detail: "scheduled_rides_disabled" });
          continue;
        }

        const dispatchPath = resolveScheduledDispatchPath({
          confirmedDriverId: trip.confirmed_driver_id,
          enableScheduledToUrgentConversion: urgentConversionEnabled,
        });
        if (dispatchPath !== "urgent_fallback") {
          skipped++;
          results.push({ trip_id: trip.id, action: "skipped", detail: dispatchPath });
          continue;
        }

        // Terminal: past overdue grace with no driver
        if (
          isPastNoPreconfirmedOverdueGrace({
            minutesUntilPickup,
            overdueGraceMinutes: overdueGrace,
          })
        ) {
          await markUnfulfilledAndRelease({
            supabase,
            tripId: trip.id,
            customerId: trip.passenger_id ?? null,
            reason: `no_driver_after_overdue_grace_${overdueGrace}m`,
          });
          unfulfilled++;
          results.push({
            trip_id: trip.id,
            action: "unfulfilled",
            detail: `overdue_grace_${overdueGrace}m`,
          });
          continue;
        }

        const nearbyEta = await estimateNearbyDriverEtaMinutes(supabase, {
          pickup_latitude: Number(trip.pickup_latitude),
          pickup_longitude: Number(trip.pickup_longitude),
          vehicle_type_id: trip.vehicle_type_id,
          service_area_id: trip.service_area_id,
        });

        const lead = computeNoPreconfirmedPriorityLeadMinutes({
          fallbackThresholdMinutes: fallbackThreshold,
          nearbyDriverEtaMinutes: nearbyEta,
          commitment,
        });

        if (
          !shouldStartNoPreconfirmedPriorityDispatch({
            minutesUntilPickup,
            effectiveLeadMinutes: lead.effectiveLeadMinutes,
          })
        ) {
          skipped++;
          results.push({
            trip_id: trip.id,
            action: "skipped",
            detail: `${minutesUntilPickup.toFixed(0)}min_away_need_${lead.effectiveLeadMinutes}m`,
          });
          continue;
        }

        if (
          shouldAlertAdminForNoPreconfirmedEscalation({
            minutesUntilPickup,
            adminEscalationLeadMinutes: commitment.admin_escalation_lead_minutes,
          })
        ) {
          const already = await hasAdminEscalationLogged(supabase, trip.id);
          if (!already) {
            await opsLog(supabase, {
              level: "warn",
              source: "schedule-dispatch",
              message: "Scheduled booking approaching pickup without confirmed driver",
              event_type: "dispatch_timeout_exceeded",
              workflow_event_type: "dispatch_timeout_exceeded",
              severity: "warning",
              trip_id: trip.id,
              customer_id: trip.passenger_id ?? null,
              error_code: "SCHEDULED_ADMIN_ESCALATION",
              metadata: {
                minutes_until_pickup: Math.round(minutesUntilPickup),
                effective_lead_minutes: lead.effectiveLeadMinutes,
                fallback_threshold_minutes: lead.fallbackThresholdMinutes,
                dynamic_lead_minutes: lead.dynamicRequiredLeadMinutes,
                nearby_eta_minutes: nearbyEta,
                max_dispatch_rounds: maxDispatchRounds,
                priority_retry_interval_minutes: priorityRetryIntervalMinutes,
              },
            });
          }
        }

        try {
          await assertPaymentGate(supabase, trip.id);
        } catch (e) {
          if (e instanceof PaymentGateError) {
            await supabase
              .from("trips")
              .update({
                scheduled_status: "payment_gate_blocked",
                updated_at: now.toISOString(),
              })
              .eq("id", trip.id);
            skipped++;
            results.push({ trip_id: trip.id, action: "payment_gate_blocked", detail: e.message });
            continue;
          }
          throw e;
        }

        const pendingOffers = await countPendingOffers(supabase, trip.id);
        if (pendingOffers > 0) {
          skipped++;
          results.push({
            trip_id: trip.id,
            action: "awaiting_offer_responses",
            detail: `pending_offers=${pendingOffers}`,
          });
          continue;
        }

        const roundsDone = Number(trip.current_broadcast_round ?? 0);
        // Do NOT call auto-dispatch past max waves — it would mark the trip
        // status=expired and bypass overdue-grace → unfulfilled handling.
        if (roundsDone >= maxDispatchRounds) {
          skipped++;
          results.push({
            trip_id: trip.id,
            action: "waves_exhausted_awaiting_grace",
            detail: `rounds=${roundsDone}/${maxDispatchRounds}`,
          });
          continue;
        }

        // Move into searchable instant-offer state without permanently locking out retries.
        // Recover 'expired' (max-rounds side-effect) back to searching for grace window.
        await supabase
          .from("trips")
          .update({
            status:
              trip.status === "scheduled" || trip.status === "expired"
                ? "searching"
                : trip.status,
            scheduled_status: "broadcasting",
            dispatch_mode: "scheduled",
            dispatch_status: "searching",
            max_broadcast_rounds: maxDispatchRounds,
            updated_at: now.toISOString(),
          })
          .eq("id", trip.id);

        const invoke = await invokeAutoDispatch({
          supabaseUrl,
          serviceKey: supabaseServiceKey,
          tripId: trip.id,
          source: "schedule-dispatch-no-preconfirmed-priority",
        });

        if (!invoke.ok) {
          const code = String(invoke.body.error ?? invoke.body.message ?? "unknown");
          // If auto-dispatch still reports max rounds, keep booking for grace terminal.
          if (code.includes("MAX_ROUNDS") || invoke.status === 400) {
            skipped++;
            results.push({
              trip_id: trip.id,
              action: "waves_exhausted_awaiting_grace",
              detail: code,
            });
          } else {
            errors++;
            results.push({
              trip_id: trip.id,
              action: "auto_dispatch_error",
              detail: `http_${invoke.status}:${code}`,
            });
          }
        } else {
          const offersCreated = Number(
            invoke.body.offers_created ??
              (invoke.body as { data?: { offers_created?: number } }).data?.offers_created ??
              0,
          );
          const skippedReason = String(invoke.body.reason ?? "");
          if (invoke.body.skipped && skippedReason === "pending_offers_exist") {
            skipped++;
            results.push({
              trip_id: trip.id,
              action: "awaiting_offer_responses",
              detail: "auto_dispatch_pending_offers",
            });
          } else {
            dispatched++;
            results.push({
              trip_id: trip.id,
              action: "auto_dispatched",
              detail: `offers=${offersCreated} lead=${lead.effectiveLeadMinutes}m eta=${nearbyEta ?? "n/a"} round=${roundsDone + 1}/${maxDispatchRounds}`,
            });
          }
        }

        await logAuditEvent(supabase, "schedule_dispatch_triggered", {
          tripId: trip.id,
          details: {
            minutes_to_pickup: Math.round(minutesUntilPickup),
            fallback_threshold_minutes: lead.fallbackThresholdMinutes,
            dynamic_lead_minutes: lead.dynamicRequiredLeadMinutes,
            effective_lead_minutes: lead.effectiveLeadMinutes,
            nearby_eta_minutes: nearbyEta,
            overdue_grace_minutes: overdueGrace,
            max_dispatch_rounds: maxDispatchRounds,
            priority_retry_interval_minutes: priorityRetryIntervalMinutes,
            auth_source: auth.source,
          },
        });
      } catch (tripErr) {
        console.error(`[schedule-dispatch] Error processing trip ${trip.id}:`, tripErr);
        errors++;
        results.push({
          trip_id: trip.id,
          action: "error",
          detail: tripErr instanceof Error ? tripErr.message : "unknown",
        });
      }
    }

    console.log(
      `[schedule-dispatch] Done: dispatched=${dispatched}, skipped=${skipped}, errors=${errors}, unfulfilled=${unfulfilled}`,
    );

    return successResponse({
      processed: pendingTrips.length,
      dispatched,
      skipped,
      errors,
      unfulfilled,
      auth: auth.source,
      results,
    });
  } catch (err) {
    console.error("[schedule-dispatch] Fatal error:", err);
    return errorResponse(err instanceof Error ? err.message : "Unknown error", 500);
  }
});
