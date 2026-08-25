/**
 * Atomic WhatsApp option ownership patches (SSOT).
 *
 * At most one transient owner: idle | book | track | support.
 * Entering an option clears the others' transient fields.
 */

export type WhatsAppWorkflowState = "new" | "idle" | "book" | "track" | "support";

export type ConversationOwnershipPatch = Partial<{
  workflow_state: WhatsAppWorkflowState;
  welcome_sent_at: string;
  support_opened_at: string | null;
  support_conversation_id: string | null;
  active_trip_id: string | null;
  booking_session_started_at: string | null;
  booking_session_expires_at: string | null;
}>;

/** Neutral idle — clears all transient option fields. */
export function buildIdleOwnershipPatch(): ConversationOwnershipPatch {
  return {
    workflow_state: "idle",
    booking_session_started_at: null,
    booking_session_expires_at: null,
    support_opened_at: null,
    support_conversation_id: null,
    active_trip_id: null,
  };
}

/**
 * Option 1 — Book. Clears support linkage and stale track ownership.
 * `activeTripId` is set only when a genuine trackable trip exists; otherwise null.
 */
export function buildBookOwnershipPatch(input: {
  nowIso: string;
  expiresAt: string;
  activeTripId: string | null;
}): ConversationOwnershipPatch {
  return {
    workflow_state: "book",
    booking_session_started_at: input.nowIso,
    booking_session_expires_at: input.expiresAt,
    support_opened_at: null,
    support_conversation_id: null,
    active_trip_id: input.activeTripId,
  };
}

/**
 * Option 2 — Track with a live trip. Clears support + booking session.
 */
export function buildActiveTrackOwnershipPatch(
  activeTripId: string,
): ConversationOwnershipPatch {
  return {
    workflow_state: "track",
    active_trip_id: activeTripId,
    support_opened_at: null,
    support_conversation_id: null,
    booking_session_started_at: null,
    booking_session_expires_at: null,
  };
}

/**
 * Option 2 — Generic track (no live trip). After recovery send → idle.
 */
export function buildGenericTrackIdleOwnershipPatch(): ConversationOwnershipPatch {
  return buildIdleOwnershipPatch();
}

/**
 * Option 3 — Support. Clears booking TTL; does not touch active_trip_id
 * (trip identity ≠ track-mode ownership).
 */
export function buildSupportOwnershipPatch(input: {
  nowIso: string;
  supportConversationId: string | null;
}): ConversationOwnershipPatch {
  return {
    workflow_state: "support",
    support_opened_at: input.nowIso,
    support_conversation_id: input.supportConversationId,
    booking_session_started_at: null,
    booking_session_expires_at: null,
  };
}
