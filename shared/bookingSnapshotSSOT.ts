/**
 * Canonical booking_snapshot SSOT for digital payment preauth.
 *
 * Every Revolut/card/Apple Pay/Google Pay preauth must persist the same
 * payload so AUTHORISED holds can finalize via finalize_paid_booking_session
 * (and recovery sweeps never fail with booking_snapshot_incomplete).
 */

export const BOOKING_SNAPSHOT_VERSION = 1 as const;

/** Max age of snapshot.created_at accepted at preauth (stale quote/fare). */
export const BOOKING_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

export const BOOKING_SNAPSHOT_ERROR = {
  REQUIRED: "BOOKING_SNAPSHOT_REQUIRED",
  INCOMPLETE: "BOOKING_SNAPSHOT_INCOMPLETE",
} as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CanonicalBookingLocation = {
  address: string;
  formatted_address?: string;
  full_raw_address?: string;
  lat: number;
  lng: number;
  postcode?: string;
  city?: string;
  road?: string;
};

export type BuildCanonicalBookingSnapshotInput = {
  clientActionId: string;
  /** Stable draft id — defaults to client_action_id when omitted. */
  bookingDraftId?: string | null;
  customerId?: string | null;
  serviceAreaId: string;
  vehicleTypeId: string;
  pickup: CanonicalBookingLocation;
  dropoff: CanonicalBookingLocation;
  stops?: CanonicalBookingLocation[];
  when: "NOW" | "SCHEDULED";
  scheduledAt?: string | null;
  passengerName: string;
  passengerPhone: string;
  passengerCount?: number;
  luggageOption?: string | null;
  accessibilityOptions?: string[] | null;
  petOption?: string | null;
  /** Final payable major units (pounds) — CTAP / create-ride compat. */
  estimatedFareMajor: number;
  /** Gross before discount, major units. */
  originalEstimatedFareMajor?: number;
  /** Discount in major units (legacy CTAP field). */
  discountAmountMajor?: number;
  discountSource?: "global_offer" | "personal_voucher" | string | null;
  finalEstimatedFarePence: number;
  grossFarePence: number;
  discountAmountPence?: number;
  currencyCode: string;
  paymentMethod: string;
  bookingSource?: string;
  estimatedDistanceKm?: number;
  estimatedDurationMinutes?: number;
  pricingMode?: string | null;
  platformPaymentMethodId?: string | null;
  preAssignedDriverId?: string | null;
  personalVoucherCode?: string | null;
  appliedOfferId?: string | null;
  appliedPersonalVoucherId?: string | null;
  fareQuoteId?: string | null;
  /** Override; otherwise derived from fare + route + vehicle. */
  canonicalFareVersion?: string | null;
  createdAt?: string;
  snapshotVersion?: number;
};

export type CanonicalBookingSnapshot = {
  snapshot_version: number;
  created_at: string;
  booking_draft_id: string;
  client_action_id: string;
  customer_id: string | null;
  service_area_id: string;
  vehicle_type_id: string;
  selected_service_id: string;
  pickup: CanonicalBookingLocation;
  dropoff: CanonicalBookingLocation;
  stops?: CanonicalBookingLocation[];
  when: "NOW" | "SCHEDULED";
  scheduled_at?: string;
  passenger_name: string;
  passenger_phone: string;
  passenger_count: number;
  luggage_option: string | null;
  accessibility_options: string[] | null;
  pet_option: string | null;
  estimated_fare: number;
  original_estimated_fare?: number;
  discount_amount?: number;
  discount_source?: string;
  final_estimated_fare_pence: number;
  gross_fare_pence: number;
  discount_amount_pence: number;
  currency_code: string;
  payment_method: string;
  booking_source: string;
  canonical_fare_version: string;
  fare_quote_id: string | null;
  estimated_distance?: number;
  estimated_duration?: number;
  pricing_mode?: string;
  platform_payment_method_id?: string;
  pre_assigned_driver_id?: string;
  personal_voucher_code?: string;
  applied_offer_id?: string | null;
  applied_personal_voucher_id?: string | null;
};

