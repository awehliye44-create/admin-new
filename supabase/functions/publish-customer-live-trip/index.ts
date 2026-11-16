/**
 * Service-role: upsert Live Trip projection + fan-out ActivityKit APNs / Android FCM data.
 * Presentation delivery only — never blocks trip mutations / payments.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { requireSignedInOrService } from "../_shared/callerGate.ts";
import { buildCustomerLiveTripProjection } from "./lib/customerLiveTripProjectionSSOT.ts";
import { hydrateLiveTripAssignmentIdentity } from "./lib/hydrateLiveTripAssignmentIdentity.ts";
import {
  liveActivityApnsConfigured,
  selectLiveActivityPushToken,
  sendCustomerLiveActivityApns,
} from "../_shared/customerLiveTripApns.ts";
import {
  fcmProjectIdFromServiceAccount,
  getFcmHttpV1AccessToken,
  readFcmServiceAccountJson,
  sendFcmHttpV1Message,
} from "../_shared/fcmHttpV1.ts";
import { resolveCustomerAuthoritativeToken } from "../_shared/authoritativeDevicePush.ts";
import { resolveCustomerLiveTripPlatformGates } from "../_shared/customerLiveTripFeatureFlag.ts";
import { isCustomerLiveTripRuntimeCompatible } from "../_shared/customerLiveTripRuntimeGate.ts";
import {
  peekTripRouteCacheLeg,
  resolveLiveTripEtaLeg,
} from "./lib/customerLiveTripEtaSSOT.ts";

const RATE = { limit: 400, windowMs: 60_000, keyPrefix: "pub-live-trip" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();
  // Service role (lifecycle producers) OR signed-in Customer for own-trip ETA ticks.
  const gate = await requireSignedInOrService(req);
  if (!gate.ok) return gate.response;

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE);
    const body = await req.json();
    const tripId = String(body.trip_id ?? body.tripId ?? "").trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse({ trip_id: "trip_id UUID required" });
    }

    const priority = String(body.priority ?? "").trim().toLowerCase();
    const forceEnd = body.force_end === true || body.forceEnd === true;

    const { data: trip, error: tripErr } = await admin
      .from("trips")
      .select("*")
      .eq("id", tripId)
      .maybeSingle();
    if (tripErr || !trip) {
      return errorResponse("TRIP_NOT_FOUND", "Trip not found", 404);
    }

    // Resolve customer auth user id.
    let customerUserId =
      String(trip.customer_user_id ?? trip.user_id ?? "").trim() || "";
    const customerId = String(trip.customer_id ?? trip.passenger_id ?? "").trim() ||
      null;
    if (!customerUserId && customerId && isValidUUID(customerId)) {
      const { data: cust } = await admin
        .from("customers")
        .select("user_id")
        .eq("id", customerId)
        .maybeSingle();
      customerUserId = String(cust?.user_id ?? "").trim();
    }
    if (!customerUserId) {
      return errorResponse("CUSTOMER_UNRESOLVED", "Cannot resolve customer user", 400);
    }

    // Customer JWT may only publish for their own trip.
    if (!gate.isService) {
      if (!gate.userId || gate.userId !== customerUserId) {
        return errorResponse("FORBIDDEN", "Not your trip", 403);
      }
    }

    const gates = await resolveCustomerLiveTripPlatformGates(admin);

    const { data: previous } = await admin
      .from("customer_live_trip_projections")
      .select("*")
      .eq("trip_id", tripId)
      .maybeSingle();

    const etaOverrideRaw = body.eta_minutes ?? body.etaMinutes;
    const etaOverride =
      typeof etaOverrideRaw === "number" && Number.isFinite(etaOverrideRaw)
        ? etaOverrideRaw
        : null;

    // Peek existing route cache only — never force a Google/Mapbox refresh here.
    const provisionalStageHint = String(
      (previous as { lifecycle_stage?: string } | null)?.lifecycle_stage ?? "",
    );
    const hintLeg =
      resolveLiveTripEtaLeg(provisionalStageHint) ??
      resolveLiveTripEtaLeg("heading_to_pickup");
    const cachedRoute = hintLeg
      ? await peekTripRouteCacheLeg(admin, tripId, hintLeg)
      : null;

    // MK-261116-011/012: trips.* alone never carries name/vehicle/photos.
    const hydratedTrip = await hydrateLiveTripAssignmentIdentity(
      admin,
      trip as Record<string, unknown>,
    );

    // Second peek after projection stage is known (below) if stage implies other leg.
    let projection = buildCustomerLiveTripProjection({
      trip: hydratedTrip,
      customerUserId,
      customerId,
      previous: previous as Record<string, unknown> | null,
      etaOverrideMinutes: etaOverride,
      cachedRoute,
    });
    if (!projection) {
      return errorResponse("PROJECTION_FAILED", "Could not build projection", 500);
    }

    const stageLeg = resolveLiveTripEtaLeg(projection.lifecycle_stage);
    if (stageLeg && stageLeg !== hintLeg) {
      const stageCache = await peekTripRouteCacheLeg(admin, tripId, stageLeg);
      projection = buildCustomerLiveTripProjection({
        trip: hydratedTrip,
        customerUserId,
        customerId,
        previous: previous as Record<string, unknown> | null,
        etaOverrideMinutes: etaOverride,
        cachedRoute: stageCache,
      })!;
    }

    const hadLive =
      Boolean(previous?.eligible) && !Boolean(previous?.terminal);
    const emergencyEndExisting =
      (!gates.globalEnabled || forceEnd) && hadLive;
    if (emergencyEndExisting) {
      projection = {
        ...projection,
        eligible: false,
        terminal: true,
        lifecycle_stage: "ended",
        eta_minutes: null,
        status_title: "Trip ended",
        status_description: "Live tracking ended",
        content_state: {
          ...projection.content_state,
          phase: "ended",
          statusTitle: "Trip ended",
          statusDescription: "Live tracking ended",
          etaLabel: null,
          showDriverVehicle: false,
          silent: true,
        },
        stale_at: null,
      };
    }

    // Coalesce routine ETA ticks: skip fanout when nothing material changed recently.
    const coalesceMs = 35_000;
    const lastPublishedMs = previous?.last_published_at
      ? Date.parse(String(previous.last_published_at))
      : 0;
    const etaUnchanged =
      previous?.eta_minutes === projection.eta_minutes &&
      previous?.lifecycle_stage === projection.lifecycle_stage &&
      previous?.assignment_generation === projection.assignment_generation;
    // Identity / title deltas must never be coalesced away (MK-261116-011).
    const identityUnchanged =
      previous?.driver_first_name === projection.driver_first_name &&
      previous?.vehicle_registration === projection.vehicle_registration &&
      previous?.vehicle_make === projection.vehicle_make &&
      previous?.driver_photo_url === projection.driver_photo_url &&
      previous?.status_title === projection.status_title;
    const isPriority =
      priority === "lifecycle" ||
      priority === "assignment" ||
      priority === "rematch" ||
      priority === "arrival" ||
      priority === "terminal" ||
      emergencyEndExisting ||
      projection.terminal ||
      !projection.eligible;
    const withinCoalesce =
      Number.isFinite(lastPublishedMs) &&
      Date.now() - lastPublishedMs < coalesceMs &&
      etaUnchanged &&
      identityUnchanged &&
      !isPriority;

    // Feature OFF: still persist + fanout end for previously live activities.
    const allowPersist = true;
    const allowIosFanout =
      (gates.iosEnabled || emergencyEndExisting) && liveActivityApnsConfigured();
    const allowAndroidFanout = gates.androidEnabled || emergencyEndExisting;
    const allowFanout =
      !withinCoalesce &&
      (allowIosFanout || allowAndroidFanout) &&
      (gates.globalEnabled || emergencyEndExisting || projection.terminal ||
        !projection.eligible);

    if (allowPersist) {
      const { error: upsertErr } = await admin
        .from("customer_live_trip_projections")
        .upsert({
          ...projection,
          last_published_at: withinCoalesce
            ? previous?.last_published_at ?? new Date().toISOString()
            : new Date().toISOString(),
        });
      if (upsertErr) {
        console.error("[publish-customer-live-trip] upsert", upsertErr);
        // Do not fail trip producers hard — still attempt best-effort fanout.
      }
    }

    if (withinCoalesce) {
      return successResponse({
        ok: true,
        trip_id: tripId,
        coalesced: true,
        eligible: projection.eligible,
        terminal: projection.terminal,
        assignment_generation: projection.assignment_generation,
        presentation_version: projection.presentation_version,
        lifecycle_stage: projection.lifecycle_stage,
        feature_enabled: gates.globalEnabled,
        gates,
        fanout: false,
        delivery: {
          apns_attempted: false,
          apns_ok: false,
          fcm_attempted: false,
          fcm_ok: false,
        },
      });
    }

    const delivery: Record<string, unknown> = {
      apns_attempted: false,
      apns_ok: false,
      fcm_attempted: false,
      fcm_ok: false,
    };

    const event =
      projection.terminal || !projection.eligible || emergencyEndExisting
        ? "end"
        : hadLive
        ? "update"
        : "start";
    const isEndEvent = event === "end";

    // Single active-device runtime check for both platforms.
    const authDevice = await resolveCustomerAuthoritativeToken(
      admin,
      customerUserId,
    );
    const runtimeCompatible = authDevice
      ? isCustomerLiveTripRuntimeCompatible({
        platform: authDevice.platform,
        appVersion: authDevice.app_version,
        runtimeVersion: authDevice.runtime_version,
        clientCapabilities: authDevice.client_capabilities,
      })
      : false;
    delivery.runtime_compatible = runtimeCompatible;

    // iOS ActivityKit — gated on APNs readiness (Android independent).
    // Start/update require a compatible native train; end always attempts cleanup.
    if (allowFanout && allowIosFanout && (runtimeCompatible || isEndEvent)) {
      const { data: tokens } = await admin
        .from("customer_live_activity_tokens")
        .select("push_token, push_to_start_token, trip_id, apns_environment")
        .eq("customer_user_id", customerUserId)
        .is("invalidated_at", null)
        .or(`trip_id.eq.${tripId},trip_id.is.null`);

      const nowSec = Math.floor(Date.now() / 1000);
      const staleSec = projection.stale_at
        ? Math.floor(Date.parse(projection.stale_at) / 1000)
        : nowSec + 8 * 60;

      const tokenRows = tokens ?? [];
      if (tokenRows.length === 0) {
        delivery.apns_skipped_no_token = true;
        console.warn(
          "[publish-customer-live-trip] apns skipped — no customer_live_activity_tokens",
          JSON.stringify({
            trip_id: tripId,
            event,
            presentation_version: projection.presentation_version,
            lifecycle_stage: projection.lifecycle_stage,
            has_driver_name: Boolean(projection.driver_first_name),
            has_vehicle_reg: Boolean(projection.vehicle_registration),
            // MK-261116-013: empty tokens = register Edge was failing device lookup.
          }),
        );
      }
      for (const row of tokenRows) {
        const activityToken = String(row.push_token ?? "").trim();
        const pushToStartToken = String(row.push_to_start_token ?? "").trim();
        const token = selectLiveActivityPushToken({
          event,
          pushToken: activityToken,
          pushToStartToken,
        });
        if (!token) continue;
        delivery.apns_attempted = true;
        const env = String(row.apns_environment ?? "").trim().toLowerCase();
        const apnsHost =
          env === "sandbox"
            ? "https://api.sandbox.push.apple.com"
            : env === "production"
            ? "https://api.push.apple.com"
            : null;
        const result = await sendCustomerLiveActivityApns({
          pushToken: token,
          event,
          timestampSec: nowSec,
          contentState: projection.content_state,
          attributesType: "OneCabLiveTripAttributes",
          attributes: {
            tripId,
            publicTripId: (trip as Record<string, unknown>).trip_code ?? null,
            deepLinkPath: `/(tabs)/home`,
          },
          staleDateSec: event !== "end" ? staleSec : undefined,
          dismissalDateSec: event === "end" ? nowSec + 60 : undefined,
          alertTitle: event === "start" ? "ONECAB" : undefined,
          alertBody:
            event === "start"
              ? String(projection.status_title || "Live trip tracking")
              : undefined,
          apnsHost,
        });
        delivery.apns_ok = Boolean(delivery.apns_ok) || result.ok;
        if (!result.ok && result.status === 410) {
          let invalidateQ = admin
            .from("customer_live_activity_tokens")
            .update({ invalidated_at: new Date().toISOString() })
            .eq("customer_user_id", customerUserId)
            .is("invalidated_at", null);
          if (activityToken) {
            invalidateQ = invalidateQ.eq("push_token", activityToken);
          } else if (pushToStartToken) {
            invalidateQ = invalidateQ.eq("push_to_start_token", pushToStartToken);
          }
          await invalidateQ;
        }
      }
    }

    // Android: data-only FCM for native LiveTrip handler (no alert / sound).
    // Compatible runtimes only for start/update; terminal/end still fans out so
    // a previously shown card can be cleared on an upgraded device.
    const serviceAccountJson = readFcmServiceAccountJson();
    if (allowFanout && allowAndroidFanout && serviceAccountJson) {
      try {
        const authToken = authDevice;
        if (authToken?.token && authToken.platform !== "ios") {
          if (!runtimeCompatible && !isEndEvent) {
            delivery.fcm_skipped_runtime = true;
          } else {
            delivery.fcm_attempted = true;
            const access = await getFcmHttpV1AccessToken(serviceAccountJson);
            const projectId = fcmProjectIdFromServiceAccount(serviceAccountJson);
            const data: Record<string, string> = {
              type: "live_trip_update",
              trip_id: tripId,
              assignment_generation: String(projection.assignment_generation),
              presentation_version: String(projection.presentation_version),
              eligible: projection.eligible ? "1" : "0",
              terminal: projection.terminal ? "1" : "0",
              content_state: JSON.stringify(projection.content_state),
            };
            const send = await sendFcmHttpV1Message({
              accessToken: access,
              projectId,
              message: {
                token: authToken.token,
                data,
                android: { priority: "HIGH" },
              },
            });
            delivery.fcm_ok = send.ok;
            if (!send.ok) {
              delivery.fcm_error_code = send.errorCode;
              delivery.fcm_http_status = send.httpStatus;
              console.warn(
                "[publish-customer-live-trip] fcm rejected",
                JSON.stringify({
                  trip_id: tripId,
                  event,
                  error_code: send.errorCode,
                  http_status: send.httpStatus,
                  presentation_version: projection.presentation_version,
                }),
              );
            } else {
              console.log(
                "[publish-customer-live-trip] fcm accepted",
                JSON.stringify({
                  trip_id: tripId,
                  event,
                  presentation_version: projection.presentation_version,
                  has_driver_name: Boolean(projection.driver_first_name),
                  has_vehicle_reg: Boolean(projection.vehicle_registration),
                }),
              );
            }
          }
        } else if (!authToken?.token) {
          delivery.fcm_skipped_no_token = true;
        } else if (authToken.platform === "ios") {
          delivery.fcm_skipped_ios_device = true;
        }
      } catch (err) {
        console.warn(
          "[publish-customer-live-trip] fcm fanout",
          err instanceof Error ? err.message : "unknown",
        );
      }
    }

    return successResponse({
      ok: true,
      trip_id: tripId,
      eligible: projection.eligible,
      terminal: projection.terminal,
      assignment_generation: projection.assignment_generation,
      presentation_version: projection.presentation_version,
      lifecycle_stage: projection.lifecycle_stage,
      feature_enabled: gates.globalEnabled,
      gates,
      fanout: allowFanout,
      event,
      delivery,
    });
  } catch (err) {
    console.error("[publish-customer-live-trip] exception", err);
    return errorResponse(
      "INTERNAL",
      err instanceof Error ? err.message : "unknown",
      500,
    );
  }
});
