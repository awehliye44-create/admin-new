import {
  isScheduledHandoverOpenJobStatus,
  isScheduledInstantConversionPending,
  isScheduledWorkflowOrigin,
} from "./scheduledHandoverHoldLock.ts";
import { type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  isRestoreActiveTripStatus,
  isRestoreTerminalTripStatus,
  normalizeRestoreTripStatus,
  RESTORE_ASSIGNED_ACTIVE_STATUSES,
  resolveLifecycleActionFromTrip,
  type RestoreActiveTripRole,
} from "../../../shared/activeTripRestoreSSOT.ts";
import {
  buildPickupWaitingSnapshot,
  buildStopWaitingSnapshot,
  loadAdminWaitingConfig,
} from "./waitingAdminConfig.ts";

type TripRow = Record<string, unknown>;

const SEARCHING_STATUSES = new Set([
  "pending",
  "searching",
  "offered",
  "offering",
  "broadcasting",
  "searching_new_driver",
  "driver_cancelled",
]);

const CUSTOMER_LIVE_PRE_PICKUP = [
  "accepted",
  "confirmed",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
] as const;

const ASSIGNED_ACTIVE_SET = new Set(
  RESTORE_ASSIGNED_ACTIVE_STATUSES as readonly string[],
);

function isScheduledTrip(row: TripRow): boolean {
  const bookingType = String(row.booking_type ?? row.trip_type ?? "").toLowerCase();
  if (bookingType === "instant" || bookingType === "immediate") return false;
  if (bookingType === "scheduled") return true;
  return row.is_scheduled === true;
}

function scheduledDispatchWindowReached(row: TripRow, nowMs: number): boolean {
  const dispatchMode = String(row.dispatch_mode ?? "").toLowerCase();
  if (dispatchMode === "instant") return true;
  for (const key of ["scheduled_broadcast_at", "scheduled_convert_at", "scheduled_at"]) {
    const raw = row[key];
    if (typeof raw === "string") {
      const ms = new Date(raw).getTime();
      if (Number.isFinite(ms) && ms <= nowMs) return true;
    }
  }
  return false;
}

/** Customer restore candidate — SSOT statuses win; local dispatch window only gates pre-assign scheduled. */
function isCustomerRestoreCandidate(row: TripRow, nowMs: number): boolean {
  const status = normalizeRestoreTripStatus(String(row.status ?? ""));
  if (!status || isRestoreTerminalTripStatus(status)) return false;
  if (SEARCHING_STATUSES.has(status) && !isScheduledInstantConversionPending(row)) {
    const expires = row.searching_expires_at;
    if (typeof expires === "string") {
      const ms = new Date(expires).getTime();
      if (Number.isFinite(ms) && nowMs >= ms && !isScheduledWorkflowOrigin(row)) {
        return false;
      }
    }
  }
  if (
    isScheduledInstantConversionPending(row) &&
    isScheduledHandoverOpenJobStatus(status)
  ) {
    return true;
  }
  if (!isRestoreActiveTripStatus(status, "customer")) return false;
  if (!isScheduledTrip(row)) return true;
  const hasDriver = Boolean(row.driver_id || row.confirmed_driver_id);
  if (hasDriver && ASSIGNED_ACTIVE_SET.has(status)) return true;
  if (status === "scheduled" || status === "scheduled_committed") {
    return hasDriver || scheduledDispatchWindowReached(row, nowMs);
  }
  return scheduledDispatchWindowReached(row, nowMs);
}

async function clearCustomerActiveTripPointer(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  await supabase.from("customers").update({ active_trip_id: null }).eq("user_id", userId);
}

