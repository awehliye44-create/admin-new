/**
 * Phase 5 — confirmed-driver JIT monitor + departure acknowledgement pass.
 *
 * Default: arm_ack (45s Heading to Pickup / Cancel) — never stamps driver_en_route without ack.
 * jit_auto_activate_enabled hard-locked false.
 * Offline/stale: still arm so driver can reconnect within countdown — no premature rescue.
 * Compatible active journey: defer arm; infeasible → conflict rematch (never interrupt passenger).
 * Reuses exclusive ride_offers insert for urgent audible NEW_RIDE_OFFER (OTA-compatible).
 */

import type { AnySupabaseClient } from "./supabaseClientTypes.ts";
import {
  isScheduledActivationDue,
  type ScheduledActivationConfig,
} from "./scheduledActivationSSOT.ts";
import {
  classifyDriverAvailabilityForJit,
  computeJitDepartureDeadlineMs,
  decideConfirmedScheduledActivation,
  effectiveJitPlanningHorizonMinutes,
  isWithinJitPlanningHorizon,
  reconcileStickyJitDeadline,
  resolveJitExecutionMode,
  resolveScheduledJitActivationConfig,
  validateJitEtaMinutes,
  type ScheduledJitActivationConfig,
} from "./scheduledJitActivationSSOT.ts";
import {
  buildDepartureAckArmPatch,
  buildExclusiveActivationArmPatch,
  isAlreadyConfirmedActivated,
} from "./scheduledConfirmedActivationSSOT.ts";
import { computeDepartureAckDeadlineMs } from "./scheduledDepartureAckSSOT.ts";
import {
  buildJitEtaUnresolvedOpsAlert,
  buildJitMonitorPersistPatch,
  evaluateJitDriverLocationFreshness,
  resolveJitDriverToPickupEta,
} from "./scheduledJitEtaMonitorSSOT.ts";
import {
  activeJourneyThreatensScheduledCommitment,
  evaluateScheduledCommitmentFeasibility,
} from "./scheduledCommitmentFeasibilitySSOT.ts";
import { assertPaymentGate, PaymentGateError } from "./paymentGate.ts";
import { resolvePaymentGateBlockedTrip } from "./paymentGateBlockedResolutionSSOT.ts";
import { assertAirportPricingReady } from "./scheduledMarketplaceHoldSSOT.ts";
import { evaluateConfirmedDriverExclusiveEligibility } from "./scheduledActivationExclusiveRescue.ts";
import {
  buildExclusiveActivationOfferSnapshot,
  resolveActivationGrossPenceForPreview,
  resolveExclusiveActivationDriverNetPence,
  SCHEDULED_ACTIVATION_EXCLUSIVE_REASON,
} from "./scheduledActivationExclusiveSSOT.ts";
import { isTripTerminalForDispatch, TERMINAL_TRIP_STATUS_POSTGREST_LIST } from "./tripTerminalDispatch.ts";
import { estimateEtaMinutes } from "./scheduledDispatchConfig.ts";

export type JitPassTrip = {
  id: string;
  scheduled_at: string;
  scheduled_status: string | null;
  status: string | null;
  confirmed_driver_id: string | null;
  driver_id: string | null;
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  estimated_duration_minutes?: number | null;
  driver_checked_in_at?: string | null;
  scheduled_hold_reason?: string | null;
  scheduled_jit_activate_at?: string | null;
  scheduled_jit_basis_scheduled_at?: string | null;
  scheduled_jit_eta_minutes?: number | null;
  scheduled_jit_eta_spike_samples?: number | null;
  scheduled_ack_status?: string | null;
  scheduled_ack_deadline_at?: string | null;
  broadcast_enabled?: boolean | null;
  airport_charge_pence?: number | null;
  passenger_id?: string | null;
  pickup_address?: string | null;
  service_area_id?: string | null;
  currency_code?: string | null;
  currency?: string | null;
  [key: string]: unknown;
};

