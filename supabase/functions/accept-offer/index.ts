import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  securityHeaders,
  jsonHeaders,
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import {
  assertCanAcceptOfferByDriverIdFast,
  driverNotEligibleResponse,
  logDriverEligibilityBlocked,
  type AcceptEligibilityDriverRow,
} from "../_shared/driverEligibility.ts";
import { recordDispatchWaveSnapshot } from "../_shared/recordDispatchWaveSnapshot.ts";
import {
  STACKED_RIDE_DISABLED_SAFE_GUARD,
  resolveStackedActiveRemainingMinutes,
} from "../_shared/stackedRideConfig.ts";
import { resolveDriverActiveTripId } from "../_shared/activeDriverTripGuard.ts";
import { STACKED_RIDE_STATES } from "../_shared/stackedRideState.ts";
import {
  logRequestDuration,
  startRequestTimer,
  withDuration,
  createRequestId,
  finishEdgeRequestLog,
} from "../_shared/edgeRequestTiming.ts";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";
import { writePayableSnapshotOrLog } from "../_shared/writePayableSnapshotOrLogSSOT.ts";
import {
  buildMinimalAcceptedTripSeed,
  createAcceptOfferPerfClock,
  markLockIdempotencySkipped,
  markPostAssignmentEnrichmentSkipped,
  markScheduledGuardSkipped,
  notifyCustomerAssignedWithRetry,
  scheduleAcceptOfferBackground,
  type AcceptPostCanonicalOutcome,
} from "./lib/acceptOfferPerf.ts";
import { opsLog } from "../_shared/opsLog.ts";
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";
import {
  evaluateInstantOfferScheduledCommitmentGate,
  loadDriverConfirmedScheduledCommitments,
} from "../_shared/scheduledCommitmentOfferGateSSOT.ts";
import { ensureNegotiationPayableAuthorised } from "../_shared/negotiationPayableAuthorisation.ts";
import { isAcceptDeclineB3Enabled } from "../_shared/acceptDeclineB3SSOT.ts";

interface AcceptRequest {
  offer_id: string;
  driver_id: string;
  is_stacked?: boolean;
  current_trip_id?: string;
  /** Client↔Edge correlation id for Accept waterfall telemetry. */
  perf_id?: string;
}

// Rate limit config: 30 requests per minute per IP (accept actions should be limited)
const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60000, keyPrefix: 'accept-offer' };

/** Business-rule failure — HTTP 200 so Capacitor clients read JSON instead of transport errors. */
function businessFailureResponse(
  error: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return successResponse({ success: false, error, message, ...extra });
}

/**
 * Fire-and-forget RIDE_STOP push to dismiss native notification on driver's device.
 */
async function sendRideStopPush(
  supabaseUrl: string,
  serviceKey: string,
  driverId: string,
  reason: string,
  ids?: { offer_id?: string; trip_id?: string },
) {
  const data: Record<string, string> = {
    stopReason: reason,
    stop_reason: reason,
  };
  if (ids?.offer_id) {
    data.offer_id = ids.offer_id;
    data.offerId = ids.offer_id;
  }
  if (ids?.trip_id) {
    data.trip_id = ids.trip_id;
    data.tripId = ids.trip_id;
    data.booking_id = ids.trip_id;
    data.bookingId = ids.trip_id;
  }

  const resp = await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      driverId,
      type: "RIDE_STOP",
      title: "Ride Update",
      body: reason === "accepted" ? "Ride accepted" : "Ride no longer available",
      data,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.warn(`[accept-offer] RIDE_STOP push response ${resp.status}: ${errText}`);
  }
}

/**
 * Accept Offer Edge Function
 * 
 * Uses database-level advisory locks to prevent race conditions.
 * Only ONE driver can successfully accept a ride - all others get rejected.
 * 
 * Security features:
 * - JWT authentication (driver identity derived from token)
 * - Rate limiting (30 req/min per IP)
 * - Input validation (UUID format)
 * - Security headers
 */