export async function findCustomerActiveTrip(
  supabase: SupabaseClient,
  userId: string,
): Promise<TripRow | null> {
  const nowMs = Date.now();
  const { data: customers } = await supabase
    .from("customers")
    .select("id, active_trip_id")
    .eq("user_id", userId);
  const customer = customers?.[0];
  if (!customer) return null;

  let trip: TripRow | null = null;

  if (customer.active_trip_id) {
    const { data: rows } = await supabase
      .from("trips")
      .select("*")
      .eq("id", customer.active_trip_id)
      .limit(1);
    const candidate = rows?.[0] as TripRow | undefined;
    if (candidate && isCustomerRestoreCandidate(candidate, nowMs)) {
      trip = candidate;
    } else if (candidate && isRestoreTerminalTripStatus(String(candidate.status ?? ""))) {
      await clearCustomerActiveTripPointer(supabase, userId);
    }
  }

  if (!trip) {
    const activeStates = [
      "payment_pending",
      "pending",
      "searching",
      "offered",
      "offering",
      "broadcasting",
      "negotiating",
      "driver_cancelled",
      "searching_new_driver",
      "queued",
      "scheduled_committed",
      ...CUSTOMER_LIVE_PRE_PICKUP,
      "in_progress",
      "completing",
      "arrived_at_stop",
      "drive_to_next_stop",
      "scheduled",
    ];
    const { data: instantTrips } = await supabase
      .from("trips")
      .select("*")
      .eq("passenger_id", customer.id)
      .in("status", activeStates)
      .or("is_scheduled.is.null,is_scheduled.eq.false")
      .order("created_at", { ascending: false })
      .limit(10);
    trip =
      ((instantTrips ?? []) as TripRow[]).find((candidate) =>
        isCustomerRestoreCandidate(candidate, nowMs)
      ) ?? null;
    if (!trip) {
      const { data: scheduledTrips } = await supabase
        .from("trips")
        .select("*")
        .eq("passenger_id", customer.id)
        .eq("is_scheduled", true)
        .in("status", activeStates)
        .order("created_at", { ascending: false })
        .limit(10);
      trip =
        ((scheduledTrips ?? []) as TripRow[]).find((candidate) =>
          isCustomerRestoreCandidate(candidate, nowMs)
        ) ?? null;
    }
  }

  return trip;
}