async function loadDriverPresenceSnapshot(
  supabase: AnySupabaseClient,
  driverId: string,
  nowMs: number,
  presenceMaxAgeSeconds: number | null,
): Promise<{
  freshness: ReturnType<typeof evaluateJitDriverLocationFreshness>;
  currentTripId: string | null;
  firstName: string | null;
  presenceStatus: string | null;
}> {
  const { data: driver } = await supabase
    .from("drivers")
    .select("id, current_lat, current_lng, current_trip_id, first_name")
    .eq("id", driverId)
    .maybeSingle();

  const { data: presence } = await supabase
    .from("driver_presence")
    .select("lat, lng, last_heartbeat_at, last_location_at, status")
    .eq("driver_id", driverId)
    .maybeSingle();

  const lat = Number(presence?.lat ?? driver?.current_lat);
  const lng = Number(presence?.lng ?? driver?.current_lng);
  const hb = Date.parse(String(presence?.last_heartbeat_at ?? ""));
  const loc = Date.parse(String(presence?.last_location_at ?? ""));
  const lastSeenMs = [hb, loc].filter((n) => Number.isFinite(n)).reduce(
    (a, b) => Math.max(a, b),
    NaN,
  );

  return {
    freshness: evaluateJitDriverLocationFreshness({
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      lastSeenMs: Number.isFinite(lastSeenMs) ? lastSeenMs : null,
      nowMs,
      presenceMaxAgeSeconds,
    }),
    currentTripId: driver?.current_trip_id ? String(driver.current_trip_id) : null,
    firstName: driver?.first_name ? String(driver.first_name) : null,
    presenceStatus: presence?.status != null ? String(presence.status) : null,
  };
}

async function estimateRemainingActiveMinutes(
  supabase: AnySupabaseClient,
  activeTripId: string | null,
  nowMs: number,
): Promise<number> {
  if (!activeTripId) return 0;
  const { data: active } = await supabase
    .from("trips")
    .select(
      "id, status, estimated_duration_minutes, started_at",
    )
    .eq("id", activeTripId)
    .maybeSingle();
  if (!active) return 0;
  const status = String(active.status ?? "").toLowerCase();
  if (["completed", "cancelled", "customer_cancelled", "driver_cancelled", "no_show", "expired"].includes(status)) {
    return 0;
  }
  const dur = Number(active.estimated_duration_minutes);
  if (Number.isFinite(dur) && dur > 0) {
    const started = Date.parse(String(active.started_at ?? ""));
    if (Number.isFinite(started)) {
      const elapsedMin = Math.max(0, (nowMs - started) / 60_000);
      return Math.max(5, Math.ceil(dur - elapsedMin));
    }
    return Math.max(5, Math.ceil(dur));
  }
  return 30;
}

