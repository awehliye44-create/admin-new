/**
 * FCM outcome → booking_delivery_log (Dispatch Metrics SSOT).
 *
 * Restores historical `push_sent` / `push_failed` writes that metrics expect.
 * Delivery is primary: telemetry failures must never throw or trigger resend.
 *
 * Historical shape (2026-08-10): source=edge, detail with devices_ok, results[],
 * provider_response — but NEVER store raw FCM device tokens.
 */

export type FcmAttemptResult = {
  platform: string;
  success: boolean;
  error?: string | null;
  providerResponse?: string | null;
  notificationChannel?: string | null;
};

export type FcmPushInstrumentationInput = {
  bookingId: string | null | undefined;
  driverId: string | null | undefined;
  offerId?: string | null | undefined;
  notificationType: string;
  title?: string | null;
  reminderIndex?: number | null;
  results: FcmAttemptResult[];
  atIso?: string;
  /** Safe audit fields (no tokens / secrets). */
  eventType?: string | null;
  changeRequestId?: string | null;
  modificationVersion?: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/** Pick trip/booking UUID from common payload keys. */
export function resolveBookingIdFromPushData(
  data: Record<string, unknown> | null | undefined,
): string | null {
  if (!data) return null;
  const keys = ["booking_id", "bookingId", "trip_id", "tripId", "ride_id", "rideId"];
  for (const key of keys) {
    const raw = data[key];
    if (typeof raw === "string" && isUuid(raw)) return raw.trim();
  }
  return null;
}

export function resolveOfferIdFromPushData(
  data: Record<string, unknown> | null | undefined,
): string | null {
  if (!data) return null;
  const keys = [
    "offer_id",
    "offerId",
    "request_id",
    "requestId",
    // Trip-modification idempotency key (applied trip_change_requests.id).
    "change_request_id",
    "changeRequestId",
    "modification_id",
    "modificationId",
  ];
  for (const key of keys) {
    const raw = data[key];
    if (typeof raw === "string" && isUuid(raw)) return raw.trim();
  }
  return null;
}

/**
 * One logical notification → one terminal phase.
 * Prefer push_sent if any attempt succeeded (never write both for the same call).
 * Returns null when no FCM attempt ran (e.g. no tokens — not an FCM failure).
 */
export function resolveFcmTerminalPhase(
  results: FcmAttemptResult[],
): "push_sent" | "push_failed" | null {
  if (!Array.isArray(results) || results.length === 0) return null;
  if (results.some((r) => r.success === true)) return "push_sent";
  return "push_failed";
}

function safeErrorMessage(error: unknown): string | null {
  if (error == null) return null;
  const s = String(error).trim();
  if (!s) return null;
  // Never leak bearer/service-account material if it ever appears in err text.
  if (/BEGIN PRIVATE KEY|ya29\.|AIza/i.test(s)) return "provider_error_redacted";
  return s.slice(0, 240);
}

function safeProviderResponse(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const t = name.trim();
  if (!t) return null;
  // FCM v1 returns projects/.../messages/...
  if (t.length > 200) return t.slice(0, 200);
  return t;
}

export function notificationChannelForPlatform(
  platform: string,
  isRideOffer: boolean,
): string {
  const p = platform.toLowerCase();
  if (p === "ios") return isRideOffer ? "apns_time_sensitive" : "apns_default";
  if (p === "android") {
    return isRideOffer ? "onecab_driver_offers" : "android_default";
  }
  return "unknown";
}

/**
 * Historical-compatible detail without device tokens / secrets.
 */
export function buildFcmPushDeliveryDetail(
  input: FcmPushInstrumentationInput,
): Record<string, unknown> {
  const results = (input.results ?? []).map((r) => ({
    platform: r.platform,
    success: r.success === true,
    error: r.success ? null : safeErrorMessage(r.error),
    notification_channel: r.notificationChannel ?? null,
    provider_response: safeProviderResponse(r.providerResponse),
    // Historical rows had `token`; we intentionally omit it.
    token_present: true,
  }));

  const devicesOk = results.filter((r) => r.success).length;

  return {
    at: input.atIso ?? new Date().toISOString(),
    devices_ok: devicesOk,
    notification_type: input.notificationType,
    reminder_index: input.reminderIndex ?? null,
    results,
    title: input.title ?? null,
    total_tokens: results.length,
    edge: "send-driver-notification",
    event_type: input.eventType ?? null,
    change_request_id: input.changeRequestId ?? null,
    modification_version: input.modificationVersion ?? null,
  };
}

export type BookingDeliveryPhaseWriteInput = {
  bookingId: string | null | undefined;
  driverId: string | null | undefined;
  offerId?: string | null | undefined;
  phase: string;
  detail?: Record<string, unknown>;
};

/**
 * Best-effort booking_delivery_log write for enqueue / skip phases.
 * Never throws. Never implies FCM failure / resend.
 */
export async function recordBookingDeliveryPhaseBestEffort(
  supabase: RpcClient,
  input: BookingDeliveryPhaseWriteInput,
): Promise<{ recorded: boolean }> {
  if (!isUuid(input.bookingId) || !isUuid(input.driverId)) {
    return { recorded: false };
  }
  if (input.offerId != null && input.offerId !== "" && !isUuid(input.offerId)) {
    return { recorded: false };
  }

  try {
    const { error } = await supabase.rpc("record_booking_delivery", {
      p_booking_id: String(input.bookingId).trim(),
      p_phase: input.phase,
      p_driver_id: String(input.driverId).trim(),
      p_offer_id: input.offerId && isUuid(input.offerId)
        ? String(input.offerId).trim()
        : null,
      p_source: "edge",
      p_detail: {
        edge: "send-driver-notification",
        at: new Date().toISOString(),
        ...(input.detail ?? {}),
      },
    });
    if (error) {
      console.warn(
        "[fcmPushDeliveryInstrumentation] record_booking_delivery phase failed (delivery unaffected):",
        input.phase,
        error.message ?? error,
      );
      return { recorded: false };
    }
    return { recorded: true };
  } catch (err) {
    console.warn(
      "[fcmPushDeliveryInstrumentation] record_booking_delivery phase threw (delivery unaffected):",
      input.phase,
      err,
    );
    return { recorded: false };
  }
}

export function shouldRecordFcmPushOutcome(
  input: FcmPushInstrumentationInput,
): boolean {
  if (!isUuid(input.bookingId) || !isUuid(input.driverId)) return false;
  if (input.offerId != null && input.offerId !== "" && !isUuid(input.offerId)) {
    return false;
  }
  return resolveFcmTerminalPhase(input.results) != null;
}

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ error: { message?: string } | null }>;
};

