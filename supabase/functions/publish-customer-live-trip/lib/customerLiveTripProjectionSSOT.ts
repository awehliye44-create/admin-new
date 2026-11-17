/**
 * Authoritative Customer Live Trip projection builder — presentation only.
 * Reuses trip lifecycle / assignment / vehicle / ETA; never invents dispatch logic.
 */

import {
  normalizeLiveTripStatus,
  resolveCustomerLiveTripEligibility,
  type LiveTripEligibilityInput,
} from "./customerLiveTripEligibilitySSOT.ts";
import { resolveAuthoritativeLiveTripEta } from "./customerLiveTripEtaSSOT.ts";

export type LiveTripProjectionRow = {
  trip_id: string;
  customer_user_id: string;
  customer_id: string | null;
  eligible: boolean;
  terminal: boolean;
  lifecycle_stage: string;
  assignment_generation: number;
  presentation_version: number;
  assigned_driver_id: string | null;
  driver_first_name: string | null;
  driver_photo_url: string | null;
  driver_rating: number | null;
  driver_rating_count: number | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_colour: string | null;
  vehicle_registration: string | null;
  vehicle_photo_url: string | null;
  eta_minutes: number | null;
  status_title: string;
  status_description: string;
  progress_step_index: number;
  content_state: Record<string, unknown>;
  updated_at: string;
  stale_at: string | null;
};

function readString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

function readNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function firstName(raw: string | null): string | null {
  if (!raw) return null;
  return raw.split(/\s+/)[0] ?? raw;
}

function vehicleColour(trip: Record<string, unknown>, vehicle: Record<string, unknown> | null): string | null {
  return (
    readString(vehicle?.colour) ??
    readString(vehicle?.color) ??
    readString(vehicle?.vehicle_colour) ??
    readString(trip.vehicle_colour) ??
    readString(trip.vehicle_color) ??
    null
  );
}