export function deriveCanonicalFareVersion(args: {
  serviceAreaId: string;
  vehicleTypeId: string;
  grossFarePence: number;
  finalEstimatedFarePence: number;
  currencyCode: string;
  estimatedDistanceKm?: number;
  estimatedDurationMinutes?: number;
}): string {
  const dist = Number.isFinite(args.estimatedDistanceKm)
    ? Number(args.estimatedDistanceKm).toFixed(3)
    : "na";
  const dur = Number.isFinite(args.estimatedDurationMinutes)
    ? String(Math.round(Number(args.estimatedDurationMinutes)))
    : "na";
  return [
    "v1",
    args.serviceAreaId,
    args.vehicleTypeId,
    args.currencyCode.toUpperCase(),
    String(Math.round(args.grossFarePence)),
    String(Math.round(args.finalEstimatedFarePence)),
    dist,
    dur,
  ].join(":");
}

export function buildCanonicalBookingSnapshot(
  input: BuildCanonicalBookingSnapshotInput,
): CanonicalBookingSnapshot {
  const clientActionId = String(input.clientActionId ?? "").trim();
  const bookingDraftId = String(input.bookingDraftId ?? clientActionId).trim() || clientActionId;
  const serviceAreaId = String(input.serviceAreaId ?? "").trim();
  const vehicleTypeId = String(input.vehicleTypeId ?? "").trim();
  const currencyCode = String(input.currencyCode ?? "GBP").trim().toUpperCase() || "GBP";
  const paymentMethod = String(input.paymentMethod ?? "").trim().toLowerCase();
  const grossFarePence = Math.max(0, Math.round(Number(input.grossFarePence) || 0));
  const finalEstimatedFarePence = Math.max(
    0,
    Math.round(Number(input.finalEstimatedFarePence) || 0),
  );
  const discountAmountPence = Math.max(
    0,
    Math.round(Number(input.discountAmountPence ?? Math.max(0, grossFarePence - finalEstimatedFarePence))),
  );
  const canonicalFareVersion = String(
    input.canonicalFareVersion
      ?? deriveCanonicalFareVersion({
        serviceAreaId,
        vehicleTypeId,
        grossFarePence,
        finalEstimatedFarePence,
        currencyCode,
        estimatedDistanceKm: input.estimatedDistanceKm,
        estimatedDurationMinutes: input.estimatedDurationMinutes,
      }),
  ).trim();

  const snap: CanonicalBookingSnapshot = {
    snapshot_version: input.snapshotVersion ?? BOOKING_SNAPSHOT_VERSION,
    created_at: input.createdAt ?? new Date().toISOString(),
    booking_draft_id: bookingDraftId,
    client_action_id: clientActionId,
    customer_id: input.customerId?.trim() || null,
    service_area_id: serviceAreaId,
    vehicle_type_id: vehicleTypeId,
    selected_service_id: vehicleTypeId,
    pickup: normalizeLocation(input.pickup),
    dropoff: normalizeLocation(input.dropoff),
    when: input.when === "SCHEDULED" ? "SCHEDULED" : "NOW",
    passenger_name: String(input.passengerName ?? "").trim(),
    passenger_phone: String(input.passengerPhone ?? "").trim(),
    passenger_count: Math.max(1, Math.round(Number(input.passengerCount ?? 1)) || 1),
    luggage_option: input.luggageOption ?? null,
    accessibility_options: input.accessibilityOptions ?? null,
    pet_option: input.petOption ?? null,
    estimated_fare: Number(input.estimatedFareMajor),
    final_estimated_fare_pence: finalEstimatedFarePence,
    gross_fare_pence: grossFarePence,
    discount_amount_pence: discountAmountPence,
    currency_code: currencyCode,
    payment_method: paymentMethod,
    booking_source: String(input.bookingSource ?? "select_vehicle").trim() || "select_vehicle",
    canonical_fare_version: canonicalFareVersion,
    fare_quote_id: input.fareQuoteId?.trim() || null,
  };

  if (input.stops && input.stops.length > 0) {
    snap.stops = input.stops.map(normalizeLocation);
  }
  if (input.when === "SCHEDULED" && input.scheduledAt) {
    snap.scheduled_at = String(input.scheduledAt);
  }
  if (
    input.originalEstimatedFareMajor != null
    && Number.isFinite(input.originalEstimatedFareMajor)
  ) {
    snap.original_estimated_fare = Number(input.originalEstimatedFareMajor);
  }
  if (
    input.discountAmountMajor != null
    && Number.isFinite(input.discountAmountMajor)
    && Number(input.discountAmountMajor) > 0
  ) {
    snap.discount_amount = Number(input.discountAmountMajor);
  }
  if (input.discountSource) {
    snap.discount_source = String(input.discountSource);
  }
  if (input.estimatedDistanceKm != null && Number.isFinite(input.estimatedDistanceKm)) {
    snap.estimated_distance = Number(input.estimatedDistanceKm);
  }
  if (input.estimatedDurationMinutes != null && Number.isFinite(input.estimatedDurationMinutes)) {
    snap.estimated_duration = Number(input.estimatedDurationMinutes);
  }
  if (input.pricingMode) snap.pricing_mode = String(input.pricingMode);
  if (input.platformPaymentMethodId) {
    snap.platform_payment_method_id = String(input.platformPaymentMethodId);
  }
  if (input.preAssignedDriverId) {
    snap.pre_assigned_driver_id = String(input.preAssignedDriverId);
  }
  if (input.personalVoucherCode) {
    snap.personal_voucher_code = String(input.personalVoucherCode);
  }
  if (input.appliedOfferId !== undefined) {
    snap.applied_offer_id = input.appliedOfferId;
  }
  if (input.appliedPersonalVoucherId !== undefined) {
    snap.applied_personal_voucher_id = input.appliedPersonalVoucherId;
  }

  return snap;
}

