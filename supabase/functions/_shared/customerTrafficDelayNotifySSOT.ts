/**
 * #79A — Scheduled late-driver traffic_delay: durable one-shot SSOT (pure).
 *
 * I/O / claim / send lives in customerTrafficDelayNotify.ts.
 * Mirrors customer_refund_notification_deliveries claim semantics with a
 * reclaimable sending lease so a crash before dispatch does not permanently
 * lose the notification, while terminal statuses never flood.
 */

import { isTripTerminalForDispatch } from "./tripTerminalDispatch.ts";

export const TRAFFIC_DELAY_EVENT = "traffic_delay" as const;
export const TRAFFIC_DELAY_SEND_LEASE_MS = 90_000;

/** Mirrors LIVE_PICKUP_EN_ROUTE_STATUSES — keep in sync with lateness SSOT. */
const LIVE_PICKUP_EN_ROUTE = new Set(["en_route_to_pickup", "en_route"]);

function isLivePickupEnRouteStatus(status: string | null | undefined): boolean {
  return LIVE_PICKUP_EN_ROUTE.has(String(status ?? "").trim().toLowerCase());
}

export type TrafficDelayDeliveryStatus =
  | "sending"
  | "sent"
  | "skipped"
  | "failed"
  | "ambiguous";

export type TrafficDelayClaimDecision =
  | { action: "insert_new" }
  | { action: "reclaim"; reason: "failed" | "sending_lease_expired" }
  | { action: "skip"; reason: "already_terminal" | "in_flight" | "obsolete" };

export const SCHEDULED_TRAFFIC_DELAY_TITLE = "Your driver is running late";

/** Body when authoritative live trip state confirms driver still en route to pickup. */
export const SCHEDULED_TRAFFIC_DELAY_BODY_EN_ROUTE =
  "Your driver is running late — still on the way to pick you up.";

/** Fallback body when we must not claim en-route wording. */
export const SCHEDULED_TRAFFIC_DELAY_BODY_GENERIC =
  "Your driver is running late.";

export function buildScheduledTrafficDelayCopy(input: {
  status: string | null | undefined;
}): { title: string; body: string } {
  const liveEnRoute = isLivePickupEnRouteStatus(input.status);
  return {
    title: SCHEDULED_TRAFFIC_DELAY_TITLE,
    body: liveEnRoute
      ? SCHEDULED_TRAFFIC_DELAY_BODY_EN_ROUTE
      : SCHEDULED_TRAFFIC_DELAY_BODY_GENERIC,
  };
}

/**
 * Suppress notify after arrival / cancel / complete (and sticky scheduled_status alone).
 */
export function isScheduledTrafficDelayObsolete(input: {
  status: string | null | undefined;
  scheduledStatus?: string | null;
}): boolean {
  if (
    isTripTerminalForDispatch({
      status: input.status,
      scheduled_status: input.scheduledStatus,
    })
  ) {
    return true;
  }
  return !isLivePickupEnRouteStatus(input.status);
}

/**
 * Decide claim ownership from durable row state.
 * Concurrent workers: UNIQUE(notification_id) + this decision.
 */
export function decideTrafficDelayClaim(input: {
  existing: {
    status: string;
    updatedAtIso: string;
  } | null;
  nowMs: number;
  obsolete: boolean;
}): TrafficDelayClaimDecision {
  if (input.obsolete) {
    return { action: "skip", reason: "obsolete" };
  }
  if (!input.existing) {
    return { action: "insert_new" };
  }
  const status = String(input.existing.status ?? "").trim().toLowerCase();
  if (status === "sent" || status === "skipped" || status === "ambiguous") {
    return { action: "skip", reason: "already_terminal" };
  }
  if (status === "failed") {
    return { action: "reclaim", reason: "failed" };
  }
  if (status === "sending") {
    const updatedMs = Date.parse(String(input.existing.updatedAtIso));
    const stale =
      !Number.isFinite(updatedMs) ||
      input.nowMs - updatedMs >= TRAFFIC_DELAY_SEND_LEASE_MS;
    if (stale) {
      return { action: "reclaim", reason: "sending_lease_expired" };
    }
    return { action: "skip", reason: "in_flight" };
  }
  // Unknown status — fail closed (no flood).
  return { action: "skip", reason: "already_terminal" };
}

/**
 * Map send-trip-notification / FCM outcomes to ledger status.
 * Ambiguous provider outcomes are terminal to avoid resend loops.
 */
export function resolveTrafficDelayDeliveryOutcome(input: {
  httpOk: boolean;
  sent: number | null;
  reason: string | null;
  throwError?: boolean;
}): {
  status: TrafficDelayDeliveryStatus;
  skippedReason?: string;
  errorMessage?: string;
} {
  if (input.throwError) {
    return { status: "failed", errorMessage: "notify_threw" };
  }
  if (!input.httpOk) {
    return { status: "failed", errorMessage: "http_not_ok" };
  }
  const reason = String(input.reason ?? "").trim().toLowerCase();
  if (reason === "no_tokens") {
    return { status: "skipped", skippedReason: "no_tokens" };
  }
  if (typeof input.sent === "number" && input.sent > 0) {
    return { status: "sent" };
  }
  if (typeof input.sent === "number" && input.sent === 0) {
    // Explicit zero without no_tokens — treat as skip (no device), not retry flood.
    return { status: "skipped", skippedReason: "sent_zero" };
  }
  // Ambiguous: HTTP ok but no clear sent count — do not resend.
  return { status: "ambiguous", errorMessage: "provider_outcome_ambiguous" };
}

/** Stable Android tag / APNs collapse-id for scheduled traffic_delay. */
export function trafficDelayCollapseId(notificationId: string): string {
  return String(notificationId ?? "").trim();
}