/** Compact plate identity for duplication checks (Bug #17). */
function plateIdentity(registration: string | null | undefined): string {
  const raw = readString(registration);
  if (!raw) return "";
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

/** Full plate for Lock Screen — never truncate; UK-style spacing when applicable. */
function formatVehicleRegistration(registration: string | null | undefined): string | null {
  const raw = readString(registration);
  if (!raw) return null;
  const compact = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (!compact) return null;
  if (/^[A-Z]{2}\d{2}[A-Z]{3}$/.test(compact)) {
    return `${compact.slice(0, 4)} ${compact.slice(4)}`;
  }
  return compact;
}

/** Drop make/model tokens that duplicate the registration (e.g. make="BG70NOF"). */
function sanitizeMakeModel(input: {
  make: string | null;
  model: string | null;
  registration: string | null;
}): { make: string | null; model: string | null } {
  const plateId = plateIdentity(input.registration);
  const clean = (value: string | null): string | null => {
    const raw = readString(value);
    if (!raw) return null;
    if (plateId && plateIdentity(raw) === plateId) return null;
    // Only strip a leading whole token equal to the plate — never compact
    // startsWith (BG70NO vs BG70NOF left a stray "F Corolla").
    if (plateId) {
      const tokens = raw.split(/\s+/).filter(Boolean);
      if (tokens.length > 1 && plateIdentity(tokens[0]) === plateId) {
        return tokens.slice(1).join(" ") || null;
      }
    }
    return raw;
  };
  return { make: clean(input.make), model: clean(input.model) };
}

function resolveLifecycleStage(status: string, rematching: boolean): string {
  if (rematching) return "finding_new_driver";
  const s = status;
  if (
    s === "pending" ||
    s === "searching" ||
    s === "broadcasting" ||
    s === "offered" ||
    s === "offering" ||
    s === "negotiating" ||
    s === "payment_pending"
  ) {
    return "finding_driver";
  }
  if (
    s === "arrived" ||
    s === "arrived_pickup" ||
    s === "arrived_at_pickup" ||
    s === "at_pickup" ||
    s === "driver_arrived" ||
    s === "pickup_waiting" ||
    s === "waiting" ||
    s === "waiting_at_pickup"
  ) {
    return "at_pickup";
  }
  if (
    s === "en_route_to_stop" ||
    s === "arrived_at_stop" ||
    s === "at_stop" ||
    s === "waiting_at_stop"
  ) {
    return "intermediate_stop";
  }
  if (
    s === "in_progress" ||
    s === "started" ||
    s === "trip_started" ||
    s === "on_trip" ||
    s === "en_route_to_dropoff" ||
    s === "passenger_onboard" ||
    s === "ongoing" ||
    s === "completing" ||
    s === "arrived_at_destination"
  ) {
    return "trip_started";
  }
  if (
    s === "en_route" ||
    s === "en_route_to_pickup" ||
    s === "enroute_to_pickup" ||
    s === "driver_en_route" ||
    s === "driver_arriving"
  ) {
    return "heading_to_pickup";
  }
  if (
    s === "driver_assigned" ||
    s === "assigned" ||
    s === "accepted" ||
    s === "confirmed" ||
    s === "queued"
  ) {
    return "driver_assigned";
  }
  return "finding_driver";
}

function copyForStage(stage: string): {
  status_title: string;
  status_description: string;
  progress_step_index: number;
} {
  switch (stage) {
    case "finding_new_driver":
      return {
        status_title: "Finding a new driver",
        status_description: "Searching for a nearby driver",
        // -1 = no progress milestones reached (must not light "Driver assigned").
        progress_step_index: -1,
      };
    case "finding_driver":
      return {
        status_title: "Finding your driver",
        status_description: "Searching for a nearby driver",
        progress_step_index: -1,
      };
    case "driver_assigned":
      return {
        status_title: "Driver assigned",
        status_description: "Driver confirmed for your trip",
        // Bug #17: 0 Assigned → 1 Arrived → 2 Started → 3 Completed
        progress_step_index: 0,
      };
    case "heading_to_pickup":
      return {
        status_title: "On the way",
        status_description: "Heading to your pickup",
        // On the way keeps Assigned chevron — status text carries ETA copy.
        progress_step_index: 0,
      };
    case "at_pickup":
      return {
        status_title: "Arrived",
        status_description: "Driver has arrived at pickup",
        progress_step_index: 1,
      };
    case "trip_started":
      return {
        status_title: "Trip in progress",
        status_description: "On the way to your destination",
        progress_step_index: 2,
      };
    case "intermediate_stop":
      return {
        status_title: "At stop",
        status_description: "Driver is at an intermediate stop",
        // Intermediate stops stay on Started — status text may say At stop.
        progress_step_index: 2,
      };
    default:
      return {
        status_title: "Active trip",
        status_description: "Live trip update",
        progress_step_index: 0,
      };
  }
}

function isRematchStatus(status: string): boolean {
  return (
    status === "searching_new_driver" ||
    status === "rematching" ||
    status === "driver_cancelled" ||
    status === "driver_canceled" ||
    status === "driver_assignment_cancelled" ||
    status === "driver_assignment_canceled"
  );
}

/**
 * Compute next assignment_generation from previous projection + trip row.
 * Increments when rematch clears or assigned driver id changes.
 */
export function nextAssignmentGeneration(args: {
  previousGeneration: number;
  previousDriverId: string | null;
  nextDriverId: string | null;
  rematching: boolean;
  /** Same-driver reassignment with a different approved vehicle must bump. */
  previousVehicleRegistration?: string | null;
  nextVehicleRegistration?: string | null;
}): number {
  const prev = Math.max(0, Math.floor(args.previousGeneration));
  if (args.rematching) {
    // Clear generation bump even if previous was already unassigned.
    return prev + 1;
  }
  if (
    args.nextDriverId &&
    args.previousDriverId &&
    args.nextDriverId !== args.previousDriverId
  ) {
    return prev + 1;
  }
  if (args.nextDriverId && !args.previousDriverId) {
    return prev + 1;
  }
  // Compare plate identity so "BG70NOF" vs "BG70 NOF" does not false-bump.
  const prevPlate = plateIdentity(args.previousVehicleRegistration);
  const nextPlate = plateIdentity(args.nextVehicleRegistration);
  if (
    args.nextDriverId &&
    args.previousDriverId === args.nextDriverId &&
    nextPlate &&
    prevPlate &&
    nextPlate !== prevPlate
  ) {
    return prev + 1;
  }
  return prev;
}

export function buildCustomerLiveTripProjection(args: {
  trip: Record<string, unknown>;
  customerUserId: string;
  customerId?: string | null;
  previous?: Partial<LiveTripProjectionRow> | null;
  nowMs?: number;
  /** Explicit ETA override (publish body / Customer tick). */
  etaOverrideMinutes?: number | null;
  /** Existing trip_route_cache row for the active leg — never fetched here. */
  cachedRoute?: {
    duration_min?: number | null;
    eta_at?: string | null;
    expires_at?: string | null;
    cached_at?: string | null;
  } | null;
}): LiveTripProjectionRow | null {
  const trip = args.trip;
  const tripId = readString(trip.id) ?? readString(trip.trip_id);
  if (!tripId) return null;

  const nowMs = args.nowMs ?? Date.now();
  const eligibilityInput: LiveTripEligibilityInput = {
    status: trip.status,
    dispatch_status: trip.dispatch_status ?? trip.dispatchStatus,
    booking_type: trip.booking_type ?? trip.trip_type,
    is_scheduled: trip.is_scheduled,
    scheduled_status: trip.scheduled_status ?? trip.scheduledStatus,
    dispatch_mode: trip.dispatch_mode ?? trip.dispatchMode,
    scheduled_at: trip.scheduled_at ?? trip.scheduledAt,
    scheduled_broadcast_at: trip.scheduled_broadcast_at,
    scheduled_convert_at: trip.scheduled_convert_at,
    confirmed_driver_id: trip.confirmed_driver_id ?? trip.confirmedDriverId,
    driver_id: trip.driver_id ?? trip.driverId,
    nowMs,
  };

  const eligibility = resolveCustomerLiveTripEligibility(eligibilityInput);
  const status = normalizeLiveTripStatus(trip.status);
  const rematching = isRematchStatus(status);
  const stage = eligibility.terminal
    ? "ended"
    : resolveLifecycleStage(status, rematching);
  const copy = copyForStage(stage);

  const driverNode =
    trip.driver && typeof trip.driver === "object" && !Array.isArray(trip.driver)
      ? (trip.driver as Record<string, unknown>)
      : null;
  const vehicleNode =
    (driverNode?.vehicle &&
    typeof driverNode.vehicle === "object" &&
    !Array.isArray(driverNode.vehicle)
      ? (driverNode.vehicle as Record<string, unknown>)
      : null) ??
    (trip.vehicle && typeof trip.vehicle === "object" && !Array.isArray(trip.vehicle)
      ? (trip.vehicle as Record<string, unknown>)
      : null);

  const assignedDriverId = rematching || !eligibility.eligible
    ? null
    : (readString(trip.confirmed_driver_id) ??
      readString(trip.confirmedDriverId) ??
      readString(driverNode?.id) ??
      readString(trip.driver_id) ??
      null);

  const showDriver = Boolean(assignedDriverId) && !rematching && eligibility.eligible;

  const nextVehicleRegistrationRaw = showDriver
    ? (readString(vehicleNode?.registration) ??
      readString(vehicleNode?.license_plate) ??
      readString(trip.license_plate) ??
      readString(trip.vehicle_registration))
    : null;
  const nextVehicleRegistration = showDriver
    ? formatVehicleRegistration(nextVehicleRegistrationRaw)
    : null;

  const previousGen = Number(args.previous?.assignment_generation ?? 0) || 0;
  const previousDriverId = args.previous?.assigned_driver_id ?? null;
  const assignmentGeneration = nextAssignmentGeneration({
    previousGeneration: previousGen,
    previousDriverId,
    nextDriverId: assignedDriverId,
    rematching,
    previousVehicleRegistration: args.previous?.vehicle_registration ?? null,
    nextVehicleRegistration,
  });

  const previousPresentation = Number(args.previous?.presentation_version ?? 0) || 0;
  const presentationVersion = previousPresentation + 1;

  const etaResolution = resolveAuthoritativeLiveTripEta({
    lifecycleStage: stage,
    showDriver,
    nowMs,
    etaOverrideMinutes:
      args.etaOverrideMinutes ??
      readNumber(driverNode?.etaMinutes) ??
      readNumber(driverNode?.eta_minutes) ??
      readNumber(trip.eta_minutes) ??
      null,
    cachedRoute: args.cachedRoute ?? null,
    lastEtaMinutes: readNumber(trip.last_eta_minutes),
    lastEtaCalculatedAt: readString(trip.last_eta_calculated_at),
  });
  const etaMinutes = etaResolution.etaMinutes;

  const ratingCount =
    readNumber(driverNode?.rating_count) ?? readNumber(trip.driver_rating_count);
  const ratingRaw = readNumber(driverNode?.rating) ?? readNumber(trip.driver_rating);
  const driverRating =
    showDriver && ratingCount != null && ratingCount > 0 ? ratingRaw : null;

  // Never treat category / licensing docs as vehicle photo — only explicit vehicle photo URL.
  const vehiclePhotoUrl = showDriver
    ? (readString(vehicleNode?.photo_url) ??
      readString(vehicleNode?.vehicle_photo_url) ??
      null)
    : null;
  // Category side-art key (bundled on client) — never a photo URL (MK-261117-007).
  const vehicleImageKey = showDriver
    ? (readString(vehicleNode?.image_key) ??
      readString(vehicleNode?.imageKey) ??
      readString(vehicleNode?.category) ??
      "go")
    : null;

  const updatedAt = new Date(nowMs).toISOString();
  const staleMs =
    stage === "finding_new_driver" || stage === "finding_driver"
      ? 15 * 60_000
      : 8 * 60_000;
  const staleAt = new Date(nowMs + staleMs).toISOString();

  // ActivityKit ContentState required keys (OneCabLiveTripAttributes.swift).
  // Missing non-optional fields → APNs update accepted by Apple but decode-dropped
  // on device (MK-261117-004: Lock Screen stuck on Finding while arrive FCM landed).
  const contentState: Record<string, unknown> = {
    phase: stage,
    statusTitle: copy.status_title,
    statusDescription: copy.status_description,
    etaLabel: etaResolution.etaLabel,
    etaFresh: etaResolution.fresh,
    etaSource: etaResolution.source,
    progressStepIndex: copy.progress_step_index,
    showDriverVehicle: showDriver,
    assignedDriverId: assignedDriverId ?? "unassigned",
    assignmentGeneration,
    presentationVersion,
    // Required by iOS ActivityAttributes.ContentState — never omit.
    assignmentEventMs: nowMs,
    driverFirstName: showDriver
      ? firstName(
          readString(driverNode?.first_name) ??
            readString(driverNode?.firstName) ??
            readString(trip.driver_first_name),
        )
      : null,
    driverPhotoUrl: showDriver
      ? (readString(driverNode?.photo_url) ??
        readString(driverNode?.profile_photo_url) ??
        readString(trip.driver_photo_url))
      : null,
    driverRatingLabel:
      driverRating != null && Number.isFinite(driverRating)
        ? driverRating.toFixed(1)
        : null,
    vehiclePhotoUrl,
    vehicleImageKey,
    ...(() => {
      if (!showDriver) {
        return { vehicleMake: null as string | null, vehicleModel: null as string | null };
      }
      const cleaned = sanitizeMakeModel({
        make: readString(vehicleNode?.make) ?? readString(trip.vehicle_make),
        model: readString(vehicleNode?.model) ?? readString(trip.vehicle_model),
        registration: nextVehicleRegistrationRaw,
      });
      return { vehicleMake: cleaned.make, vehicleModel: cleaned.model };
    })(),
    vehicleColour: showDriver ? vehicleColour(trip, vehicleNode) : null,
    vehicleRegistration: nextVehicleRegistration,
    silent: true,
    updatedAtMs: nowMs,
    // Assignment identity only — never append presentationVersion (lexicographic
    // compare of …|9 vs …|10 froze Lock Screen updates after the 10th publish).
    assignmentEpoch: [
      tripId,
      assignedDriverId ?? "unassigned",
      showDriver
        ? plateIdentity(
          readString(vehicleNode?.license_plate) ??
            readString(vehicleNode?.registration) ??
            "",
        )
        : "",
      String(assignmentGeneration),
    ].join("|"),
  };

  return {
    trip_id: tripId,
    customer_user_id: args.customerUserId,
    customer_id: args.customerId ?? null,
    eligible: eligibility.eligible,
    terminal: eligibility.terminal,
    lifecycle_stage: stage,
    assignment_generation: assignmentGeneration,
    presentation_version: presentationVersion,
    assigned_driver_id: assignedDriverId,
    driver_first_name: contentState.driverFirstName as string | null,
    driver_photo_url: contentState.driverPhotoUrl as string | null,
    driver_rating: driverRating,
    driver_rating_count: showDriver ? ratingCount : null,
    vehicle_make: contentState.vehicleMake as string | null,
    vehicle_model: contentState.vehicleModel as string | null,
    vehicle_colour: contentState.vehicleColour as string | null,
    vehicle_registration: contentState.vehicleRegistration as string | null,
    vehicle_photo_url: vehiclePhotoUrl,
    eta_minutes: etaMinutes,
    status_title: copy.status_title,
    status_description: copy.status_description,
    progress_step_index: copy.progress_step_index,
    content_state: contentState,
    updated_at: updatedAt,
    stale_at: eligibility.eligible ? staleAt : null,
  };
}
