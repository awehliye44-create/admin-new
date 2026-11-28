/**
 * SN1 — Durable Customer lifecycle notify claim / anti-stale / outcome SSOT (pure).
 *
 * Extends #79A ledger semantics beyond traffic_delay:
 * pending → sending → sent | skipped | failed | ambiguous
 */

export const SN1_SEND_LEASE_MS = 90_000;
export const SN1_MAX_ATTEMPTS = 8;

export type LifecycleDeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "skipped"
  | "failed"
  | "ambiguous";

export type Sn1LifecycleKind =
  | "scheduled_booking_confirmed"
  | "scheduled_accept"
  | "scheduled_converted_to_instant"
  | "scheduled_cancel_rematch";

export function buildSn1NotificationId(
  kind: Sn1LifecycleKind,
  tripId: string,
): string {
  const id = String(tripId ?? "").trim();
  switch (kind) {
    case "scheduled_booking_confirmed":
      return `sn1:scheduled_booking_confirmed:${id}`;
    case "scheduled_accept":
      // Preserve historical id shape used by scheduled-ride-action.
      return `driver_assigned-${id}-scheduled_accept`;
    case "scheduled_converted_to_instant":
      return `sn1:scheduled_converted_to_instant:${id}`;
    case "scheduled_cancel_rematch":
      return `driver_cancelled-scheduled-${id}`;
  }
}

export function sn1KindFromNotificationId(
  notificationId: string,
): Sn1LifecycleKind | null {
  const id = String(notificationId ?? "").trim();
  if (id.startsWith("sn1:scheduled_booking_confirmed:")) {
    return "scheduled_booking_confirmed";
  }
  if (id.startsWith("sn1:scheduled_converted_to_instant:")) {
    return "scheduled_converted_to_instant";
  }
  if (/^driver_assigned-.+-scheduled_accept$/.test(id)) {
    return "scheduled_accept";
  }
  if (/^driver_cancelled-scheduled-.+$/.test(id)) {
    return "scheduled_cancel_rematch";
  }
  return null;
}

/** Defense in send-trip-notification: SN1 ids require a durable claim. */
export function isSn1LifecycleNotificationId(notificationId: string): boolean {
  return sn1KindFromNotificationId(notificationId) != null;
}

export type LifecycleClaimDecision =
  | { action: "insert_pending" }
  | { action: "already_durable" }
  | {
    action: "lease_sending";
    reason: "pending" | "failed" | "sending_lease_expired";
  }
  | { action: "skip"; reason: "already_terminal" | "in_flight" | "max_attempts" };

export function decideLifecycleIntentPersist(input: {
  existing: { status: string; attempts?: number | null } | null;
}): LifecycleClaimDecision {
  if (!input.existing) return { action: "insert_pending" };
  const status = String(input.existing.status ?? "").trim().toLowerCase();
  if (
    status === "pending" ||
    status === "sending" ||
    status === "sent" ||
    status === "skipped" ||
    status === "ambiguous" ||
    status === "failed"
  ) {
    return { action: "already_durable" };
  }
  return { action: "insert_pending" };
}

export function decideLifecycleSendLease(input: {
  existing: {
    status: string;
    updatedAtIso: string;
    attempts?: number | null;
  } | null;
  nowMs: number;
}): LifecycleClaimDecision {
  if (!input.existing) return { action: "insert_pending" };
  const status = String(input.existing.status ?? "").trim().toLowerCase();
  const attempts = Number(input.existing.attempts ?? 0);
  if (status === "sent" || status === "skipped" || status === "ambiguous") {
    return { action: "skip", reason: "already_terminal" };
  }
  if (Number.isFinite(attempts) && attempts >= SN1_MAX_ATTEMPTS) {
    return { action: "skip", reason: "max_attempts" };
  }
  if (status === "pending" || status === "failed") {
    return {
      action: "lease_sending",
      reason: status === "pending" ? "pending" : "failed",
    };
  }
  if (status === "sending") {
    const updatedMs = Date.parse(String(input.existing.updatedAtIso));
    const stale =
      !Number.isFinite(updatedMs) ||
      input.nowMs - updatedMs >= SN1_SEND_LEASE_MS;
    if (stale) {
      return { action: "lease_sending", reason: "sending_lease_expired" };
    }
    return { action: "skip", reason: "in_flight" };
  }
  return { action: "skip", reason: "already_terminal" };
}

