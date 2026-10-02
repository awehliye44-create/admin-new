/**
 * Push trip_modified to the assigned Driver after a customer modification applies.
 * Complements Realtime trip_updated — required when the app is backgrounded or
 * Realtime is briefly disconnected (heads-up / OS notification).
 *
 * Envelope type stays TRIP_UPDATE (send-driver-notification allow-list).
 * data.type must be trip_modified so the Driver client routes correctly.
 *
 * Never throws — modification commit must not depend on FCM availability.
 * Callers must await this so the Edge isolate does not freeze before fetch completes.
 */
export type NotifyDriverTripModifiedParams = {
  tripId: string;
  modificationVersion: string | number;
  /** Applied trip_change_requests.id — idempotency key for booking_delivery_log. */
  changeRequestId?: string | null;
  modificationTypes?: string[];
  title?: string;
  body?: string;
};

export type NotifyDriverTripModifiedResult = {
  attempted: boolean;
  ok: boolean;
  status: number | null;
  skippedReason?: string;
};

export async function notifyDriverTripModified(
  supabaseUrl: string,
  serviceKey: string,
  driverId: string,
  params: NotifyDriverTripModifiedParams,
): Promise<NotifyDriverTripModifiedResult> {
  const version = String(params.modificationVersion);
  const types = (params.modificationTypes ?? []).filter(
    (t) => typeof t === "string" && t.trim().length > 0,
  );
  const changeRequestId =
    typeof params.changeRequestId === "string" && params.changeRequestId.trim().length > 0
      ? params.changeRequestId.trim()
      : null;
  const eventId = changeRequestId
    ? `trip_modified:${changeRequestId}`
    : `trip_modified:${params.tripId}:${version}`;

  const data: Record<string, string> = {
    type: "trip_modified",
    notification_type: "trip_modified",
    trip_id: params.tripId,
    tripId: params.tripId,
    modification_version: version,
    event_id: eventId,
    screen: "active_trip",
  };
  if (changeRequestId) {
    // Never put change_request_id into offer_id — booking_delivery_log.offer_id
    // FKs ride_offers(id). Idempotency / audit use detail.change_request_id.
    data.change_request_id = changeRequestId;
    data.changeRequestId = changeRequestId;
  }
  if (types.length > 0) {
    // FCM data values must be strings — JSON array for the client parser.
    data.modification_types = JSON.stringify(types);
  }

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
      body: JSON.stringify({
        driverId,
        type: "TRIP_UPDATE",
        title: params.title ?? "Trip updated",
        body: params.body ?? "Customer changed the trip.",
        data,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(
        `[notifyDriverTripModified] push response ${resp.status}: ${errText}`,
      );
      return { attempted: true, ok: false, status: resp.status };
    }
    console.log("[notifyDriverTripModified] sent", {
      driverId,
      tripId: params.tripId,
      version,
      changeRequestId,
    });
    return { attempted: true, ok: true, status: resp.status };
  } catch (e) {
    console.warn(`[notifyDriverTripModified] push error for ${driverId}:`, e);
    return { attempted: true, ok: false, status: null };
  }
}
