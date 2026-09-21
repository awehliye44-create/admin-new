/**
 * Fire-and-forget RIDE_STOP push so the driver app clears active trip / offer UI
 * and can play Trip Cancelled (cancel-flavored stop is audible in send-driver-notification).
 */
export type NotifyDriverTripStoppedParams = {
  tripId: string;
  stopReason?: string;
  cancelledBy?: string | null;
  offerId?: string;
  /** Push notification body shown on device */
  body?: string;
};

export async function notifyDriverTripStopped(
  supabaseUrl: string,
  serviceKey: string,
  driverId: string,
  params: NotifyDriverTripStoppedParams,
): Promise<void> {
  const stopReason = params.stopReason ?? "passenger_cancelled";
  const enqueuedAt = new Date().toISOString();
  const data: Record<string, string> = {
    stopReason,
    stop_reason: stopReason,
    trip_id: params.tripId,
    tripId: params.tripId,
    booking_id: params.tripId,
    bookingId: params.tripId,
    event: "trip_cancelled",
    event_type: "trip_cancelled",
    type: "RIDE_STOP",
    enqueued_at: enqueuedAt,
    cancelled_at: enqueuedAt,
  };
  if (params.cancelledBy) {
    data.cancelled_by = params.cancelledBy;
    data.cancelledBy = params.cancelledBy;
  }
  if (params.offerId) {
    data.offer_id = params.offerId;
    data.offerId = params.offerId;
  }

  const body =
    params.body ??
    (params.cancelledBy === "passenger" ||
      params.cancelledBy === "customer" ||
      params.cancelledBy === "rider"
      ? "Rider cancelled this trip"
      : "Trip no longer available");

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        driverId,
        type: "RIDE_STOP",
        title: "Trip cancelled",
        body,
        data,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(
        `[notifyDriverTripStopped] RIDE_STOP push response ${resp.status}: ${errText}`,
      );
    }
  } catch (e) {
    console.warn(`[notifyDriverTripStopped] RIDE_STOP push error for ${driverId}:`, e);
  }
}
