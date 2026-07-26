export const PICKUP_OUTSIDE_SERVICE_AREAS_MESSAGE = "Pickup is outside active service areas.";
export function hasValidPickupCoordinates(lat, lng) {
  return lat !== 0 && lng !== 0 && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}
/** Pure merge: geofence wins when present; flags dropdown conflicts. */ export function mergeServiceAreaFromGeofence(selectedServiceAreaId, geofenceServiceAreaId, meta, pickup) {
  const selected = selectedServiceAreaId ?? null;
  const geofence = geofenceServiceAreaId ?? null;
  const finalId = geofence ?? selected;
  const correctionApplied = !!geofence && !!selected && selected !== geofence;
  const finalMeta = geofence ? meta?.geofence : meta?.selected;
  return {
    selected_service_area_id: selected,
    geofence_service_area_id: geofence,
    final_service_area_id: finalId,
    correction_applied: correctionApplied,
    mismatch_blocked: !!pickup && !finalId,
    selected_service_area_code: meta?.selected?.code ?? null,
    selected_service_area_name: meta?.selected?.name ?? null,
    geofence_service_area_code: meta?.geofence?.code ?? null,
    geofence_service_area_name: meta?.geofence?.name ?? null,
    final_service_area_code: finalMeta?.code ?? null,
    final_service_area_name: finalMeta?.name ?? null,
    region_id: finalMeta?.region_id ?? null,
    pickup_lat: pickup?.lat ?? null,
    pickup_lng: pickup?.lng ?? null
  };
}
function rpcRowToResolution(row) {
  return {
    selected_service_area_id: row.selected_service_area_id ?? null,
    geofence_service_area_id: row.geofence_service_area_id ?? null,
    final_service_area_id: row.final_service_area_id ?? null,
    correction_applied: Boolean(row.correction_applied),
    mismatch_blocked: Boolean(row.mismatch_blocked),
    selected_service_area_code: row.selected_service_area_code ?? null,
    selected_service_area_name: null,
    geofence_service_area_code: row.geofence_service_area_code ?? null,
    geofence_service_area_name: null,
    final_service_area_code: row.final_service_area_code ?? null,
    final_service_area_name: null,
    region_id: row.region_id ?? null,
    pickup_lat: row.pickup_lat ?? null,
    pickup_lng: row.pickup_lng ?? null
  };
}
async function fetchServiceAreaMeta(supabase, serviceAreaId) {
  if (!serviceAreaId) return null;
  const { data } = await supabase.from("service_areas").select("id, code, name, region_id").eq("id", serviceAreaId).eq("is_active", true).maybeSingle();
  return data ?? null;
}
export async function resolveGeofenceServiceAreaId(supabase, pickupLat, pickupLng) {
  const { data, error } = await supabase.rpc("find_service_area_by_location", {
    p_lat: pickupLat,
    p_lng: pickupLng
  });
  if (error) {
    console.error("[resolveTripServiceArea] find_service_area_by_location failed:", error);
    throw error;
  }
  return typeof data === "string" ? data : data ?? null;
}
/** Prefer DB RPC (same logic as INSERT trigger); fallback to client-side merge. */ export async function resolveTripServiceAreaFromPickup(supabase, pickupLat, pickupLng, selectedServiceAreaId) {
  const { data: rpcData, error: rpcError } = await supabase.rpc("resolve_trip_service_area_from_pickup", {
    p_pickup_lat: pickupLat,
    p_pickup_lng: pickupLng,
    p_selected_service_area_id: selectedServiceAreaId ?? null
  });
  if (!rpcError && rpcData && typeof rpcData === "object") {
    const row = rpcData;
    const resolution = rpcRowToResolution(row);
    if (row.ok === false && row.error === "outside_all_service_areas") {
      return {
        ok: false,
        error: "outside_all_service_areas",
        resolution
      };
    }
    if (row.ok === true && resolution.final_service_area_id) {
      return {
        ok: true,
        resolution
      };
    }
  } else if (rpcError) {
    console.warn("[resolveTripServiceArea] RPC fallback:", rpcError.message);
  }
  const geofenceId = await resolveGeofenceServiceAreaId(supabase, pickupLat, pickupLng);
  const [selectedMeta, geofenceMeta] = await Promise.all([
    fetchServiceAreaMeta(supabase, selectedServiceAreaId ?? null),
    fetchServiceAreaMeta(supabase, geofenceId)
  ]);
  const resolution = mergeServiceAreaFromGeofence(selectedServiceAreaId, geofenceId, {
    selected: selectedMeta,
    geofence: geofenceMeta
  }, {
    lat: pickupLat,
    lng: pickupLng
  });
  if (!resolution.final_service_area_id) {
    resolution.mismatch_blocked = true;
    return {
      ok: false,
      error: "outside_all_service_areas",
      resolution
    };
  }
  return {
    ok: true,
    resolution
  };
}
export function applyServiceAreaToTripRow(tripRow, resolution) {
  return {
    ...tripRow,
    service_area_id: resolution.final_service_area_id,
    service_area_code: resolution.final_service_area_code ?? tripRow.service_area_code,
    region_id: resolution.region_id ?? tripRow.region_id
  };
}
export async function enforceTripServiceAreaForInsert(supabase, tripRow, options) {
  const result = await resolveTripServiceAreaFromPickup(supabase, options.pickupLat, options.pickupLng, options.selectedServiceAreaId ?? tripRow.service_area_id ?? null);
  if (!result.ok) {
    result.resolution.mismatch_blocked = true;
    await logServiceAreaEvent(supabase, null, "SERVICE_AREA_MISMATCH_BLOCKED", result.resolution, {
      booking_source: options.bookingSource
    });
    return {
      ok: false,
      resolution: result.resolution
    };
  }
  const tripWithSa = applyServiceAreaToTripRow(tripRow, result.resolution);
  return {
    ok: true,
    tripRow: tripWithSa,
    resolution: result.resolution
  };
}
export async function logServiceAreaEvent(supabase, tripId, eventType, resolution, extra = {}) {
  const details = {
    selected_service_area_id: resolution.selected_service_area_id,
    geofence_service_area_id: resolution.geofence_service_area_id,
    final_service_area_id: resolution.final_service_area_id,
    correction_applied: resolution.correction_applied,
    mismatch_blocked: resolution.mismatch_blocked,
    selected_service_area_code: resolution.selected_service_area_code,
    geofence_service_area_code: resolution.geofence_service_area_code,
    final_service_area_code: resolution.final_service_area_code,
    pickup_lat: resolution.pickup_lat ?? extra.pickup_lat ?? null,
    pickup_lng: resolution.pickup_lng ?? extra.pickup_lng ?? null,
    booking_source: extra.booking_source ?? null,
    ...extra
  };
  console.log(`[resolveTripServiceArea] ${eventType}`, details);
  const { error } = await supabase.rpc("log_audit_event", {
    p_event_type: eventType,
    p_trip_id: tripId,
    p_details: details
  });
  if (error) {
    console.warn("[resolveTripServiceArea] log_audit_event failed:", error);
  }
}
export async function logServiceAreaCorrection(supabase, tripId, resolution, extra = {}) {
  const eventType = resolution.correction_applied ? "SERVICE_AREA_CORRECTED_FROM_PICKUP" : "SERVICE_AREA_RESOLVED_FROM_PICKUP";
  await logServiceAreaEvent(supabase, tripId, eventType, resolution, extra);
}
/** Defense-in-depth at dispatch: correct trip row or block if pickup is outside all areas. */ export async function reconcileTripServiceAreaFromPickup(supabase, trip) {
  const lat = trip.pickup_latitude ?? 0;
  const lng = trip.pickup_longitude ?? 0;
  if (!hasValidPickupCoordinates(lat, lng)) return null;
  const result = await resolveTripServiceAreaFromPickup(supabase, lat, lng, trip.service_area_id ?? null);
  if (!result.ok) {
    result.resolution.mismatch_blocked = true;
    await logServiceAreaEvent(supabase, trip.id, "SERVICE_AREA_MISMATCH_BLOCKED", result.resolution, {
      reconciled_at: "auto_dispatch"
    });
    return result.resolution;
  }
  const { resolution } = result;
  if (resolution.final_service_area_id && resolution.final_service_area_id !== trip.service_area_id) {
    const { error } = await supabase.from("trips").update({
      service_area_id: resolution.final_service_area_id,
      region_id: resolution.region_id ?? trip.region_id ?? null,
      service_area_code: resolution.final_service_area_code ?? trip.service_area_code ?? null,
      updated_at: new Date().toISOString()
    }).eq("id", trip.id);
    if (error) {
      console.error("[resolveTripServiceArea] Failed to reconcile trip service area:", error);
    } else {
      await logServiceAreaCorrection(supabase, trip.id, resolution, {
        reconciled_at: "auto_dispatch"
      });
    }
  }
  return resolution;
}