const TERMINAL_TRIP = new Set([
  "completed",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "expired",
  "expired_no_driver",
  "no_show",
  "failed",
  "discarded",
  "admin_cancelled",
  "driver_cancelled",
]);

export type TripStaleSnapshot = {
  status: string | null | undefined;
  scheduledStatus?: string | null | undefined;
  confirmedDriverId?: string | null | undefined;
  driverId?: string | null | undefined;
  passengerId?: string | null | undefined;
};

/**
 * Anti-stale gate before provider send. Bind to claim metadata generation.
 */
export function isSn1LifecycleNotifyObsolete(input: {
  kind: Sn1LifecycleKind;
  trip: TripStaleSnapshot;
  claimedPassengerId: string;
  claimedConfirmedDriverId?: string | null;
}): { obsolete: boolean; reason?: string } {
  const status = String(input.trip.status ?? "").trim().toLowerCase();
  const sched = String(input.trip.scheduledStatus ?? "").trim().toLowerCase();
  const passenger = String(input.trip.passengerId ?? "").trim();
  const claimedPassenger = String(input.claimedPassengerId ?? "").trim();

  if (!passenger || passenger !== claimedPassenger) {
    return { obsolete: true, reason: "passenger_mismatch" };
  }
  if (TERMINAL_TRIP.has(status)) {
    return { obsolete: true, reason: "trip_terminal" };
  }
  if (sched === "cancelled" || sched === "no_driver_found" || sched === "expired") {
    return { obsolete: true, reason: "scheduled_terminal" };
  }

  switch (input.kind) {
    case "scheduled_booking_confirmed": {
      if (!input.trip.status && !sched) {
        return { obsolete: true, reason: "missing_trip_state" };
      }
      // Still a scheduled booking (or held) — not yet converted away without notify purpose.
      return { obsolete: false };
    }
    case "scheduled_accept": {
      const claimedDriver = String(input.claimedConfirmedDriverId ?? "").trim();
      const liveConfirmed = String(input.trip.confirmedDriverId ?? "").trim();
      if (!claimedDriver) {
        return { obsolete: true, reason: "missing_claimed_driver" };
      }
      if (!liveConfirmed) {
        return { obsolete: true, reason: "preconfirm_released" };
      }
      if (liveConfirmed !== claimedDriver) {
        return { obsolete: true, reason: "driver_reassigned" };
      }
      if (
        sched !== "driver_assigned" &&
        sched !== "scheduled_committed" &&
        sched !== "awaiting_activation_accept" &&
        sched !== "driver_en_route"
      ) {
        // Still OK if live driver_id stamped after activation with same confirmed driver.
        const liveDriver = String(input.trip.driverId ?? "").trim();
        if (liveDriver && liveDriver === claimedDriver) {
          return { obsolete: false };
        }
        return { obsolete: true, reason: "preconfirm_state_changed" };
      }
      return { obsolete: false };
    }
    case "scheduled_converted_to_instant": {
      if (sched !== "converted_to_instant" && status !== "searching") {
        // Assignment already happened — Searching notify would be stale.
        const liveDriver = String(input.trip.driverId ?? "").trim();
        if (liveDriver) {
          return { obsolete: true, reason: "already_assigned" };
        }
        return { obsolete: true, reason: "not_converted_searching" };
      }
      const liveDriver = String(input.trip.driverId ?? "").trim();
      if (liveDriver) {
        return { obsolete: true, reason: "already_assigned" };
      }
      return { obsolete: false };
    }
    case "scheduled_cancel_rematch": {
      // Rematch notify still useful while searching / converted; suppress if
      // a new preconfirm or live driver already exists.
      const liveDriver = String(input.trip.driverId ?? "").trim();
      const liveConfirmed = String(input.trip.confirmedDriverId ?? "").trim();
      const claimedDriver = String(input.claimedConfirmedDriverId ?? "").trim();
      if (liveDriver && (!claimedDriver || liveDriver !== claimedDriver)) {
        // New live assignment — rematch "finding" copy is stale.
        if (status !== "searching") {
          return { obsolete: true, reason: "new_assignment" };
        }
      }
      if (
        liveConfirmed &&
        claimedDriver &&
        liveConfirmed !== claimedDriver &&
        sched === "driver_assigned"
      ) {
        return { obsolete: true, reason: "new_preconfirm" };
      }
      return { obsolete: false };
    }
  }
}