Deno.serve(async (req) => {
  const elapsed = startRequestTimer();
  const requestId = createRequestId();
  const perf = createAcceptOfferPerfClock(elapsed);
  perf.mark("edge_receive");
  console.log("[accept-offer] Received request:", req.method);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  // Rate limiting
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.log("[accept-offer] Rate limited:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── Authenticate caller ──
    perf.mark("auth_start");
    const auth = await requireAuthenticatedUser(req, supabaseUrl, anonKey);
    if (!auth.ok) return auth.response;
    const userId = auth.userId;

    // Resolve driver_id + eligibility + location/active-trip hint (one SELECT).
    // #69A: current_trip_id / lat / lng avoid later redundant drivers reads.
    const { data: authDriver, error: authDriverErr } = await supabase
      .from("drivers")
      .select(
        "id, user_id, approval_status, driver_status, documents_approved, is_online, email_verified, phone_verified, pending_phone_change, pending_phone_change_verified_at, pending_phone_change_requested_at, pending_phone_change_expires_at, current_trip_id, current_lat, current_lng",
      )
      .eq("user_id", userId)
      .is("deleted_at", null)
      .single();

    if (authDriverErr || !authDriver) {
      return errorResponse("UNAUTHORIZED", "No driver profile found for authenticated user", 403);
    }

    const authenticatedDriverId = authDriver.id;
    perf.mark("auth_end");

    const body: AcceptRequest = await req.json();
    const { offer_id, is_stacked, current_trip_id } = body;
    const perfId =
      typeof body.perf_id === "string" && body.perf_id.trim()
        ? body.perf_id.trim().slice(0, 64)
        : requestId;

    // Use authenticated driver_id, reject if body driver_id doesn't match
    if (body.driver_id && body.driver_id !== authenticatedDriverId) {
      console.error("[accept-offer] driver_id mismatch: body=", body.driver_id, "auth=", authenticatedDriverId);
      return errorResponse("FORBIDDEN", "driver_id does not match authenticated user", 403);
    }

    const driver_id = authenticatedDriverId;
    const b3Parallel = isAcceptDeclineB3Enabled();

    console.log("[accept-offer] Processing:", {
      offer_id,
      driver_id,
      is_stacked,
      current_trip_id,
      perf_id: perfId,
      b3: b3Parallel,
    });

    // Input validation
    const validationErrors: Record<string, string> = {};
    
    if (!offer_id) {
      validationErrors.offer_id = "offer_id is required";
    } else if (!isValidUUID(offer_id)) {
      validationErrors.offer_id = "offer_id must be a valid UUID";
    }
    
    if (current_trip_id && !isValidUUID(current_trip_id)) {
      validationErrors.current_trip_id = "current_trip_id must be a valid UUID";
    }
    
    if (Object.keys(validationErrors).length > 0) {
      return validationErrorResponse(validationErrors);
    }

    // Single ride_offers fetch — covers stacked path (expires_at, broadcast_round)
    // and normal path (is_urgent_dispatch, negotiation fields). Eliminates two
    // duplicate SELECTs that previously ran further down both code paths.
    // B3 ON: eligibility docs RPC ∥ offer lookup (independent; same allow/deny).
    type PendingOfferRow = {
      trip_id?: string | null;
      status?: string | null;
      is_stacked?: boolean | null;
      expires_at?: string | null;
      broadcast_round?: number | null;
      is_urgent_dispatch?: boolean | null;
      negotiation_status?: string | null;
      driver_offer_fare?: number | null;
      customer_counter_fare?: number | null;
    };
    let pendingOffer: PendingOfferRow | null = null;

    perf.mark("eligibility_validation_start");
    if (b3Parallel) {
      perf.mark("offer_lookup_start");
      const [acceptEligibility, offerLookup] = await Promise.all([
        assertCanAcceptOfferByDriverIdFast(supabase, driver_id, {
          driverRow: authDriver as AcceptEligibilityDriverRow,
          mark: (stage) => perf.mark(stage),
        }),
        supabase
          .from("ride_offers")
          .select(
            "trip_id, status, is_stacked, expires_at, broadcast_round, " +
              "is_urgent_dispatch, negotiation_status, driver_offer_fare, customer_counter_fare",
          )
          .eq("id", offer_id)
          .eq("driver_id", driver_id)
          .maybeSingle(),
      ]);
      perf.mark("offer_lookup_end");
      perf.mark("eligibility_validation_end");
      if (!acceptEligibility.allowed) {
        logDriverEligibilityBlocked("accept-offer", driver_id, acceptEligibility);
        return driverNotEligibleResponse(acceptEligibility, jsonHeaders);
      }
      pendingOffer = (offerLookup.data as PendingOfferRow | null) ?? null;
    } else {
      const acceptEligibility = await assertCanAcceptOfferByDriverIdFast(
        supabase,
        driver_id,
        {
          driverRow: authDriver as AcceptEligibilityDriverRow,
          mark: (stage) => perf.mark(stage),
        },
      );
      if (!acceptEligibility.allowed) {
        logDriverEligibilityBlocked("accept-offer", driver_id, acceptEligibility);
        return driverNotEligibleResponse(acceptEligibility, jsonHeaders);
      }
      perf.mark("eligibility_validation_end");

      perf.mark("offer_lookup_start");
      const { data: offerRow } = await supabase
        .from("ride_offers")
        .select(
          "trip_id, status, is_stacked, expires_at, broadcast_round, " +
            "is_urgent_dispatch, negotiation_status, driver_offer_fare, customer_counter_fare",
        )
        .eq("id", offer_id)
        .eq("driver_id", driver_id)
        .maybeSingle();
      pendingOffer = (offerRow as PendingOfferRow | null) ?? null;
      perf.mark("offer_lookup_end");
    }

    // Pre-hold + candidate geometry in one trips SELECT (#69A: was two reads).
    // Backend SSOT for hold remains trips.negotiation_owner_driver_id; RPC
    // revalidates at commit. SQL commitment gate remains the atomic race SSOT.
    let knownPassengerId: string | null = null;
    type HoldTripRow = {
      status?: string | null;
      negotiation_owner_driver_id?: string | null;
      passenger_id?: string | null;
      estimated_duration_minutes?: number | null;
      dropoff_latitude?: number | null;
      dropoff_longitude?: number | null;
      pickup_latitude?: number | null;
      pickup_longitude?: number | null;
    };
    let holdTrip: HoldTripRow | null = null;
    if (pendingOffer?.trip_id) {
      perf.mark("lock_idempotency_start");
      const { data: holdTripRow } = await supabase
        .from("trips")
        .select(
          "status, negotiation_owner_driver_id, passenger_id, estimated_duration_minutes, dropoff_latitude, dropoff_longitude, pickup_latitude, pickup_longitude",
        )
        .eq("id", pendingOffer.trip_id)
        .maybeSingle();
      holdTrip = (holdTripRow as HoldTripRow | null) ?? null;
      const ownerId = holdTrip?.negotiation_owner_driver_id ?? null;
      const tripStatus = String(holdTrip?.status ?? "");
      if (typeof holdTrip?.passenger_id === "string") {
        knownPassengerId = holdTrip.passenger_id.trim() || null;
      }
      if (
        (ownerId && ownerId !== driver_id) ||
        (tripStatus === "negotiating" && ownerId !== driver_id)
      ) {
        perf.mark("lock_idempotency_end");
        console.log("[accept-offer] BLOCKED_NEGOTIATION_HELD", {
          offer_id,
          driver_id,
          owner_driver_id: ownerId,
          trip_status: tripStatus,
        });
        return businessFailureResponse(
          "NEGOTIATION_HELD",
          "This trip is held for another driver",
          { trip_id: pendingOffer.trip_id, owner_driver_id: ownerId },
        );
      }
      perf.mark("lock_idempotency_end");
    } else {
      markLockIdempotencySkipped(perf);
    }

    let effectiveIsStacked = Boolean(is_stacked);
    let effectiveCurrentTripId = current_trip_id ?? null;

    // #69A: parallelise independent pre-RPC reads (active trip, siblings, GDS).
    // B3 ON: also load commitments + optional stacked current-trip remaining here
    // so commitment gate does not pay a second round-trip.
    perf.mark("pre_rpc_parallel_start");
    const tripIdForAccept =
      typeof pendingOffer?.trip_id === "string" ? pendingOffer.trip_id : null;
    const authCurrentTripId =
      typeof (authDriver as { current_trip_id?: string | null }).current_trip_id ===
        "string"
        ? String((authDriver as { current_trip_id?: string | null }).current_trip_id)
        : null;
    const stackedHintTripId =
      effectiveCurrentTripId ?? authCurrentTripId ?? null;
    const nowMsForCommitments = Date.now();

    type StackedCurrentTripRow = {
      status?: string | null;
      started_at?: string | null;
      arrived_at?: string | null;
      estimated_duration_minutes?: number | null;
      last_eta_minutes?: number | null;
      last_eta_calculated_at?: string | null;
      dropoff_latitude?: number | null;
      dropoff_longitude?: number | null;
    };

    const preRpcTasks: [
      Promise<string | null>,
      Promise<{ data: { id: string; driver_id: string }[] | null }>,
      Promise<{ data: Record<string, unknown> | null }>,
      Promise<Awaited<ReturnType<typeof loadDriverConfirmedScheduledCommitments>>>,
      Promise<StackedCurrentTripRow | null>,
    ] = [
      resolveDriverActiveTripId(supabase, driver_id, authCurrentTripId),
      tripIdForAccept
        ? supabase
            .from("ride_offers")
            .select("id, driver_id")
            .eq("trip_id", tripIdForAccept)
            .neq("id", offer_id)
            .neq("driver_id", driver_id)
            .eq("status", "pending")
        : Promise.resolve({ data: [] as { id: string; driver_id: string }[] }),
      supabase
        .from("global_dispatch_settings")
        .select(
          "jit_target_early_arrival_minutes, jit_local_safety_buffer_minutes, jit_long_safety_buffer_minutes, jit_long_distance_eta_threshold_minutes, expected_pickup_waiting_minutes, waiting_time_grace_period_minutes",
        )
        .eq("singleton", true)
        .maybeSingle(),
      b3Parallel
        ? loadDriverConfirmedScheduledCommitments(
          supabase,
          driver_id,
          nowMsForCommitments,
        )
        : Promise.resolve([]),
      b3Parallel && stackedHintTripId
        ? supabase
            .from("trips")
            .select(
              "status, started_at, arrived_at, estimated_duration_minutes, last_eta_minutes, last_eta_calculated_at, dropoff_latitude, dropoff_longitude",
            )
            .eq("id", stackedHintTripId)
            .maybeSingle()
            .then((r: { data: StackedCurrentTripRow | null }) => r.data ?? null)
        : Promise.resolve(null),
    ];

    const [
      activeTripId,
      siblingOffersResult,
      dispatchRowResult,
      preloadedCommitments,
      preloadedStackedCurrent,
    ] = await Promise.all(preRpcTasks);
    perf.mark("pre_rpc_parallel_end");

    if (
      activeTripId &&
      tripIdForAccept &&
      activeTripId !== tripIdForAccept &&
      pendingOffer?.status === "pending"
    ) {
      if (!effectiveIsStacked) {
        console.log("[accept-offer] STACKED_RIDE_AUTO_REDIRECT", {
          driver_id,
          active_trip_id: activeTripId,
          offer_trip_id: tripIdForAccept,
          lifecycle: STACKED_RIDE_STATES.stacked_waiting_current_trip_completion,
        });
        effectiveIsStacked = true;
        effectiveCurrentTripId = activeTripId;
      }
    }

    // Phase 4 / Bug #44: Edge pre-check uses parallelized inputs.
    // SQL driver_scheduled_commitment_gate remains the atomic race safeguard.
    if (tripIdForAccept && holdTrip) {
      const candidateDur = Math.max(
        5,
        Number(holdTrip.estimated_duration_minutes) || 30,
      );
      let stackedRemaining = 0;
      let originLat: number | null = null;
      let originLng: number | null = null;
      if (effectiveIsStacked && effectiveCurrentTripId) {
        let cur: StackedCurrentTripRow | null = null;
        if (
          b3Parallel &&
          preloadedStackedCurrent &&
          (effectiveCurrentTripId === stackedHintTripId ||
            effectiveCurrentTripId === authCurrentTripId)
        ) {
          cur = preloadedStackedCurrent;
        } else {
          const { data: curRow } = await supabase
            .from("trips")
            .select(
              "status, started_at, arrived_at, estimated_duration_minutes, last_eta_minutes, last_eta_calculated_at, dropoff_latitude, dropoff_longitude",
            )
            .eq("id", effectiveCurrentTripId)
            .maybeSingle();
          cur = (curRow as StackedCurrentTripRow | null) ?? null;
        }
        const resolved = resolveStackedActiveRemainingMinutes({
          status: String(cur?.status ?? "in_progress"),
          started_at: (cur?.started_at as string | null) ?? null,
          arrived_at: (cur?.arrived_at as string | null) ?? null,
          estimated_duration_minutes: Number(cur?.estimated_duration_minutes) || null,
          last_eta_minutes: Number(cur?.last_eta_minutes) || null,
          last_eta_calculated_at:
            (cur?.last_eta_calculated_at as string | null) ?? null,
        });
        stackedRemaining = Math.max(
          5,
          resolved.remainingMinutes ?? (Number(cur?.estimated_duration_minutes) || 20),
        );
        const oLat = Number(cur?.dropoff_latitude);
        const oLng = Number(cur?.dropoff_longitude);
        originLat = Number.isFinite(oLat) ? oLat : null;
        originLng = Number.isFinite(oLng) ? oLng : null;
      }
      const driverLat = Number(
        (authDriver as { current_lat?: number | null }).current_lat,
      );
      const driverLng = Number(
        (authDriver as { current_lng?: number | null }).current_lng,
      );
      if (originLat == null || originLng == null) {
        originLat = Number.isFinite(driverLat) ? driverLat : null;
        originLng = Number.isFinite(driverLng) ? driverLng : null;
      }
      const dispatchRow = dispatchRowResult.data;
      const pickLat = Number(holdTrip.pickup_latitude);
      const pickLng = Number(holdTrip.pickup_longitude);
      const dropLat = Number(holdTrip.dropoff_latitude);
      const dropLng = Number(holdTrip.dropoff_longitude);
      perf.mark("commitment_gate_start");
      const gate = await evaluateInstantOfferScheduledCommitmentGate({
        supabase,
        driverId: driver_id,
        nowMs: Date.now(),
        candidateDurationMinutes: candidateDur,
        candidatePickupLat: Number.isFinite(pickLat) ? pickLat : null,
        candidatePickupLng: Number.isFinite(pickLng) ? pickLng : null,
        candidateDropoffLat: Number.isFinite(dropLat) ? dropLat : null,
        candidateDropoffLng: Number.isFinite(dropLng) ? dropLng : null,
        originLat,
        originLng,
        driverLat: Number.isFinite(driverLat) ? driverLat : null,
        driverLng: Number.isFinite(driverLng) ? driverLng : null,
        stackedRemainingMinutes: stackedRemaining,
        globalDispatchSettings: (dispatchRow as Record<string, unknown> | null) ?? null,
        preloadedCommitments: b3Parallel ? preloadedCommitments : null,
      });
      perf.mark("commitment_gate_end");
      if (!gate.allowed) {
        return businessFailureResponse(
          "SCHEDULED_COMMITMENT_INFEASIBLE",
          "Accepting this trip would make your confirmed scheduled booking infeasible",
          { commitment_trip_id: gate.commitmentTripId },
        );
      }
    }

    let revokedOffers: { id: string; driver_id: string }[] = (
      siblingOffersResult.data || []
    ).filter(
      (o): o is { id: string; driver_id: string } => !!(o?.id && o?.driver_id),
    );

    // Stacked rides queue as next trip only — never activate immediately.
    if (effectiveIsStacked) {
      if (!effectiveCurrentTripId) {
        return businessFailureResponse(
          "MISSING_CURRENT_TRIP",
          "current_trip_id is required to queue a stacked ride",
        );
      }

      console.log("[accept-offer] Processing stacked ride acceptance (atomic RPC)");

      // Single atomic RPC — validates, writes offer+queued trip+link in one transaction.
      // Error codes surface as PostgreSQL exception messages caught below.
      perf.mark("accept_rpc_start");
      const { data: stackedResult, error: stackedRpcErr } = await supabase.rpc(
        "accept_stacked_ride",
        {
          p_offer_id:         offer_id,
          p_driver_id:        driver_id,
          p_current_trip_id:  effectiveCurrentTripId,
        },
      );

      if (stackedRpcErr) {
        const msg = String(stackedRpcErr.message ?? stackedRpcErr);
        console.error("[accept-offer] accept_stacked_ride RPC error:", msg);

        // Map PostgreSQL exception tokens → client-facing codes
        if (msg.includes("offer_not_found"))          return businessFailureResponse("OFFER_NOT_FOUND",       "Stacked offer not found");
        if (msg.includes("offer_not_for_driver"))     return businessFailureResponse("OFFER_FORBIDDEN",       "This offer does not belong to you");
        if (msg.includes("offer_not_pending"))        return businessFailureResponse("OFFER_NOT_PENDING",     `Offer already ${msg.split("::").pop()}`);
        if (msg.includes("offer_expired"))            return businessFailureResponse("OFFER_EXPIRED",         "Offer has expired");
        if (msg.includes("NEGOTIATION_HELD"))         return businessFailureResponse("NEGOTIATION_HELD",      "This trip is held for another driver");
        if (msg.includes("stacked_rides_disabled"))   {
          // Re-log the safe-guard token so ops can see it
          console.log(STACKED_RIDE_DISABLED_SAFE_GUARD, { offer_id, driver_id, phase: "stacked_accept_rpc_blocked" });
          return businessFailureResponse(STACKED_RIDE_DISABLED_SAFE_GUARD, "Stacked rides are disabled");
        }
        if (msg.includes("current_trip_not_found"))   return businessFailureResponse("CURRENT_TRIP_NOT_FOUND",  "Active trip not found — cannot queue stacked ride");
        if (msg.includes("current_trip_not_yours"))   return businessFailureResponse("CURRENT_TRIP_FORBIDDEN",  "You are not the driver on the current active trip");
        if (msg.includes("current_trip_terminal"))    return businessFailureResponse("CURRENT_TRIP_NOT_ACTIVE", "Current trip is no longer active — accept the stacked ride as a normal offer");
        if (msg.includes("already_has_stacked_trip")) return businessFailureResponse("ALREADY_HAS_STACKED_TRIP","Current trip already has a queued stacked ride");
        if (msg.includes("queued_trip_assign_failed"))return businessFailureResponse("DATABASE_ERROR",          "Failed to assign queued trip");
        if (msg.includes("link_failed"))              return businessFailureResponse("DATABASE_ERROR",          "Failed to link stacked trip to active trip");
        if (msg.includes("stacked_offer_net_missing")) return businessFailureResponse("STACKED_OFFER_NET_MISSING", "Stacked offer is missing driver net");
        if (msg.includes("stacked_offer_commission_missing")) {
          return businessFailureResponse("STACKED_OFFER_COMMISSION_MISSING", "Stacked offer is missing commission");
        }
        if (msg.includes("stacked_fare_snapshot_failed")) {
          return businessFailureResponse("STACKED_FARE_SNAPSHOT_FAILED", "Could not lock stacked driver fare");
        }

        // Lock-order contention loser (40P01 / 40001): domain response, never raw SQLSTATE text.
        if (
          String((stackedRpcErr as { code?: string }).code ?? "") === "40P01" ||
          String((stackedRpcErr as { code?: string }).code ?? "") === "40001" ||
          /deadlock detected|could not serialize access/i.test(msg)
        ) {
          return businessFailureResponse("TRIP_NOT_AVAILABLE", "Ride already taken");
        }
        return businessFailureResponse("DATABASE_ERROR", msg);
      }

      const rpc = stackedResult as {
        success: boolean;
        trip_id: string;
        current_trip_id: string;
        revoked_driver_ids: string[];
        passenger_user_id: string | null;
      };

      const acceptedTripId = rpc.trip_id;
      const revokedDriverIds: string[] = rpc.revoked_driver_ids ?? [];
      const passengerUserId: string | null = rpc.passenger_user_id ?? null;

      // CANONICAL: accept_stacked_ride committed assignment atomically.
      perf.mark("accept_rpc_end");
      perf.mark("CANONICAL_ASSIGNMENT_CONFIRMED");
      // No full trip/driver enrichment on critical path — explicit skip marks.
      markPostAssignmentEnrichmentSkipped(perf);
      markScheduledGuardSkipped(perf);
      perf.mark("response_build_start");

      const offer = pendingOffer;
      const stackedTripSeed = buildMinimalAcceptedTripSeed({
        tripId: acceptedTripId,
        driverId: driver_id,
        rpc: {
          ...(typeof stackedResult === "object" && stackedResult
            ? (stackedResult as Record<string, unknown>)
            : {}),
          status: "queued",
          offer_id,
          fare_source: "snapshot_accepted_wave_commission",
        },
      });
      // P2 — notifications, delivery audit, wave snapshot: must not delay Driver.
      // Failure here must NOT roll back canonical stacked accept.
      scheduleAcceptOfferBackground(async () => {
        const outcome: AcceptPostCanonicalOutcome = {
          ride_stop_ok: true,
          customer_notify_ok: null,
          booking_delivery_ok: null,
          wave_snapshot_ok: null,
          notify_attempts: 0,
          error_codes: [],
        };
        const t0 = performance.now();
        const rideStopResults = await Promise.allSettled([
          sendRideStopPush(supabaseUrl, supabaseKey, driver_id, "accepted", {
            offer_id,
            trip_id: acceptedTripId,
          }),
          ...revokedDriverIds.map((revokedDriverId) =>
            sendRideStopPush(supabaseUrl, supabaseKey, revokedDriverId, "accepted_other", {
              trip_id: acceptedTripId,
            })
          ),
        ]);
        outcome.ride_stop_ok = rideStopResults.every((r) => r.status === "fulfilled");
        if (!outcome.ride_stop_ok) outcome.error_codes.push("ride_stop_failed");

        if (passengerUserId) {
          perf.mark("notification_enqueue");
          const notifyResult = await notifyCustomerAssignedWithRetry(
            (args) =>
              notifyCustomerTripLifecycle(supabase, {
                userId: args.userId,
                passengerId: args.passengerId,
                tripId: args.tripId,
                event: "driver_assigned",
                title: args.title,
                body: args.body,
              }),
            {
              userId: passengerUserId,
              tripId: acceptedTripId,
              title: "Driver assigned",
              body: "Your driver is completing a nearby trip first. We'll keep you updated.",
            },
          );
          outcome.notify_attempts = notifyResult.attempts;
          outcome.customer_notify_ok = notifyResult.ok;
          if (!notifyResult.ok) {
            outcome.error_codes.push("customer_notify_failed");
            console.warn("[accept-offer] customer stacked push failed after retry:", notifyResult.error);
          }
        } else {
          console.warn("[accept-offer] stacked accept: passenger_user_id not found — customer push skipped", {
            trip_id: acceptedTripId,
            current_trip_id: effectiveCurrentTripId,
          });
          outcome.error_codes.push("passenger_missing");
        }

        perf.mark("booking_delivery_start");
        const { error: acceptedLogErr } = await supabase.rpc("record_booking_delivery", {
          p_booking_id: acceptedTripId,
          p_phase: "accepted",
          p_driver_id: driver_id,
          p_offer_id: offer_id,
          p_source: "edge_accept_offer",
          p_detail: {
            accepted_via: "stacked_accept",
            current_trip_id: effectiveCurrentTripId,
            is_stacked: true,
            perf_id: perfId,
          },
        });
        perf.mark("booking_delivery_end");
        if (acceptedLogErr) {
          outcome.booking_delivery_ok = false;
          outcome.error_codes.push("booking_delivery_failed");
          console.warn("[accept-offer] record_booking_delivery(accepted, stacked) failed:", acceptedLogErr);
        } else {
          outcome.booking_delivery_ok = true;
        }

        try {
          await recordDispatchWaveSnapshot(supabase, {
            tripId: acceptedTripId,
            dispatchRound: Math.max(1, offer?.broadcast_round ?? 1),
            stage: "selected",
            driverId: driver_id,
            rideOfferId: offer_id,
            source: "stacked_accept",
            metadata: {
              stacked_accept: true,
              current_trip_id: effectiveCurrentTripId,
              accepted_via: "stacked_accept",
              perf_id: perfId,
            },
          });
          outcome.wave_snapshot_ok = true;
        } catch (error) {
          outcome.wave_snapshot_ok = false;
          outcome.error_codes.push("wave_snapshot_failed");
          console.warn("[accept-offer] stacked wave snapshot failed:", error);
        }

        const p2Durations = perf.durations();
        await opsLog(supabase, {
          level: outcome.error_codes.length ? "warn" : "info",
          source: "accept-offer",
          app: "driver_app",
          message: `accept-offer post-canonical P2 (stacked) in ${Math.round(performance.now() - t0)}ms`,
          trip_id: acceptedTripId,
          driver_id,
          duration_ms: Math.round(performance.now() - t0),
          metadata: {
            perf_id: perfId,
            path: "stacked_accept",
            phase: "post_canonical_p2",
            edge_booking_delivery_ms: p2Durations.edge_booking_delivery_ms,
            lifecycle_perf_stages_ms: perf.snapshot(),
            ...outcome,
          },
        });
      }, "stacked_post_canonical");

      console.log("[accept-offer] Stacked ride accepted (atomic):", acceptedTripId);
      console.log("STACKED_RIDE_FARE_SNAPSHOT_APPLIED", {
        trip_id: acceptedTripId,
        current_trip_id: effectiveCurrentTripId,
        fare_source: "snapshot_accepted_wave_commission",
        note: "accept_stacked_ride persists accepted offer net via snapshot_accepted_wave_commission",
      });

      perf.mark("response_build_end");
      perf.mark("edge_response");
      const duration_ms = elapsed();
      const stageSnapshot = perf.snapshot();
      const stageDurations = perf.durations();
      logRequestDuration("accept-offer", duration_ms, {
        request_id: requestId,
        perf_id: perfId,
        path: "stacked_accept",
        offer_id,
        trip_id: acceptedTripId,
        lifecycle_perf_stages_ms: stageSnapshot,
        ...stageDurations,
      });
      finishEdgeRequestLog("accept-offer", duration_ms, {
        request_id: requestId,
        perf_id: perfId,
        trip_id: acceptedTripId,
        offer_id,
        path: "stacked_accept",
        lifecycle_perf_stages_ms: stageSnapshot,
        ...stageDurations,
      });
      return successResponse(withDuration({
        success: true,
        trip_id: acceptedTripId,
        is_stacked: true,
        trip: stackedTripSeed,
        message: "Stacked ride accepted - will start after current trip",
        perf_id: perfId,
        lifecycle_perf_stages_ms: stageSnapshot,
        ...stageDurations,
      }, duration_ms, { source: "accept-offer", requestId }));
    }

    // Reuse pendingOffer fetched at the start — all needed fields already present
    const offerRow = pendingOffer;

    if (offerRow) {
      const ns = String(offerRow.negotiation_status ?? "").toLowerCase();
      const driverOfferFare = Number(offerRow.driver_offer_fare ?? 0);
      if (
        ns === "waiting_customer"
        && driverOfferFare > 0
        && offerRow.status !== "accepted"
      ) {
        console.log("[accept-offer] BLOCKED_NEGOTIATION_PENDING_CUSTOMER", {
          offer_id,
          driver_id,
          negotiation_status: ns,
          driver_offer_fare: driverOfferFare,
        });
        return businessFailureResponse(
          "NEGOTIATION_PENDING_CUSTOMER",
          "Customer must accept or decline your fare offer before you can accept this ride",
        );
      }
      if (ns === "declined_customer_awaiting_driver" && offerRow.status !== "accepted") {
        console.log("[accept-offer] BLOCKED_SECOND_CHANCE_USE_FARE_FINAL", {
          offer_id,
          driver_id,
          negotiation_status: ns,
        });
        return businessFailureResponse(
          "NEGOTIATION_SECOND_CHANCE",
          "Accept the original fare from the negotiation card",
        );
      }
    }

    // Sibling pending offers already loaded in pre_rpc_parallel (#69A).
    // RPC still revokes them atomically; this list only feeds deferred RIDE_STOP.

    // Hard SSOT: never hijack active trip via regular accept
    if (
      activeTripId &&
      offerRow?.trip_id &&
      activeTripId !== offerRow.trip_id
    ) {
      return businessFailureResponse(
        "ACTIVE_TRIP_REQUIRES_STACKED_ACCEPT",
        "Finish or complete your current trip first — accept the next ride as a stacked offer",
        { active_trip_id: activeTripId, offer_trip_id: offerRow.trip_id },
      );
    }

    const ns = String(offerRow?.negotiation_status ?? "").toLowerCase();
    const customerCounterFare = Number(offerRow?.customer_counter_fare ?? 0);
    const allowCustomerCounter =
      customerCounterFare > 0
      && ["waiting_driver_final", "waiting_driver", "driver_accepted_counter"].includes(ns);

    // Parity with driver-fare-final: counter accept must re-cover authorised hold
    // before accept_ride_offer (same-order increment SSOT). Prior COUNTER cover is
    // usually sufficient; this closes the accept-offer divergence path.
    if (allowCustomerCounter) {
      const tripIdForCover = String(offerRow?.trip_id ?? "").trim();
      if (!tripIdForCover || !isValidUUID(tripIdForCover)) {
        return businessFailureResponse(
          "NEGOTIATION_COVER_FAILED",
          "Unable to verify payment coverage for the counter fare",
        );
      }
      const cover = await ensureNegotiationPayableAuthorised({
        supabase,
        tripId: tripIdForCover,
        requiredFarePence: Math.round(customerCounterFare),
        owner: `accept_offer_counter:${tripIdForCover}:${offer_id}`,
      });
      if (!cover.ok) {
        return businessFailureResponse(cover.code, cover.message);
      }
      await writePayableSnapshotOrLog(supabase, {
        tripId: tripIdForCover,
        trip: {
          locked_base_fare_pence: Math.round(customerCounterFare),
          final_customer_fare_pence: Math.round(customerCounterFare),
        },
        source: "negotiation_commit",
        waitingBasis: "none",
        logPrefix: "accept-offer",
      });
    }

    console.log("[accept-offer] ACCEPT_ORIGINAL_RPC_REQUEST", {
      offer_id,
      driver_id,
      negotiation_status: ns,
      allow_customer_counter: allowCustomerCounter,
    });

    perf.mark("accept_rpc_start");
    // Bug #47: rematch dispatch can hold the trip lock briefly. Retry transient
    // lock/timeout RPC errors inside Edge so the first Accept tap can still win
    // without leaving the Driver on Accepting… for a full statement_timeout.
    const isTransientAcceptRpcError = (message: string | null | undefined) =>
      /statement timeout|lock_not_available|lock timeout|canceling statement|deadlock|serialization/i
        .test(String(message ?? ""));

    let data: any = null;
    let error: { message?: string } | null = null;
    const maxRpcAttempts = 3;
    for (let attempt = 1; attempt <= maxRpcAttempts; attempt++) {
      const rpc = await supabase.rpc("accept_ride_offer", {
        p_offer_id: offer_id,
        p_driver_id: driver_id,
        p_allow_customer_counter: allowCustomerCounter,
      });
      data = rpc.data;
      error = rpc.error;
      if (!error) break;
      console.error("[accept-offer] ACCEPT_ORIGINAL_RPC_ERROR", {
        offer_id,
        attempt,
        message: error.message,
      });
      if (attempt >= maxRpcAttempts || !isTransientAcceptRpcError(error.message)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 80 * attempt));
    }

    if (error) {
      // Lost-response reconcile: another attempt (or late commit) may have assigned us.
      try {
        const { data: offerCheck } = await supabase
          .from("ride_offers")
          .select("status, negotiation_status, trip_id, trips:trip_id(driver_id, confirmed_driver_id, status)")
          .eq("id", offer_id)
          .eq("driver_id", driver_id)
          .maybeSingle();
        const tripRel = (offerCheck as any)?.trips;
        const tripRow = Array.isArray(tripRel) ? tripRel[0] : tripRel;
        const assignedToMe =
          tripRow &&
          (tripRow.driver_id === driver_id || tripRow.confirmed_driver_id === driver_id) &&
          ["driver_assigned", "en_route", "arrived", "in_progress", "driver_en_route"].includes(
            String(tripRow.status ?? ""),
          );
        if (
          assignedToMe ||
          (offerCheck?.status === "accepted" &&
            String(offerCheck?.negotiation_status ?? "").toLowerCase() === "confirmed")
        ) {
          console.log("[accept-offer] ACCEPT_RECONCILED_AFTER_RPC_ERROR", {
            offer_id,
            trip_id: offerCheck?.trip_id ?? tripRow?.id,
          });
          data = {
            success: true,
            trip_id: offerCheck?.trip_id,
            fare_source: "reconciled_after_rpc_error",
            accepted_via: "accept_ride_offer_reconcile",
          };
          error = null;
        }
      } catch (reconcileErr) {
        console.warn("[accept-offer] post-error reconcile failed", {
          offer_id,
          message: reconcileErr instanceof Error ? reconcileErr.message : "unknown",
        });
      }
    }

    if (error) {
      return businessFailureResponse("DATABASE_ERROR", error.message ?? "Accept failed", { offer_id });
    }

    console.log("[accept-offer] ACCEPT_ORIGINAL_RPC_RESULT", data);

    if (!data?.success) {
      console.error("[accept-offer] ACCEPT_ORIGINAL_RPC_ERROR", {
        offer_id,
        error: data?.error,
        message: data?.message,
      });
      return businessFailureResponse(
        data?.error ?? "ACCEPT_FAILED",
        data?.message || "Failed to accept offer",
        { offer_id, ...data },
      );
    }

    perf.mark("accept_rpc_end");
    // CANONICAL BOUNDARY: accept_ride_offer committed one-driver-wins assignment.
    // Trip has driver_id, status driver_assigned, competing offers revoked.
    // Duplicate/expired/cancelled cannot succeed past this point.
    perf.mark("CANONICAL_ASSIGNMENT_CONFIRMED");

    console.log("[accept-offer] ACCEPT_ORIGINAL_RPC_SUCCESS", {
      offer_id,
      trip_id: data.trip_id,
      fare_source: data.fare_source,
      accepted_via: data.accepted_via,
    });

    const acceptedTripId = data.trip_id ?? offerRow?.trip_id;
    const tripId = data.trip_id;

    // Explicit skip: no full trips/drivers re-fetch on critical path.
    markPostAssignmentEnrichmentSkipped(perf);

    // P0 only when applicable: scheduled urgent dispatch status (cheap, correctness).
    if (tripId && offerRow?.is_urgent_dispatch) {
      perf.mark("scheduled_guard_start");
      console.log("[accept-offer] Scheduled urgent offer accepted — updating scheduled_status");
      await supabase
        .from("trips")
        .update({
          scheduled_status: "driver_en_route",
          confirm_deadline_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tripId);
      perf.mark("scheduled_guard_end");
    } else {
      markScheduledGuardSkipped(perf);
    }

    perf.mark("response_build_start");
    // Minimal authoritative seed from RPC — no full trips/drivers re-fetch on critical path.
    const tripSeed = tripId
      ? buildMinimalAcceptedTripSeed({
        tripId,
        driverId: driver_id,
        rpc: { ...data, offer_id },
      })
      : null;
    perf.mark("response_build_end");

    // P2 — RIDE_STOP, customer driver_assigned, supplemental edge delivery log.
    // accept_ride_offer already recorded booking delivery (source=postgres).
    // Failure must not roll back or flip success=false.
    scheduleAcceptOfferBackground(async () => {
      const outcome: AcceptPostCanonicalOutcome = {
        ride_stop_ok: true,
        customer_notify_ok: null,
        booking_delivery_ok: null,
        notify_attempts: 0,
        error_codes: [],
      };
      const t0 = performance.now();
      const rideStopResults = await Promise.allSettled([
        sendRideStopPush(supabaseUrl, supabaseKey, driver_id, "accepted", {
          offer_id,
          trip_id: acceptedTripId,
        }),
        ...revokedOffers.map((row) =>
          sendRideStopPush(supabaseUrl, supabaseKey, row.driver_id, "accepted_other", {
            offer_id: row.id,
            trip_id: acceptedTripId,
          })
        ),
      ]);
      outcome.ride_stop_ok = rideStopResults.every((r) => r.status === "fulfilled");
      if (!outcome.ride_stop_ok) outcome.error_codes.push("ride_stop_failed");

      if (tripId) {
        let passengerId = knownPassengerId;
        if (!passengerId) {
          const { data: tripPassenger } = await supabase
            .from("trips")
            .select("passenger_id")
            .eq("id", tripId)
            .maybeSingle();
          passengerId =
            typeof tripPassenger?.passenger_id === "string"
              ? tripPassenger.passenger_id.trim() || null
              : null;
        }
        if (passengerId) {
          perf.mark("notification_enqueue");
          const notifyResult = await notifyCustomerAssignedWithRetry(
            (args) =>
              notifyCustomerTripLifecycle(supabase, {
                userId: args.userId,
                passengerId: args.passengerId,
                tripId: args.tripId,
                event: "driver_assigned",
                title: args.title,
                body: args.body,
              }),
            { passengerId, tripId },
          );
          outcome.notify_attempts = notifyResult.attempts;
          outcome.customer_notify_ok = notifyResult.ok;
          if (!notifyResult.ok) {
            outcome.error_codes.push("customer_notify_failed");
            console.warn(
              "[accept-offer] customer driver_assigned push failed after retry:",
              notifyResult.error,
            );
          }
        } else {
          console.warn("[accept-offer] passenger_id missing — customer assigned push skipped", {
            trip_id: tripId,
          });
          outcome.error_codes.push("passenger_missing");
        }

        perf.mark("booking_delivery_start");
        const { error: acceptedLogErr } = await supabase.rpc("record_booking_delivery", {
          p_booking_id: tripId,
          p_phase: "accepted",
          p_driver_id: driver_id,
          p_offer_id: offer_id,
          p_source: "edge_accept_offer",
          p_detail: {
            accepted_via: "rpc_accept_ride_offer",
            is_stacked: false,
            perf_id: perfId,
            note: "supplemental_edge_audit_rpc_already_recorded",
          },
        });
        perf.mark("booking_delivery_end");
        if (acceptedLogErr) {
          outcome.booking_delivery_ok = false;
          outcome.error_codes.push("booking_delivery_failed");
          console.warn("[accept-offer] record_booking_delivery(accepted) failed:", acceptedLogErr);
        } else {
          outcome.booking_delivery_ok = true;
        }

        const p2Durations = perf.durations();
        await opsLog(supabase, {
          level: outcome.error_codes.length ? "warn" : "info",
          source: "accept-offer",
          app: "driver_app",
          message: `accept-offer post-canonical P2 in ${Math.round(performance.now() - t0)}ms`,
          trip_id: tripId,
          driver_id,
          duration_ms: Math.round(performance.now() - t0),
          metadata: {
            perf_id: perfId,
            path: "accept_ride_offer",
            phase: "post_canonical_p2",
            edge_booking_delivery_ms: p2Durations.edge_booking_delivery_ms,
            edge_post_trip_fetch_ms: p2Durations.edge_post_trip_fetch_ms,
            edge_post_driver_fetch_ms: p2Durations.edge_post_driver_fetch_ms,
            lifecycle_perf_stages_ms: perf.snapshot(),
            ...outcome,
          },
        });
      }
    }, "accept_post_canonical");

    perf.mark("edge_response");
    const duration_ms = elapsed();
    const stageSnapshot = perf.snapshot();
    const stageDurations = perf.durations();
    logRequestDuration("accept-offer", duration_ms, {
      request_id: requestId,
      perf_id: perfId,
      path: "accept_ride_offer",
      offer_id,
      trip_id: tripId ?? null,
      lifecycle_perf_stages_ms: stageSnapshot,
      ...stageDurations,
    });
    finishEdgeRequestLog("accept-offer", duration_ms, {
      request_id: requestId,
      perf_id: perfId,
      trip_id: tripId ?? null,
      offer_id,
      path: "accept_ride_offer",
      lifecycle_perf_stages_ms: stageSnapshot,
      ...stageDurations,
    });
    return successResponse(withDuration({
      ...data,
      trip: tripSeed,
      trip_id: tripId ?? data.trip_id,
      perf_id: perfId,
      lifecycle_perf_stages_ms: stageSnapshot,
      ...stageDurations,
    }, duration_ms, {
      source: "accept-offer",
      requestId,
    }));

  } catch (error) {
    console.error("[accept-offer] Error:", error);
    // Never leak raw Deno/module/SQL internals to Driver UI.
    return errorResponse(
      "INTERNAL_ERROR",
      "Unable to accept this offer. Please try again.",
      500,
    );
  }
});
