/**
 * Hydrate assigned driver + vehicle onto the trip payload for Live Trip projection.
 *
 * publish-customer-live-trip previously selected trips.* only — confirmed_driver_id
 * was set but first_name / vehicle / photos were always null (MK-261116-011/012).
 * Reuses the same customer-safe signing path pattern as restore-active-trip.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const DRIVER_DOCUMENTS_BUCKET = "driver-documents";
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h — Lock Screen refresh will re-sign

function readString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

async function resolveCustomerRenderableDriverPhotoUrl(
  admin: SupabaseClient,
  driverId: string,
  columnPhotoUrl: string | null,
): Promise<string | null> {
  const signOrPassthrough = async (raw: string): Promise<string | null> => {
    const value = raw.trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    const { data, error } = await admin.storage
      .from(DRIVER_DOCUMENTS_BUCKET)
      .createSignedUrl(value, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  };

  if (columnPhotoUrl) {
    const fromColumn = await signOrPassthrough(columnPhotoUrl);
    if (fromColumn) return fromColumn;
  }

  const { data: doc } = await admin
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

/**
 * Merge nested `driver` (+ `vehicle`) onto a trips row for projection SSOT.
 * No-op when no assigned driver id. Never invents photos or third-party branding.
 */
export async function hydrateLiveTripAssignmentIdentity(
  admin: SupabaseClient,
  trip: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const driverId =
    readString(trip.confirmed_driver_id) ??
    readString(trip.confirmedDriverId) ??
    readString(trip.driver_id);
  if (!driverId) return trip;

  // Already hydrated (tests / callers) — keep.
  const existing =
    trip.driver && typeof trip.driver === "object" && !Array.isArray(trip.driver)
      ? (trip.driver as Record<string, unknown>)
      : null;
  if (existing && readString(existing.first_name ?? existing.firstName)) {
    return trip;
  }

  const { data: driverRow } = await admin
    .from("drivers")
    .select(
      "id, first_name, last_name, profile_photo_url, rating, display_rating, rating_count",
    )
    .eq("id", driverId)
    .maybeSingle();
  if (!driverRow) return trip;

  const { data: approvedRows } = await admin
    .from("vehicles")
    .select(
      "id, make, model, color, license_plate, is_primary, approval_status",
    )
    .eq("driver_id", driverId)
    .eq("approval_status", "approved")
    .order("is_primary", { ascending: false })
    .limit(1);
  let vehicleRow = (approvedRows?.[0] as Record<string, unknown> | undefined) ??
    null;
  if (!vehicleRow) {
    const { data: anyRows } = await admin
      .from("vehicles")
      .select(
        "id, make, model, color, license_plate, is_primary, approval_status",
      )
      .eq("driver_id", driverId)
      .order("is_primary", { ascending: false })
      .limit(1);
    vehicleRow = (anyRows?.[0] as Record<string, unknown> | undefined) ?? null;
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
  const photoUrl = await resolveCustomerRenderableDriverPhotoUrl(
    admin,
    driverId,
    columnPhoto,
  );
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
      // Never invent a vehicle photo from category branding.
      photo_url: null,
    }
    : null;

  return {
    ...trip,
    driver: {
      id: driverRow.id,
      first_name: driverRow.first_name ?? null,
      firstName: driverRow.first_name ?? null,
      last_name: driverRow.last_name ?? null,
      rating,
      rating_count: driverRow.rating_count ?? null,
      profile_photo_url: photoUrl,
      photo_url: photoUrl,
      vehicle,
    },
    vehicle,
  };
}