export function resolveLifecycleDeliveryOutcome(input: {
  httpOk: boolean;
  sent: number | null;
  reason: string | null;
  throwError?: boolean;
}): {
  status: Exclude<LifecycleDeliveryStatus, "pending" | "sending">;
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
    return { status: "skipped", skippedReason: "sent_zero" };
  }
  return { status: "ambiguous", errorMessage: "provider_outcome_ambiguous" };
}

export function scheduledBookingConfirmedCopy(scheduledAtIso: string | null): {
  title: string;
  body: string;
} {
  const pickupDate = scheduledAtIso
    ? new Date(scheduledAtIso).toLocaleString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "your scheduled time";
  return {
    title: "Scheduled ride booked",
    body:
      `Your ride is booked for ${pickupDate}. We'll notify you when a driver confirms.`,
  };
}

export function scheduledConvertedToInstantCopy(): {
  title: string;
  body: string;
} {
  return {
    title: "Finding your driver",
    body: "Your scheduled trip is now searching for an available driver.",
  };
}

/**
 * Fault-injection model for the residual Edge multi-call crash gap.
 * Simulates interruption between lifecycle persistence and notify intent.
 */
export type Sn1AtomicStep =
  | "lifecycle_committed"
  | "intent_persisted"
  | "crash_before_intent";

export type Sn1CrashGapState = {
  lifecycleCommitted: boolean;
  intentPersisted: boolean;
};

/** Non-atomic Edge sequence: crash between steps leaves a recoverable gap. */
export function simulateNonAtomicLifecycleThenIntent(input: {
  crashAfter: "lifecycle" | "intent" | "none";
}): Sn1CrashGapState {
  const state: Sn1CrashGapState = {
    lifecycleCommitted: false,
    intentPersisted: false,
  };
  state.lifecycleCommitted = true;
  if (input.crashAfter === "lifecycle") return state;
  state.intentPersisted = true;
  return state;
}

/** Atomic same-txn sequence: crash rolls both back or neither. */
export function simulateAtomicLifecycleWithIntent(input: {
  crashBeforeCommit: boolean;
}): Sn1CrashGapState {
  if (input.crashBeforeCommit) {
    return { lifecycleCommitted: false, intentPersisted: false };
  }
  return { lifecycleCommitted: true, intentPersisted: true };
}

/** Reconcile closes a detected missing-intent gap from authoritative state. */
export function reconcileMissingIntentFromLifecycle(input: {
  lifecycleCommitted: boolean;
  intentPersisted: boolean;
}): Sn1CrashGapState {
  if (input.lifecycleCommitted && !input.intentPersisted) {
    return { lifecycleCommitted: true, intentPersisted: true };
  }
  return {
    lifecycleCommitted: input.lifecycleCommitted,
    intentPersisted: input.intentPersisted,
  };
}

export function sn1CrashGapOpen(state: Sn1CrashGapState): boolean {
  return state.lifecycleCommitted && !state.intentPersisted;
}