function normalizeLocation(loc: CanonicalBookingLocation): CanonicalBookingLocation {
  const address = String(loc?.address ?? loc?.formatted_address ?? "").trim();
  return {
    address,
    formatted_address: String(loc?.formatted_address ?? address).trim() || address,
    ...(loc?.full_raw_address ? { full_raw_address: String(loc.full_raw_address) } : {}),
    lat: Number(loc?.lat),
    lng: Number(loc?.lng),
    ...(loc?.postcode ? { postcode: String(loc.postcode) } : {}),
    ...(loc?.city ? { city: String(loc.city) } : {}),
    ...(loc?.road ? { road: String(loc.road) } : {}),
  };
}

export type BookingSnapshotValidationResult =
  | { ok: true; snapshot: CanonicalBookingSnapshot }
  | {
    ok: false;
    error_code: typeof BOOKING_SNAPSHOT_ERROR[keyof typeof BOOKING_SNAPSHOT_ERROR];
    missing_fields: string[];
    message: string;
  };

function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

function locationReady(loc: unknown, prefix: string): string[] {
  const missing: string[] = [];
  if (!loc || typeof loc !== "object") {
    missing.push(prefix);
    return missing;
  }
  const l = loc as Record<string, unknown>;
  const address = String(l.address ?? l.formatted_address ?? "").trim();
  if (!address) missing.push(`${prefix}.address`);
  if (!Number.isFinite(Number(l.lat))) missing.push(`${prefix}.lat`);
  if (!Number.isFinite(Number(l.lng))) missing.push(`${prefix}.lng`);
  return missing;
}

/**
 * Fail-closed validation before provider order creation.
 * Empty / missing / incomplete / stale snapshots must never reach Revolut.
 */
