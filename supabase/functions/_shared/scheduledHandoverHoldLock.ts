/**
 * Scheduled → instant handover lock (MK-260817-006).
 *
 * Instant customer-search TTL must not start at scheduled booking created_at.
 * A premature system expiry must not void a still-valid Revolut authorisation
 * before same-trip conversion has run (or been genuinely exhausted).
 *
 * Payment follows trip lifecycle. Authorised hold does not keep a trip alive.
 */

export const SCHEDULED_CONVERT_STATUS = "converted_to_instant";

const CUSTOMER_CANCEL_ACTORS = new Set([
  "customer",
  "passenger",
  "user",
  "rider",
]);

const ADMIN_CANCEL_ACTORS = new Set([
  "admin",
  "ops",
  "operator",
  "support",
]);

const SEARCH_EXPIRY_REASONS = new Set([
  "search_expired",
  "scheduled_expired",
  "sweep_fallback",
  "no_driver_search_exhausted",
  "no_driver_assigned",
]);

const EXPLICIT_CANCEL_REASONS = new Set([
  "customer_cancel",
  "admin_cancel",
  "driver_cancel_terminal",
]);

function norm(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase().replace(/-/g, "_");
}

export function isAuthoritativeCustomerCancel(input: {
  cancelledBy?: string | null;
  cancellationReason?: string | null;
  dispositionReason?: string | null;
}): boolean {
  if (CUSTOMER_CANCEL_ACTORS.has(norm(input.cancelledBy))) return true;
  if (norm(input.dispositionReason) === "customer_cancel") return true;
  const reason = norm(input.cancellationReason);
  return reason.includes("customer_cancel") || reason === "cancelled_by_customer";
}

export function isAuthoritativeAdminCancel(input: {
  cancelledBy?: string | null;
  cancellationReason?: string | null;
  dispositionReason?: string | null;
}): boolean {
  if (ADMIN_CANCEL_ACTORS.has(norm(input.cancelledBy))) return true;
  if (norm(input.dispositionReason) === "admin_cancel") return true;
  const reason = norm(input.cancellationReason);
  return reason.includes("admin_cancel") || reason === "cancelled_by_admin";
}

export function isAuthoritativeNoShowOrFeeTerminal(input: {
  tripStatus?: string | null;
  dispositionReason?: string | null;
  feePence?: number | null;
}): boolean {
  if (norm(input.tripStatus) === "no_show") return true;
  const reason = norm(input.dispositionReason);
  if (reason.includes("no_show") || reason.includes("no-show")) return true;
  const fee = Math.round(Number(input.feePence ?? 0));
  return Number.isFinite(fee) && fee > 0;
}

/**
 * True while the trip is still on the scheduled reservation/broadcast path
 * and has not been flipped onto same-trip instant searching.
 */
export function isScheduledInstantConversionPending(trip: {
  dispatch_mode?: string | null;
  scheduled_status?: string | null;
}): boolean {
  const mode = norm(trip.dispatch_mode);
  const scheduledStatus = norm(trip.scheduled_status);
  if (scheduledStatus === SCHEDULED_CONVERT_STATUS) return false;
  if (mode === "instant") return false;
  return mode === "scheduled";
}

export function isScheduledWorkflowOrigin(trip: {
  dispatch_mode?: string | null;
  scheduled_status?: string | null;
  is_scheduled?: boolean | null;
  scheduled_at?: string | null;
}): boolean {
  if (isScheduledInstantConversionPending(trip)) return true;
  if (trip.is_scheduled === true) return true;
  if (norm(trip.dispatch_mode) === "scheduled") return true;
  if (norm(trip.scheduled_status).length > 0) return true;
  return Boolean(String(trip.scheduled_at ?? "").trim());
}

function isSystemSearchOrNoDriverExpiry(input: {
  tripStatus?: string | null;
  scheduledStatus?: string | null;
  dispositionReason?: string | null;
}): boolean {
  const status = norm(input.tripStatus);
  const scheduledStatus = norm(input.scheduledStatus);
  const reason = norm(input.dispositionReason);
  if (EXPLICIT_CANCEL_REASONS.has(reason)) return false;
  if (SEARCH_EXPIRY_REASONS.has(reason)) return true;
  if (status === "expired" || status === "expired_no_driver") return true;
  if (scheduledStatus === "no_driver_found") return true;
  return false;
}

/**
 * Defensive payment lock: do not void an AUTHORISED hold when a scheduled
 * job was system-expired before scheduled→instant conversion completed.
 *
 * Does not infer customer cancel from status=expired or payment_status=cancelled.
 */
export function shouldBlockPrematureScheduledSearchHoldRelease(input: {
  tripStatus?: string | null;
  cancelledBy?: string | null;
  cancellationReason?: string | null;
  dispatchMode?: string | null;
  scheduledStatus?: string | null;
  isScheduled?: boolean | null;
  scheduledAt?: string | null;
  dispositionReason?: string | null;
  feePence?: number | null;
}): boolean {
  if (
    isAuthoritativeCustomerCancel({
      cancelledBy: input.cancelledBy,
      cancellationReason: input.cancellationReason,
      dispositionReason: input.dispositionReason,
    })
  ) {
    return false;
  }
  if (
    isAuthoritativeAdminCancel({
      cancelledBy: input.cancelledBy,
      cancellationReason: input.cancellationReason,
      dispositionReason: input.dispositionReason,
    })
  ) {
    return false;
  }
  if (
    isAuthoritativeNoShowOrFeeTerminal({
      tripStatus: input.tripStatus,
      dispositionReason: input.dispositionReason,
      feePence: input.feePence,
    })
  ) {
    return false;
  }

  const conversionCompleted =
    norm(input.dispatchMode) === "instant" ||
    norm(input.scheduledStatus) === SCHEDULED_CONVERT_STATUS;
  if (conversionCompleted) return false;

  if (
    !isScheduledWorkflowOrigin({
      dispatch_mode: input.dispatchMode,
      scheduled_status: input.scheduledStatus,
      is_scheduled: input.isScheduled,
      scheduled_at: input.scheduledAt,
    })
  ) {
    return false;
  }

  return isSystemSearchOrNoDriverExpiry({
    tripStatus: input.tripStatus,
    scheduledStatus: input.scheduledStatus,
    dispositionReason: input.dispositionReason,
  });
}