export async function findDriverActiveTrip(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ trip: TripRow | null; driverId: string | null }> {
  const { data: driver } = await supabase
    .from("drivers")
    .select("id, current_trip_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!driver?.id) return { trip: null, driverId: null };

  const driverId = String(driver.id);
  const activeStatuses = [
    "accepted",
    "confirmed",
    "driver_assigned",
    "en_route",
    "en_route_to_pickup",
    "enroute_to_pickup",
    "driver_en_route",
    "driver_arriving",
    "arrived",
    "arrived_pickup",
    "arrived_at_pickup",
    "at_pickup",
    "pickup_waiting",
    "waiting",
    "waiting_at_pickup",
    "driver_arrived",
    "in_progress",
    "on_trip",
    "started",
    "ongoing",
    "completing",
    "arrived_at_stop",
    "drive_to_next_stop",
    "queued",
    "scheduled_committed",
  ];

  if (driver.current_trip_id) {
    const { data: pointerTrip } = await supabase
      .from("trips")
      .select("*")
      .eq("id", driver.current_trip_id)
      .maybeSingle();
    if (
      pointerTrip
      && isRestoreActiveTripStatus(String(pointerTrip.status ?? ""), "driver")
    ) {
      return { trip: pointerTrip as TripRow, driverId };
    }
  }

  const { data: fallbackTrips } = await supabase
    .from("trips")
    .select("*")
    .or(`driver_id.eq.${driverId},confirmed_driver_id.eq.${driverId}`)
    .in("status", activeStatuses)
    .order("updated_at", { ascending: false })
    .limit(1);

  return {
    trip: (fallbackTrips?.[0] as TripRow | undefined) ?? null,
    driverId,
  };
}

export async function loadTripStops(
  supabase: SupabaseClient,
  tripId: string,
): Promise<TripRow[]> {
  const { data } = await supabase
    .from("trip_stops")
    .select("*")
    .eq("trip_id", tripId)
    .order("stop_index", { ascending: true });
  return (data ?? []) as TripRow[];
}

export function buildRestoreLocation(row: TripRow, prefix: "pickup" | "dropoff") {
  const addressKey = prefix === "pickup" ? "pickup_address" : "dropoff_address";
  const latKey = prefix === "pickup" ? "pickup_latitude" : "dropoff_latitude";
  const lngKey = prefix === "pickup" ? "pickup_longitude" : "dropoff_longitude";
  return {
    address: typeof row[addressKey] === "string" ? row[addressKey] : null,
    lat: row[latKey] != null ? Number(row[latKey]) : null,
    lng: row[lngKey] != null ? Number(row[lngKey]) : null,
  };
}

/**
 * Customer-safe assigned driver + active approved vehicle projection.
 * Never exposes phone, identity docs, or compliance images.
 *
 * Profile photos live in the private `driver-documents` bucket — public object
 * URLs 400. Mint a short-lived signed URL so the Customer Image can render it.
 */
function extractDriverDocumentStoragePath(fileUrl: string): string | null {
  const trimmed = fileUrl.trim();
  if (!trimmed) return null;

  const patterns = [
    /\/storage\/v1\/object\/(?:public|sign)\/driver-documents\/(.+)/,
    /\/storage\/v1\/object\/driver-documents\/(.+)/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return match[1].split("?")[0];
  }
  if (!trimmed.startsWith("http")) return trimmed;
  return null;
}

async function resolveCustomerRenderableDriverPhotoUrl(
  supabase: SupabaseClient,
  driverId: string,
  columnPhotoUrl: string | null,
): Promise<string | null> {
  const signOrPassthrough = async (raw: string): Promise<string | null> => {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const storagePath = extractDriverDocumentStoragePath(trimmed);
    if (storagePath) {
      const { data, error } = await supabase.storage
        .from("driver-documents")
        .createSignedUrl(storagePath, 60 * 60); // 1 hour
      if (!error && data?.signedUrl) return data.signedUrl;
    }

    // External HTTPS (CDN) — usable as-is. Never return private storage paths.
    if (
      trimmed.startsWith("https://") &&
      !trimmed.includes("/storage/v1/object/")
    ) {
      return trimmed;
    }
    return null;
  };

  if (columnPhotoUrl) {
    const fromColumn = await signOrPassthrough(columnPhotoUrl);
    if (fromColumn) return fromColumn;
  }

  const { data: doc } = await supabase
    .from("documents")
    .select("file_url")
    .eq("driver_id", driverId)
    .eq("document_type", "profile_photo")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const docUrl = typeof doc?.file_url === "string" ? doc.file_url.trim() : "";
  if (!docUrl) return null;
  return signOrPassthrough(docUrl);
}

async function buildCustomerSafeAssignedDriver(
  supabase: SupabaseClient,
  driverId: string,
  trip: TripRow,
  role: RestoreActiveTripRole,
): Promise<Record<string, unknown> | null> {
  const { data: driverRow } = await supabase
    .from("drivers")
    .select(
      "id, first_name, last_name, profile_photo_url, rating, display_rating, driver_code, current_lat, current_lng, heading",
    )
    .eq("id", driverId)
    .maybeSingle();
  if (!driverRow) return null;

  const { data: approvedRows } = await supabase
    .from("vehicles")
    .select(
      "id, make, model, color, license_plate, is_primary, approval_status, vehicle_type_id",
    )
    .eq("driver_id", driverId)
    .eq("approval_status", "approved")
    .order("is_primary", { ascending: false })
    .limit(1);
  let vehicleRow = (approvedRows?.[0] as Record<string, unknown> | undefined) ?? null;

  // Fall back to any vehicle for the driver so Customer card colour / plate
  // still hydrate when approval_status is pending / legacy-null.
  if (!vehicleRow) {
    const { data: anyRows } = await supabase
      .from("vehicles")
      .select(
        "id, make, model, color, license_plate, is_primary, approval_status, vehicle_type_id",
      )
      .eq("driver_id", driverId)
      .order("is_primary", { ascending: false })
      .limit(1);
    vehicleRow = (anyRows?.[0] as Record<string, unknown> | undefined) ?? null;
  }

  let category: string | null = null;
  const vehicleTypeId =
    (vehicleRow?.vehicle_type_id as string | null | undefined) ??
    (typeof trip.vehicle_type_id === "string" ? trip.vehicle_type_id : null);
  if (vehicleTypeId) {
    const { data: typeRow } = await supabase
      .from("vehicle_types")
      .select("name, slug")
      .eq("id", vehicleTypeId)
      .maybeSingle();
    category =
      (typeof typeRow?.name === "string" && typeRow.name) ||
      (typeof typeRow?.slug === "string" && typeRow.slug) ||
      null;
  }

  const colour =
    typeof vehicleRow?.color === "string" && vehicleRow.color.trim()
      ? vehicleRow.color.trim()
      : null;
  const columnPhoto =
    typeof driverRow.profile_photo_url === "string" &&
      driverRow.profile_photo_url.trim()
      ? driverRow.profile_photo_url.trim()
      : null;
  // Customer must receive a renderable signed URL; raw storage paths 400.
  const photoUrl =
    role === "customer"
      ? await resolveCustomerRenderableDriverPhotoUrl(
        supabase,
        driverId,
        columnPhoto,
      )
      : columnPhoto;
  const rating =
    typeof driverRow.display_rating === "number" &&
      Number.isFinite(driverRow.display_rating)
      ? driverRow.display_rating
      : typeof driverRow.rating === "number" && Number.isFinite(driverRow.rating)
      ? driverRow.rating
      : null;

  const vehicle = vehicleRow
    ? {
      id: vehicleRow.id,
      make: vehicleRow.make ?? null,
      model: vehicleRow.model ?? null,
      colour,
      color: colour,
      registration: vehicleRow.license_plate ?? null,
      license_plate: vehicleRow.license_plate ?? null,
      category,
      image_key: category ? String(category).toLowerCase() : null,
    }
    : null;

  // Customer role: strip private fields. Driver role may keep lat/lng for self-restore.
  if (role === "customer") {
    return {
      id: driverRow.id,
      first_name: driverRow.first_name ?? null,
      firstName: driverRow.first_name ?? null,
      last_name: driverRow.last_name ?? null,
      lastName: driverRow.last_name ?? null,
      driver_code: driverRow.driver_code ?? null,
      rating,
      profile_photo_url: photoUrl,
      photo_url: photoUrl,
      photoUrl,
      current_lat: driverRow.current_lat ?? null,
      current_lng: driverRow.current_lng ?? null,
      latitude: driverRow.current_lat ?? null,
      longitude: driverRow.current_lng ?? null,
      heading:
        typeof driverRow.heading === "number" && Number.isFinite(driverRow.heading)
          ? driverRow.heading
          : null,
      vehicle,
    };
  }

  return {
    id: driverRow.id,
    first_name: driverRow.first_name ?? null,
    last_name: driverRow.last_name ?? null,
    profile_photo_url: photoUrl,
    rating,
    display_rating: driverRow.display_rating ?? rating,
    driver_code: driverRow.driver_code ?? null,
    current_lat: driverRow.current_lat ?? null,
    current_lng: driverRow.current_lng ?? null,
    heading:
      typeof driverRow.heading === "number" && Number.isFinite(driverRow.heading)
        ? driverRow.heading
        : null,
    vehicle,
  };
}

export async function buildRestoreActiveTripPayload(
  supabase: SupabaseClient,
  trip: TripRow,
  role: RestoreActiveTripRole,
  stops: TripRow[],
): Promise<Record<string, unknown>> {
  const tripId = String(trip.id ?? "");
  const status = String(trip.status ?? "");
  const lifecycle_action = resolveLifecycleActionFromTrip(
    {
      status,
      started_at: typeof trip.started_at === "string" ? trip.started_at : null,
      current_stop_index: trip.current_stop_index != null
        ? Number(trip.current_stop_index)
        : null,
    },
    stops,
  );

  let driver: Record<string, unknown> | null = null;
  let customer: Record<string, unknown> | null = null;

  const resolvedDriverId = trip.confirmed_driver_id ?? trip.driver_id;
  if (resolvedDriverId) {
    driver = await buildCustomerSafeAssignedDriver(
      supabase,
      String(resolvedDriverId),
      trip,
      role,
    );
  }

  if (trip.passenger_id && role === "driver") {
    const { data: customerRow } = await supabase
      .from("customers")
      .select("id, first_name, last_name, phone, user_id")
      .eq("id", trip.passenger_id)
      .maybeSingle();
    if (customerRow) customer = customerRow as Record<string, unknown>;
  }

  // Project trip-SA waiting SSOT so reconnect restores the same timers/fees.
  const config = await loadAdminWaitingConfig(
    supabase,
    typeof trip.service_area_id === "string" ? trip.service_area_id : null,
    typeof trip.vehicle_type_id === "string" ? trip.vehicle_type_id : null,
  );
  const driverArrivedAt =
    (typeof trip.pickup_arrived_at === "string" && trip.pickup_arrived_at) ||
    (typeof trip.driver_arrived_at === "string" && trip.driver_arrived_at) ||
    (typeof trip.arrived_at === "string" && trip.arrived_at) ||
    null;
  const pickupWaitingStatus = driverArrivedAt
    ? (String(trip.status ?? "").toLowerCase().includes("progress") ||
        String(trip.status ?? "").toLowerCase() === "in_progress"
      ? "not_started"
      : "free_waiting")
    : "not_started";
  const pickupSnapshot = buildPickupWaitingSnapshot({
    driverArrivedAt,
    waitingStatus: pickupWaitingStatus as
      | "not_started"
      | "blocked_outside_radius"
      | "free_waiting"
      | "paid_waiting",
    config,
  });

  const currentStop = stops.find((s) => {
    const idx = Number(s.stop_index ?? -1);
    const type = String(s.type ?? s.stop_type ?? "").toLowerCase();
    return (
      type !== "pickup" &&
      type !== "dropoff" &&
      (String(s.status ?? "").toLowerCase() === "current" ||
        String(s.status ?? "").toLowerCase() === "arrived" ||
        (typeof trip.current_stop_index === "number" &&
          idx === Number(trip.current_stop_index)))
    );
  });
  const stopArrivedAt =
    (currentStop && typeof currentStop.arrived_at === "string"
      ? currentStop.arrived_at
      : null) ||
    (typeof trip.stop_arrived_at === "string" ? trip.stop_arrived_at : null);
  const stopSnapshot = buildStopWaitingSnapshot({
    stopArrivedAt,
    waitingStatus: stopArrivedAt ? "free_waiting" : "not_started",
    config,
  });

  const waitingSnapshot =
    String(status).toLowerCase().includes("stop") || stopArrivedAt
      ? stopSnapshot
      : pickupSnapshot;

  const enrichedTrip: TripRow = {
    ...trip,
    pickup_waiting_admin_config:
      trip.pickup_waiting_admin_config ?? config,
    admin_waiting_config_snapshot: config,
    waiting_snapshot: waitingSnapshot,
    driver_arrived_at: pickupSnapshot.driver_arrived_at,
    pickup_arrived_at:
      trip.pickup_arrived_at ?? pickupSnapshot.driver_arrived_at,
    pickup_waiting_free_expires_at:
      pickupSnapshot.pickup_waiting_free_expires_at,
    stop_waiting_free_expires_at: stopSnapshot.stop_waiting_free_expires_at,
    no_show_eligible_at: pickupSnapshot.no_show_eligible_at,
    no_show_eligible: pickupSnapshot.no_show_eligible,
    no_show_remaining_seconds: pickupSnapshot.no_show_remaining_seconds,
    can_mark_no_show: pickupSnapshot.no_show_eligible,
    free_pickup_waiting_seconds: config.free_pickup_waiting_seconds,
    free_stop_waiting_seconds: config.free_stop_waiting_seconds,
  };

  return {
    has_active_trip: true,
    trip_id: tripId,
    trip_code: trip.trip_code ?? null,
    role,
    status,
    lifecycle_action,
    pickup: buildRestoreLocation(trip, "pickup"),
    dropoff: buildRestoreLocation(trip, "dropoff"),
    stops,
    fare: {
      fare: trip.fare ?? null,
      estimated_fare: trip.estimated_fare ?? null,
      final_fare_pence: trip.final_fare_pence ?? null,
      final_customer_fare_pence: trip.final_customer_fare_pence ?? null,
      gross_fare_pence: trip.gross_fare_pence ?? null,
      currency_code: trip.currency_code ?? null,
    },
    payment_status: trip.payment_status ?? null,
    payment_session_id: trip.payment_session_id ?? null,
    driver,
    customer,
    updated_at: trip.updated_at ?? null,
    waiting_snapshot: waitingSnapshot,
    admin_waiting_config_snapshot: config,
    no_show_eligible_at: pickupSnapshot.no_show_eligible_at,
    no_show_eligible: pickupSnapshot.no_show_eligible,
    no_show_remaining_seconds: pickupSnapshot.no_show_remaining_seconds,
    trip: enrichedTrip,
  };
}

export function buildRestoreNonePayload(role: RestoreActiveTripRole): Record<string, unknown> {
  return {
    has_active_trip: false,
    trip_id: null,
    trip_code: null,
    role,
    status: null,
    lifecycle_action: null,
    pickup: null,
    dropoff: null,
    stops: [],
    fare: null,
    payment_status: null,
    driver: null,
    customer: null,
    updated_at: null,
  };
}
