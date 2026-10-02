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
} from "./activeTripRestoreSSOT.ts";
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
  const scheduledStatus = String(row.scheduled_status ?? "").toLowerCase();
  // Admin HELD / pre-confirm / awaiting activation NRO: clock alone must not
  // treat the trip as an active restore candidate for Finding/Assigned.
  if (
    scheduledStatus === "admin_held" ||
    scheduledStatus === "awaiting_activation_accept" ||
    scheduledStatus === "driver_assigned" ||
    scheduledStatus === "scheduled_committed"
  ) {
    return false;
  }
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
  const scheduledStatus = String(row.scheduled_status ?? "").toLowerCase();
  // Keep HELD / reserved / awaiting-activation in restore so Scheduled list
  // handoff can observe them — but never via dispatch-window clock alone.
  if (
    scheduledStatus === "admin_held" ||
    scheduledStatus === "awaiting_activation_accept" ||
    scheduledStatus === "driver_assigned" ||
    scheduledStatus === "scheduled_committed"
  ) {
    return status === "scheduled" || status === "scheduled_committed" ||
      status === "accepted" || status === "confirmed";
  }
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Client/store trip_id hints must be UUID-shaped before any DB lookup. */
export function isRestoreKnownTripIdShape(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export type FindCustomerActiveTripOptions = {
  /**
   * Optional client/store hint. NEVER trusted without passenger_id ownership
   * verification against the authenticated Customer's row.
   */
  knownTripId?: string | null;
};

export type FindCustomerActiveTripResult = {
  trip: TripRow | null;
  /** True when a well-shaped knownTripId was supplied. */
  knownTripIdPresent: boolean;
  /** True when knownTripId was owned + restore-candidate (fast path hit). */
  knownTripHit: boolean;
};

const CUSTOMER_ACTIVE_SEARCH_STATES = [
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
] as const;

/**
 * Resolve the authenticated Customer's single canonical active trip.
 *
 * Fast path: knownTripId (or customers.active_trip_id) → ownership check →
 * candidate gate. Broad search only when pointer/hint miss.
 */
export async function findCustomerActiveTripDetailed(
  supabase: SupabaseClient,
  userId: string,
  options?: FindCustomerActiveTripOptions,
): Promise<FindCustomerActiveTripResult> {
  const nowMs = Date.now();
  const knownRaw =
    typeof options?.knownTripId === "string" ? options.knownTripId.trim() : "";
  const knownTripIdPresent = isRestoreKnownTripIdShape(knownRaw);
  const knownTripId = knownTripIdPresent ? knownRaw : null;

  const { data: customers } = await supabase
    .from("customers")
    .select("id, active_trip_id")
    .eq("user_id", userId);
  const customer = customers?.[0];
  if (!customer) {
    return { trip: null, knownTripIdPresent, knownTripHit: false };
  }

  let trip: TripRow | null = null;
  let knownTripHit = false;
  let loadedIds = new Set<string>();

  const tryCandidate = async (
    candidate: TripRow | undefined,
    opts: { fromKnownHint: boolean; clearPointerIfTerminal: boolean },
  ): Promise<boolean> => {
    if (!candidate?.id) return false;
    const id = String(candidate.id);
    loadedIds.add(id);
    // HARD RULE: never trust client trip_id without ownership verification.
    if (String(candidate.passenger_id ?? "") !== String(customer.id)) {
      return false;
    }
    if (isCustomerRestoreCandidate(candidate, nowMs)) {
      trip = candidate;
      if (opts.fromKnownHint) knownTripHit = true;
      return true;
    }
    if (
      opts.clearPointerIfTerminal &&
      isRestoreTerminalTripStatus(String(candidate.status ?? ""))
    ) {
      await clearCustomerActiveTripPointer(supabase, userId);
    }
    return false;
  };

  if (knownTripId) {
    const { data: rows } = await supabase
      .from("trips")
      .select("*")
      .eq("id", knownTripId)
      .limit(1);
    await tryCandidate(rows?.[0] as TripRow | undefined, {
      fromKnownHint: true,
      clearPointerIfTerminal: customer.active_trip_id === knownTripId,
    });
  }

  if (!trip && customer.active_trip_id) {
    const pointerId = String(customer.active_trip_id);
    if (!loadedIds.has(pointerId)) {
      const { data: rows } = await supabase
        .from("trips")
        .select("*")
        .eq("id", pointerId)
        .limit(1);
      await tryCandidate(rows?.[0] as TripRow | undefined, {
        fromKnownHint: false,
        clearPointerIfTerminal: true,
      });
    }
  }

  if (!trip) {
    // Instant ∥ scheduled broad search — independent, same ownership scope.
    const [instantResult, scheduledResult] = await Promise.all([
      supabase
        .from("trips")
        .select("*")
        .eq("passenger_id", customer.id)
        .in("status", [...CUSTOMER_ACTIVE_SEARCH_STATES])
        .or("is_scheduled.is.null,is_scheduled.eq.false")
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("trips")
        .select("*")
        .eq("passenger_id", customer.id)
        .eq("is_scheduled", true)
        .in("status", [...CUSTOMER_ACTIVE_SEARCH_STATES])
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    trip =
      ((instantResult.data ?? []) as TripRow[]).find((candidate) =>
        isCustomerRestoreCandidate(candidate, nowMs)
      ) ??
      ((scheduledResult.data ?? []) as TripRow[]).find((candidate) =>
        isCustomerRestoreCandidate(candidate, nowMs)
      ) ??
      null;
  }

  return { trip, knownTripIdPresent, knownTripHit };
}

export async function findCustomerActiveTrip(
  supabase: SupabaseClient,
  userId: string,
  options?: FindCustomerActiveTripOptions,
): Promise<TripRow | null> {
  const result = await findCustomerActiveTripDetailed(supabase, userId, options);
  return result.trip;
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

async function withBoundedTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => value as T | null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/**
 * Driver photo signing is enrichment only — must never block restore for
 * ~130s+ when Storage hangs. Bound to 2.5s; fall through without photo.
 * UNKNOWN whether Storage is the sole 132–135s zombie cause; this is a
 * justified safety bound on a non-authoritative enrichment await.
 */
const DRIVER_PHOTO_SIGN_TIMEOUT_MS = 2_500;

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
      const signed = await withBoundedTimeout(
        supabase.storage
          .from("driver-documents")
          .createSignedUrl(storagePath, 60 * 60)
          .then(({ data, error }) => {
            if (!error && data?.signedUrl) return data.signedUrl;
            return null;
          }),
        DRIVER_PHOTO_SIGN_TIMEOUT_MS,
      );
      if (signed) return signed;
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

  const doc = await withBoundedTimeout(
    supabase
      .from("documents")
      .select("file_url")
      .eq("driver_id", driverId)
      .eq("document_type", "profile_photo")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => data),
    DRIVER_PHOTO_SIGN_TIMEOUT_MS,
  );

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
  // Driver profile ∥ approved vehicle — independent reads.
  const [driverResult, approvedResult] = await Promise.all([
    supabase
      .from("drivers")
      .select(
        "id, first_name, last_name, profile_photo_url, rating, display_rating, driver_code, current_lat, current_lng, heading",
      )
      .eq("id", driverId)
      .maybeSingle(),
    supabase
      .from("vehicles")
      .select(
        "id, make, model, color, license_plate, is_primary, approval_status, vehicle_type_id",
      )
      .eq("driver_id", driverId)
      .eq("approval_status", "approved")
      .order("is_primary", { ascending: false })
      .limit(1),
  ]);
  const driverRow = driverResult.data;
  if (!driverRow) return null;

  let vehicleRow = (approvedResult.data?.[0] as Record<string, unknown> | undefined) ?? null;

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

  // Vehicle type name ∥ photo sign — independent after vehicle row known.
  const columnPhoto =
    typeof driverRow.profile_photo_url === "string" &&
      driverRow.profile_photo_url.trim()
      ? driverRow.profile_photo_url.trim()
      : null;

  const [typeRowResult, photoUrl] = await Promise.all([
    vehicleTypeId
      ? supabase
        .from("vehicle_types")
        .select("name, slug")
        .eq("id", vehicleTypeId)
        .maybeSingle()
      : Promise.resolve({ data: null as { name?: string; slug?: string } | null }),
    role === "customer"
      ? resolveCustomerRenderableDriverPhotoUrl(supabase, driverId, columnPhoto)
      : Promise.resolve(columnPhoto),
  ]);

  const typeRow = typeRowResult.data;
  category =
    (typeof typeRow?.name === "string" && typeRow.name) ||
    (typeof typeRow?.slug === "string" && typeRow.slug) ||
    null;

  const colour =
    typeof vehicleRow?.color === "string" && vehicleRow.color.trim()
      ? vehicleRow.color.trim()
      : null;
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
  timingHooks?: {
    onDriverMs?: (ms: number) => void;
    onWaitingMs?: (ms: number) => void;
  },
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
  const serviceAreaId =
    typeof trip.service_area_id === "string" ? trip.service_area_id : null;
  const vehicleTypeId =
    typeof trip.vehicle_type_id === "string" ? trip.vehicle_type_id : null;

  // Driver enrichment ∥ waiting Admin config — independent after trip+stops known.
  const driverStarted = Date.now();
  const waitingStarted = Date.now();
  const [driverResult, config] = await Promise.all([
    resolvedDriverId
      ? buildCustomerSafeAssignedDriver(
        supabase,
        String(resolvedDriverId),
        trip,
        role,
      )
      : Promise.resolve(null),
    loadAdminWaitingConfig(supabase, serviceAreaId, vehicleTypeId),
  ]);
  timingHooks?.onDriverMs?.(Date.now() - driverStarted);
  timingHooks?.onWaitingMs?.(Date.now() - waitingStarted);
  driver = driverResult;

  if (trip.passenger_id && role === "driver") {
    const { data: customerRow } = await supabase
      .from("customers")
      .select("id, first_name, last_name, phone, user_id")
      .eq("id", trip.passenger_id)
      .maybeSingle();
    if (customerRow) customer = customerRow as Record<string, unknown>;
  }

  // Project trip-SA waiting SSOT so reconnect restores the same timers/fees.
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
  const pickupWaitingCountedSeconds = Math.max(
    0,
    Math.floor(Number(trip.pickup_waiting_counted_seconds ?? 0)),
  );
  const stopWaitingCountedSeconds = Math.max(
    0,
    Math.floor(Number(trip.stop_waiting_counted_seconds ?? 0)),
  );
  const waitingGeofenceStatus =
    typeof trip.waiting_geofence_status === "string"
      ? trip.waiting_geofence_status
      : null;
  const pickupSnapshot = buildPickupWaitingSnapshot({
    driverArrivedAt,
    waitingStatus: pickupWaitingStatus as
      | "not_started"
      | "blocked_outside_radius"
      | "free_waiting"
      | "paid_waiting",
    config,
    countedInRadiusSeconds: driverArrivedAt ? pickupWaitingCountedSeconds : null,
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
    waiting_geofence_status: waitingGeofenceStatus,
    pickup_waiting_counted_seconds: pickupWaitingCountedSeconds,
    stop_waiting_counted_seconds: stopWaitingCountedSeconds,
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
    waiting_geofence_status: waitingGeofenceStatus,
    pickup_waiting_counted_seconds: pickupWaitingCountedSeconds,
    stop_waiting_counted_seconds: stopWaitingCountedSeconds,
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