export function validateCanonicalBookingSnapshot(
  raw: unknown,
  opts?: { nowMs?: number; maxAgeMs?: number },
): BookingSnapshotValidationResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error_code: BOOKING_SNAPSHOT_ERROR.REQUIRED,
      missing_fields: ["booking_snapshot"],
      message: "booking_snapshot is required for digital payment",
    };
  }

  const s = raw as Record<string, unknown>;
  if (Object.keys(s).length === 0) {
    return {
      ok: false,
      error_code: BOOKING_SNAPSHOT_ERROR.REQUIRED,
      missing_fields: ["booking_snapshot"],
      message: "booking_snapshot must not be empty",
    };
  }

  const missing: string[] = [];
  const clientActionId = String(s.client_action_id ?? "").trim();
  if (!clientActionId) missing.push("client_action_id");

  const bookingDraftId = String(s.booking_draft_id ?? clientActionId).trim();
  if (!bookingDraftId) missing.push("booking_draft_id");

  const serviceAreaId = String(s.service_area_id ?? "").trim();
  if (!serviceAreaId) missing.push("service_area_id");
  else if (!isUuid(serviceAreaId)) missing.push("service_area_id(invalid)");

  const vehicleTypeId = String(
    s.vehicle_type_id ?? s.selected_service_id ?? "",
  ).trim();
  if (!vehicleTypeId) missing.push("vehicle_type_id");
  else if (!isUuid(vehicleTypeId)) missing.push("vehicle_type_id(invalid)");

  const customerId = s.customer_id == null || s.customer_id === ""
    ? null
    : String(s.customer_id).trim();
  if (customerId && !isUuid(customerId)) missing.push("customer_id(invalid)");

  missing.push(...locationReady(s.pickup, "pickup"));
  missing.push(...locationReady(s.dropoff, "dropoff"));

  const paymentMethod = String(s.payment_method ?? "").trim().toLowerCase();
  if (!paymentMethod) missing.push("payment_method");

  const currencyCode = String(s.currency_code ?? "").trim();
  if (!currencyCode) missing.push("currency_code");

  const gross = Number(s.gross_fare_pence);
  const finalPence = Number(
    s.final_estimated_fare_pence
      ?? (typeof s.estimated_fare === "number" ? Math.round(s.estimated_fare * 100) : NaN),
  );
  if (!Number.isFinite(gross) || gross <= 0) missing.push("gross_fare_pence");
  if (!Number.isFinite(finalPence) || finalPence < 0) missing.push("final_estimated_fare_pence");

  const fareVersion = String(s.canonical_fare_version ?? "").trim();
  if (!fareVersion) missing.push("canonical_fare_version");

  const snapshotVersion = Number(s.snapshot_version ?? NaN);
  if (!Number.isFinite(snapshotVersion) || snapshotVersion < 1) {
    missing.push("snapshot_version");
  }

  const createdAtRaw = String(s.created_at ?? "").trim();
  if (!createdAtRaw) missing.push("created_at");
  else {
    const createdMs = Date.parse(createdAtRaw);
    if (!Number.isFinite(createdMs)) {
      missing.push("created_at(invalid)");
    } else {
      const nowMs = opts?.nowMs ?? Date.now();
      const maxAge = opts?.maxAgeMs ?? BOOKING_SNAPSHOT_MAX_AGE_MS;
      if (createdMs > nowMs + 60_000 || nowMs - createdMs > maxAge) {
        missing.push("created_at(stale)");
      }
    }
  }

  const when = String(s.when ?? "NOW").toUpperCase();
  if (when === "SCHEDULED" && !String(s.scheduled_at ?? "").trim()) {
    missing.push("scheduled_at");
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error_code: BOOKING_SNAPSHOT_ERROR.INCOMPLETE,
      missing_fields: missing,
      message: `booking_snapshot incomplete: ${missing.join(",")}`,
    };
  }

  // Re-normalize through builder so stored shape is canonical.
  const pickup = s.pickup as CanonicalBookingLocation;
  const dropoff = s.dropoff as CanonicalBookingLocation;
  const stops = Array.isArray(s.stops)
    ? (s.stops as CanonicalBookingLocation[])
    : undefined;

  const snapshot = buildCanonicalBookingSnapshot({
    clientActionId,
    bookingDraftId,
    customerId,
    serviceAreaId,
    vehicleTypeId,
    pickup,
    dropoff,
    stops,
    when: when === "SCHEDULED" ? "SCHEDULED" : "NOW",
    scheduledAt: s.scheduled_at ? String(s.scheduled_at) : null,
    passengerName: String(s.passenger_name ?? ""),
    passengerPhone: String(s.passenger_phone ?? ""),
    passengerCount: Number(s.passenger_count ?? 1),
    luggageOption: (s.luggage_option as string | null) ?? null,
    accessibilityOptions: (s.accessibility_options as string[] | null) ?? null,
    petOption: (s.pet_option as string | null) ?? null,
    estimatedFareMajor: Number(
      s.estimated_fare ?? finalPence / 100,
    ),
    originalEstimatedFareMajor:
      s.original_estimated_fare != null ? Number(s.original_estimated_fare) : gross / 100,
    discountAmountMajor: s.discount_amount != null ? Number(s.discount_amount) : undefined,
    discountSource: s.discount_source != null ? String(s.discount_source) : null,
    finalEstimatedFarePence: finalPence,
    grossFarePence: gross,
    discountAmountPence: Number(s.discount_amount_pence ?? Math.max(0, gross - finalPence)),
    currencyCode,
    paymentMethod,
    bookingSource: String(s.booking_source ?? "select_vehicle"),
    estimatedDistanceKm: s.estimated_distance != null ? Number(s.estimated_distance) : undefined,
    estimatedDurationMinutes:
      s.estimated_duration != null ? Number(s.estimated_duration) : undefined,
    pricingMode: s.pricing_mode != null ? String(s.pricing_mode) : null,
    platformPaymentMethodId: s.platform_payment_method_id
      ? String(s.platform_payment_method_id)
      : null,
    preAssignedDriverId: s.pre_assigned_driver_id
      ? String(s.pre_assigned_driver_id)
      : null,
    personalVoucherCode: s.personal_voucher_code
      ? String(s.personal_voucher_code)
      : null,
    appliedOfferId: (s.applied_offer_id as string | null) ?? null,
    appliedPersonalVoucherId: (s.applied_personal_voucher_id as string | null) ?? null,
    fareQuoteId: s.fare_quote_id != null ? String(s.fare_quote_id) : null,
    canonicalFareVersion: fareVersion,
    createdAt: createdAtRaw,
    snapshotVersion: snapshotVersion,
  });

  return { ok: true, snapshot };
}

/** Lightweight readiness for recovery/webhook.
 * Accepts canonical snapshots OR legacy preauth payloads that still have
 * the fields finalize_paid_booking_session needs (pickup/dropoff/service/client).
 */
export function bookingSnapshotReady(snapshot: unknown): boolean {
  if (validateCanonicalBookingSnapshot(snapshot, {
    // Recovery may run minutes after preauth — do not fail solely on age here.
    maxAgeMs: 24 * 60 * 60 * 1000,
  }).ok) {
    return true;
  }
  // Legacy card snapshots written before snapshot_version SSOT.
  if (!snapshot || typeof snapshot !== "object") return false;
  const s = snapshot as Record<string, unknown>;
  const pickup = s.pickup as Record<string, unknown> | undefined;
  const dropoff = s.dropoff as Record<string, unknown> | undefined;
  return Boolean(
    (pickup?.address || s.pickup_address)
    && (dropoff?.address || s.dropoff_address)
    && s.service_area_id
    && s.client_action_id,
  );
}