export async function runConfirmedJitActivationPass(input: {
  supabase: AnySupabaseClient;
  trips: JitPassTrip[];
  now: Date;
  nowMs: number;
  activationConfig: ScheduledActivationConfig;
  jitConfig: ScheduledJitActivationConfig;
  presenceMaxAgeSeconds: number | null;
  lockedDriverResponseMinutes: number;
  maxFindDriverMinutes: number;
  supabaseUrl: string;
  supabaseServiceKey: string;
  releaseAndRebroadcast: (args: {
    trip: JitPassTrip;
    reason: string;
    now: Date;
    nowMs: number;
    supabaseUrl: string;
    supabaseServiceKey: string;
    urgent: boolean;
    maxFindDriverMinutes: number;
    excludeDriverId: string;
  }) => Promise<void>;
  logSnapshot: (args: {
    tripId: string;
    action: string;
    stage: string;
    driverId?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}): Promise<{ activated: number; armed: number; monitored: number; rescued: number }> {
  const {
    supabase,
    trips,
    now,
    nowMs,
    activationConfig,
    jitConfig,
    presenceMaxAgeSeconds,
    lockedDriverResponseMinutes,
    maxFindDriverMinutes,
    supabaseUrl,
    supabaseServiceKey,
  } = input;

  const executionMode = resolveJitExecutionMode(jitConfig);
  let activated = 0;
  let armed = 0;
  let monitored = 0;
  let rescued = 0;

  for (const trip of trips) {
    if (isTripTerminalForDispatch(trip as any)) continue;
    if (!trip.pickup_latitude || !trip.pickup_longitude) continue;
    const confirmedDriverId = String(trip.confirmed_driver_id ?? "").trim();
    if (!confirmedDriverId) continue;

    if (
      isAlreadyConfirmedActivated({
        scheduledStatus: trip.scheduled_status,
        tripStatus: trip.status,
        driverId: trip.driver_id,
        confirmedDriverId,
      })
    ) {
      continue;
    }

    // Already armed — STEP 1a / expire-offers owns rescue; do not re-arm every minute.
    if (String(trip.scheduled_status) === "awaiting_activation_accept") {
      continue;
    }

    const holdReason = String(trip.scheduled_hold_reason ?? "").trim().toLowerCase();
    const intentionallyHeld =
      holdReason === "admin_exceptional" ||
      holdReason === "manual" ||
      String(trip.scheduled_status ?? "").toLowerCase() === "admin_held";

    const fixedDue = isScheduledActivationDue({
      scheduledAt: trip.scheduled_at,
      estimatedDurationMinutes: trip.estimated_duration_minutes,
      config: activationConfig,
      nowMs,
    });

    const presence = await loadDriverPresenceSnapshot(
      supabase,
      confirmedDriverId,
      nowMs,
      presenceMaxAgeSeconds,
    );

    let jitDeadlineMs: number | null = null;
    let jitKind = "jit";
    let etaSource = "none";
    let routingFailedWithFresh = false;

    const lastKnownEta = Number(trip.scheduled_jit_eta_minutes);
    const horizonMinutes = effectiveJitPlanningHorizonMinutes({
      config: jitConfig,
      lastKnownEtaMinutes: Number.isFinite(lastKnownEta) ? lastKnownEta : null,
      fixedLongActivationMinutes:
        activationConfig.longActivationMinutesBeforePickup,
    });
    const withinHorizon = isWithinJitPlanningHorizon({
      nowMs,
      scheduledAtMs: fixedDue.pickupMs,
      planningHorizonMinutes: horizonMinutes,
    });

    if (withinHorizon) {
      const eta = await resolveJitDriverToPickupEta({
        supabase,
        tripId: trip.id,
        pickupLat: Number(trip.pickup_latitude),
        pickupLng: Number(trip.pickup_longitude),
        freshness: presence.freshness,
      });

      if (eta.ok) {
        const hav = presence.freshness.fresh &&
            presence.freshness.lat != null &&
            presence.freshness.lng != null
          ? estimateEtaMinutes(
            presence.freshness.lat,
            presence.freshness.lng,
            trip.pickup_latitude,
            trip.pickup_longitude,
          )
          : null;
        const validated = validateJitEtaMinutes({
          proposedEtaMinutes: eta.etaMinutes,
          previousEtaMinutes: Number.isFinite(lastKnownEta) ? lastKnownEta : null,
          haversineEtaMinutes: hav,
          consecutiveElevatedSamples: Number(trip.scheduled_jit_eta_spike_samples) || 0,
          config: jitConfig,
        });
        const computed = computeJitDepartureDeadlineMs({
          scheduledAtMs: fixedDue.pickupMs,
          driverToPickupEtaMinutes: validated.acceptedEtaMinutes,
          config: jitConfig,
        });
        const prevMs = trip.scheduled_jit_activate_at
          ? Date.parse(String(trip.scheduled_jit_activate_at))
          : NaN;
        const basisMs = trip.scheduled_jit_basis_scheduled_at
          ? Date.parse(String(trip.scheduled_jit_basis_scheduled_at))
          : NaN;
        const sticky = reconcileStickyJitDeadline({
          previousDeadlineMs: Number.isFinite(prevMs) ? prevMs : null,
          candidateDeadlineMs: computed.deadlineMs,
          oscillationToleranceMinutes: jitConfig.oscillationToleranceMinutes,
          basisScheduledAtMs: Number.isFinite(basisMs) ? basisMs : null,
          currentScheduledAtMs: fixedDue.pickupMs,
        });
        jitDeadlineMs = sticky.deadlineMs;
        jitKind = computed.kind;
        etaSource = eta.source;
        monitored++;

        if (sticky.changed || validated.rejectedSpike) {
          await supabase
            .from("trips")
            .update({
              ...buildJitMonitorPersistPatch({
                deadlineMs: sticky.deadlineMs,
                etaMinutes: validated.acceptedEtaMinutes,
                kind: computed.kind,
                etaSource: eta.source,
                basisScheduledAtIso: trip.scheduled_at,
                nowIso: now.toISOString(),
              }),
              scheduled_jit_eta_spike_samples: validated.consecutiveElevatedSamples,
            })
            .eq("id", trip.id)
            .is("driver_id", null);
        }
      } else {
        if (presence.freshness.fresh) routingFailedWithFresh = true;
        try {
          const alert = buildJitEtaUnresolvedOpsAlert({
            tripId: trip.id,
            driverId: confirmedDriverId,
            reason: eta.reason,
            nowIso: now.toISOString(),
          });
          await supabase.from("ops_alerts").upsert(
            {
              fingerprint: alert.fingerprint,
              title: alert.title,
              related_trip_id: alert.related_trip_id,
              metadata: alert.metadata,
              status: "open",
              updated_at: now.toISOString(),
            },
            { onConflict: "fingerprint" },
          );
        } catch (opsErr) {
          console.warn("[jit-activation] ops_alert upsert failed", opsErr);
        }
      }
    }

    const remaining = await estimateRemainingActiveMinutes(
      supabase,
      presence.currentTripId,
      nowMs,
    );
    const travelFromCompletion = (() => {
      if (
        presence.freshness.fresh &&
        presence.freshness.lat != null &&
        presence.freshness.lng != null
      ) {
        return estimateEtaMinutes(
          presence.freshness.lat,
          presence.freshness.lng,
          trip.pickup_latitude,
          trip.pickup_longitude,
        ) ?? 30;
      }
      return 30;
    })();

    const feasibility = evaluateScheduledCommitmentFeasibility({
      nowMs,
      remainingJourneyMinutes: remaining,
      travelToPickupEtaMinutes: travelFromCompletion,
      scheduledAtMs: fixedDue.pickupMs,
      config: jitConfig,
    });
    const threat = activeJourneyThreatensScheduledCommitment({
      hasActiveJourney: Boolean(presence.currentTripId),
      feasibility,
    });

    const availability = classifyDriverAvailabilityForJit({
      presenceStatus: presence.presenceStatus,
      locationFresh: presence.freshness.fresh,
      locationReason: presence.freshness.reason,
      hasActiveJourney: Boolean(presence.currentTripId),
      routingFailedWithFreshLocation: routingFailedWithFresh,
    });

    const decision = decideConfirmedScheduledActivation({
      nowMs,
      scheduledAtMs: fixedDue.pickupMs,
      jitDeadlineMs,
      fixedFallbackDue: fixedDue.due,
      fixedFallbackActivationAtMs: fixedDue.activationAtMs,
      fixedFallbackKind: fixedDue.kind,
      intentionallyHeld,
      holdReason,
      activeJourneyThreatensCommitment: threat.threatens,
      activeJourneyThreatReason: threat.reason ?? undefined,
      // Compatible active journey: retain assignment; reassess after dropoff.
      // Do not start 45s countdown while completing a compatible journey.
      deferForCompatibleActiveJourney:
        Boolean(presence.currentTripId) && feasibility.feasible && !threat.threatens,
      availabilityClass: availability,
      executionMode,
      departureAckCountdownSeconds: jitConfig.departureAckSeconds,
    });

    if (decision.action === "wait" || decision.action === "hold_skip") {
      continue;
    }

    // Only infeasible commitment (or explicit conflict) rescues — never premature
    // offline rescue before Phase 5 acknowledgement opportunity.
    if (decision.action === "conflict_rescue") {
      console.log("SCHEDULED_JIT_RESCUE", {
        trip_id: trip.id,
        driver_id: confirmedDriverId,
        action: decision.action,
        reason: decision.reason,
      });
      await input.releaseAndRebroadcast({
        trip,
        reason: SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.ineligibleBypass,
        now,
        nowMs,
        supabaseUrl,
        supabaseServiceKey,
        urgent: true,
        maxFindDriverMinutes,
        excludeDriverId: confirmedDriverId,
      });
      rescued++;
      continue;
    }

    // Shared gates before arm or activate
    try {
      await assertPaymentGate(supabase, trip.id);
    } catch (gateErr) {
      const detail = gateErr instanceof PaymentGateError
        ? gateErr.message
        : String((gateErr as Error)?.message ?? gateErr);
      console.warn("[jit-activation] payment gate blocked", { trip_id: trip.id, detail });
      await supabase
        .from("trips")
        .update({
          scheduled_status: "payment_gate_blocked",
          updated_at: now.toISOString(),
        })
        .eq("id", trip.id);
      try {
        await resolvePaymentGateBlockedTrip(supabase, trip.id);
      } catch {
        /* best-effort */
      }
      continue;
    }

    const airportReady = assertAirportPricingReady({
      broadcastEnabled: trip.broadcast_enabled,
      airportChargePence: trip.airport_charge_pence as number | null | undefined,
      scheduledHoldReason: trip.scheduled_hold_reason,
    });
    if (!airportReady.ok) {
      await supabase
        .from("trips")
        .update({
          scheduled_status: "admin_held",
          scheduled_hold_reason: "airport_pricing",
          updated_at: now.toISOString(),
        })
        .eq("id", trip.id)
        .is("driver_id", null);
      continue;
    }

    const isDepartureAck = decision.action === "arm_ack";
    const eligibility = await evaluateConfirmedDriverExclusiveEligibility(supabase, {
      driverId: confirmedDriverId,
      tripId: trip.id,
      nowMs,
      allowOnTrip: Boolean(presence.currentTripId),
      // Phase 5: offline/stale still get acknowledgement opportunity.
      allowOfflineForDepartureAck: isDepartureAck || executionMode === "departure_ack",
    });
    if (!eligibility.eligible) {
      await input.releaseAndRebroadcast({
        trip,
        reason: SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.ineligibleBypass,
        now,
        nowMs,
        supabaseUrl,
        supabaseServiceKey,
        urgent: true,
        maxFindDriverMinutes,
        excludeDriverId: confirmedDriverId,
      });
      rescued++;
      continue;
    }

    if (decision.action === "arm_ack" || decision.action === "arm_exclusive_nro") {
      const departureAck = decision.action === "arm_ack";
      const countdownSeconds = departureAck
        ? Math.max(
          1,
          Math.floor(
            (decision as { countdownSeconds?: number }).countdownSeconds ??
              jitConfig.departureAckSeconds,
          ),
        )
        : Math.max(1, Number(lockedDriverResponseMinutes ?? 3)) * 60;
      const ackDeadlineMs = departureAck
        ? computeDepartureAckDeadlineMs({
          nowMs,
          countdownSeconds,
        })
        : nowMs + countdownSeconds * 1000;
      const expiresAt = new Date(ackDeadlineMs).toISOString();
      const ackNonce = crypto.randomUUID();

      let computedPreview: number | null = null;
      const stampedNet = resolveExclusiveActivationDriverNetPence({ trip: trip as any });
      if (stampedNet == null) {
        const gross = resolveActivationGrossPenceForPreview(trip as any);
        if (gross != null && trip.service_area_id) {
          const { data: preview } = await supabase.rpc(
            "compute_driver_net_preview_from_gross",
            {
              p_gross_pence: gross,
              p_driver_id: confirmedDriverId,
              p_service_area_id: trip.service_area_id,
              p_airport_charge_pence: Number(trip.airport_charge_pence ?? 0) || 0,
            },
          );
          const n = Number(preview);
          computedPreview = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
        }
      }
      const netPence = resolveExclusiveActivationDriverNetPence({
        trip: trip as any,
        computedPreviewPence: computedPreview,
      });
      if (netPence == null || netPence <= 0) {
        await input.releaseAndRebroadcast({
          trip,
          reason: SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.netUnavailableBypass,
          now,
          nowMs,
          supabaseUrl,
          supabaseServiceKey,
          urgent: true,
          maxFindDriverMinutes,
          excludeDriverId: confirmedDriverId,
        });
        rescued++;
        continue;
      }

      const offerSnapshot = buildExclusiveActivationOfferSnapshot({
        trip: trip as any,
        confirmedDriverId,
        netPence,
        kind: decision.kind,
        expiresAtIso: expiresAt,
        departureAcknowledgement: departureAck,
        ackNonce: departureAck ? ackNonce : null,
      });

      const { data: offerRows, error: offerErr } = await supabase
        .from("ride_offers")
        .insert({
          trip_id: trip.id,
          driver_id: confirmedDriverId,
          status: "pending",
          offered_at: now.toISOString(),
          expires_at: expiresAt,
          offered_driver_net_pence: netPence,
          is_urgent_dispatch: false,
          is_stacked: eligibility.isStacked,
          offer_snapshot: offerSnapshot,
        })
        .select("id");

      if (offerErr || !offerRows?.length) {
        await input.releaseAndRebroadcast({
          trip,
          reason: SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.insertBlockedBypass,
          now,
          nowMs,
          supabaseUrl,
          supabaseServiceKey,
          urgent: true,
          maxFindDriverMinutes,
          excludeDriverId: confirmedDriverId,
        });
        rescued++;
        continue;
      }

      const offerId = String(offerRows[0].id);
      const armPatch = departureAck
        ? buildDepartureAckArmPatch({
          nowIso: now.toISOString(),
          deadlineIso: expiresAt,
          driverId: confirmedDriverId,
          nonce: ackNonce,
        })
        : buildExclusiveActivationArmPatch({ nowIso: now.toISOString() });

      const { data: armedRows, error: armErr } = await supabase
        .from("trips")
        .update(armPatch)
        .eq("id", trip.id)
        .is("completed_at", null)
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .in("scheduled_status", ["scheduled", "driver_assigned", "scheduled_committed"])
        .is("driver_id", null)
        .select("id");

      if (armErr || !armedRows?.length) {
        await supabase
          .from("ride_offers")
          .update({ status: "cancelled", updated_at: now.toISOString() })
          .eq("id", offerId);
        continue;
      }

      const logAction = departureAck
        ? "scheduled_jit_arm_departure_ack"
        : "scheduled_jit_arm_exclusive_nro";
      await input.logSnapshot({
        tripId: trip.id,
        action: logAction,
        stage: "offer_inserted",
        driverId: confirmedDriverId,
        metadata: {
          source: decision.source,
          kind: decision.kind,
          deadline_at: new Date(decision.deadlineMs).toISOString(),
          eta_source: etaSource,
          jit_kind: jitKind,
          execution_mode: executionMode,
          phase5_ack_deadline_at: departureAck ? expiresAt : null,
          departure_acknowledgement: departureAck,
          offer_id: offerId,
          ack_nonce: departureAck ? ackNonce : null,
        },
      });
      console.log(
        departureAck ? "SCHEDULED_JIT_ARM_DEPARTURE_ACK" : "SCHEDULED_JIT_ARM_EXCLUSIVE_NRO",
        {
          trip_id: trip.id,
          offer_id: offerId,
          driver_id: confirmedDriverId,
          source: decision.source,
          ack_deadline_at: departureAck ? expiresAt : null,
        },
      );
      armed++;
      continue;
    }

    // activate_now must never run — en_route only after Heading to Pickup.
    console.warn("[jit-activation] unexpected decision ignored (Phase 5 fail-closed)", {
      trip_id: trip.id,
      action: (decision as { action?: string }).action,
    });
  }

  return { activated, armed, monitored, rescued };
}

export function resolveJitConfigFromSettingsRow(
  row: Record<string, unknown> | null | undefined,
): ScheduledJitActivationConfig {
  return resolveScheduledJitActivationConfig(row as any);
}