/**
 * Best-effort SSOT write. Never throws. Never implies FCM failure on telemetry error.
 */
export async function recordFcmPushOutcomeBestEffort(
  supabase: RpcClient,
  input: FcmPushInstrumentationInput,
): Promise<{ recorded: boolean; phase: "push_sent" | "push_failed" | null }> {
  const phase = resolveFcmTerminalPhase(input.results);
  if (!shouldRecordFcmPushOutcome(input) || phase == null) {
    return { recorded: false, phase };
  }

  const detail = buildFcmPushDeliveryDetail(input);

  try {
    const { error } = await supabase.rpc("record_booking_delivery", {
      p_booking_id: String(input.bookingId).trim(),
      p_phase: phase,
      p_driver_id: String(input.driverId).trim(),
      p_offer_id: input.offerId && isUuid(input.offerId)
        ? String(input.offerId).trim()
        : null,
      p_source: "edge",
      p_detail: detail,
    });
    if (error) {
      console.warn(
        "[fcmPushDeliveryInstrumentation] record_booking_delivery failed (delivery unaffected):",
        phase,
        error.message ?? error,
      );
      return { recorded: false, phase };
    }
    return { recorded: true, phase };
  } catch (err) {
    console.warn(
      "[fcmPushDeliveryInstrumentation] record_booking_delivery threw (delivery unaffected):",
      phase,
      err,
    );
    return { recorded: false, phase };
  }
}
