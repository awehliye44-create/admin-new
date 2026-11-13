/**
 * Scheduled exclusive activation NRO + automatic nearby fallback SSOT.
 *
 * - Arm only the confirmed driver with a real ride_offers row.
 * - Push is the standard RIDE_OFFER / NEW_RIDE_OFFER path (INSERT trigger +
 *   optional Edge send with offer_id) — never SCHEDULED_COMMITMENT alone.
 * - Decline / expiry → convert same trip_id to instant nearby auto-dispatch.
 * - Never treat push delivery failure as a decline.
 */

import {
  buildScheduledUrgentConversionPatch,
  resolveConversionBroadcastEnabled,
} from "./scheduledDispatchConfig.ts";
import { DRIVER_NEW_RIDE_OFFER_DATA_TYPE } from "./rideOfferClientPushData.ts";
import { DRIVER_NEW_RIDE_OFFER_TITLE } from "./negotiationPushCopy.ts";
import { rideOfferPushBodyDriverNet } from "./driverOfferPushCopy.ts";
import { RIDE_OFFER_IOS_ALERT_SOUND } from "./rideOfferPushCopy.ts";

export const SCHEDULED_ACTIVATION_EXCLUSIVE_REASON = {
  expiredOrDeclined: "scheduled_activation_nro_expired_or_declined",
  declinedImmediate: "scheduled_activation_nro_declined_immediate",
  expiredImmediate: "scheduled_activation_nro_expired_immediate",
  ineligibleBypass: "scheduled_activation_driver_ineligible_bypass",
  netUnavailableBypass: "scheduled_activation_net_unavailable_bypass",
  insertBlockedBypass: "scheduled_activation_offer_insert_blocked_bypass",
  /** Phase 5: 45s departure acknowledgement timed out. */
  acknowledgementTimeout: "acknowledgement_timeout",
  /** Phase 5: driver tapped Cancel Booking during departure ack. */
  departureAckCancelled: "departure_ack_cancelled_by_driver",
} as const;

export type ScheduledActivationTripFare = {
  driver_net_pence?: number | null;
  driver_net_before_tip_pence?: number | null;
  offered_driver_net_pence?: number | null;
  estimated_total_pence?: number | null;
  final_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  locked_base_fare_pence?: number | null;
  estimated_fare?: number | null;
  fare?: number | null;
  airport_charge_pence?: number | null;
  currency_code?: string | null;
  currency?: string | null;
  service_area_id?: string | null;
  pickup_address?: string | null;
  dropoff_address?: string | null;
  scheduled_at?: string | null;
  estimated_duration_minutes?: number | null;
  special_instructions?: string | null;
};

/** Gross pence for commission preview only — never display as driver net. */
export function resolveActivationGrossPenceForPreview(
  trip: ScheduledActivationTripFare,
): number | null {
  const candidates = [
    trip.estimated_total_pence,
    trip.final_fare_pence,
    trip.final_customer_fare_pence,
    trip.gross_fare_pence,
    trip.locked_base_fare_pence,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  const major = Number(trip.estimated_fare ?? trip.fare ?? 0);
  if (Number.isFinite(major) && major > 0) return Math.round(major * 100);
  return null;
}

/**
 * Authoritative driver-net for exclusive activation.
 * Prefer stamped net; else computed preview from SSOT (passed in).
 * NEVER returns customer gross as net.
 */
export function resolveExclusiveActivationDriverNetPence(input: {
  trip: ScheduledActivationTripFare;
  /** Result of compute_driver_net_preview_from_gross — already commission-aware. */
  computedPreviewPence?: number | null;
}): number | null {
  const stamped = [
    input.trip.driver_net_pence,
    input.trip.driver_net_before_tip_pence,
    input.trip.offered_driver_net_pence,
  ];
  for (const raw of stamped) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  const preview = Number(input.computedPreviewPence);
  if (Number.isFinite(preview) && preview > 0) return Math.round(preview);
  return null;
}

export function buildExclusiveActivationOfferSnapshot(input: {
  trip: ScheduledActivationTripFare & {
    id?: string;
    pickup_latitude?: number | null;
    pickup_longitude?: number | null;
    dropoff_latitude?: number | null;
    dropoff_longitude?: number | null;
  };
  confirmedDriverId: string;
  netPence: number;
  kind: string;
  expiresAtIso: string;
  /** Phase 5: marks Heading to Pickup / Cancel Booking presentation. */
  departureAcknowledgement?: boolean;
  ackNonce?: string | null;
}): Record<string, unknown> {
  const { trip, confirmedDriverId, netPence, kind, expiresAtIso } = input;
  const currency = String(trip.currency_code ?? trip.currency ?? "GBP").trim() || "GBP";
  return {
    scheduled_status: "awaiting_activation_accept",
    scheduled_at: trip.scheduled_at ?? null,
    dispatch_mode: "scheduled",
    is_scheduled: true,
    confirmed_driver_id: confirmedDriverId,
    pickup_address: trip.pickup_address ?? null,
    pickup_latitude: trip.pickup_latitude ?? null,
    pickup_longitude: trip.pickup_longitude ?? null,
    dropoff_address: trip.dropoff_address ?? null,
    dropoff_latitude: trip.dropoff_latitude ?? null,
    dropoff_longitude: trip.dropoff_longitude ?? null,
    estimated_duration_minutes: trip.estimated_duration_minutes ?? null,
    special_instructions: trip.special_instructions ?? null,
    driver_net_fare_pence: netPence,
    offered_driver_net_pence: netPence,
    driver_net_pence: netPence,
    driver_earnings_pence: netPence,
    driver_net_preview_pence: netPence,
    negotiation_disabled: true,
    presets_enabled: false,
    scheduled_kind: kind,
    expires_at: expiresAtIso,
    currency_code: currency,
    currency,
    ...(input.departureAcknowledgement
      ? {
        departure_acknowledgement: true,
        departureAcknowledgement: true,
        accept_action: "heading_to_pickup",
        decline_action: "cancel_booking",
        ack_deadline_at: expiresAtIso,
        ack_nonce: input.ackNonce ?? null,
      }
      : {}),
  };
}

export function buildExclusiveActivationRideOfferPush(input: {
  offerId: string;
  tripId: string;
  driverId: string;
  netPence: number;
  expiresAtIso: string;
  pickupAddress?: string | null;
  dropoffAddress?: string | null;
  currencyCode?: string | null;
  tripReference?: string | null;
}): {
  type: "RIDE_OFFER";
  title: string;
  body: string;
  data: Record<string, string>;
} {
  const currency = String(input.currencyCode ?? "GBP").trim() || "GBP";
  const body = rideOfferPushBodyDriverNet(currency, input.netPence);
  return {
    type: "RIDE_OFFER",
    title: DRIVER_NEW_RIDE_OFFER_TITLE,
    body,
    data: {
      type: DRIVER_NEW_RIDE_OFFER_DATA_TYPE,
      notificationType: DRIVER_NEW_RIDE_OFFER_DATA_TYPE,
      offer_notification_type: "new_ride_offer",
      offer_id: input.offerId,
      offerId: input.offerId,
      requestId: input.offerId,
      trip_id: input.tripId,
      tripId: input.tripId,
      booking_id: input.tripId,
      driver_id: input.driverId,
      driverId: input.driverId,
      expires_at: input.expiresAtIso,
      expiresAt: input.expiresAtIso,
      sound: RIDE_OFFER_IOS_ALERT_SOUND,
      pickupAddress: String(input.pickupAddress ?? ""),
      dropoffAddress: String(input.dropoffAddress ?? ""),
      driver_earnings_pence: String(input.netPence),
      driver_net_preview_pence: String(input.netPence),
      currencyCode: currency,
      currency_code: currency,
      offer_kind: "scheduled",
      scheduled_status: "awaiting_activation_accept",
      ...(input.tripReference
        ? { trip_reference: input.tripReference, tripReference: input.tripReference }
        : {}),
    },
  };
}

export function mergeExcludedDriverIds(
  existing: unknown,
  driverId: string | null | undefined,
): string[] {
  const out = new Set<string>();
  if (Array.isArray(existing)) {
    for (const id of existing) {
      const s = String(id ?? "").trim();
      if (s) out.add(s);
    }
  }
  const add = String(driverId ?? "").trim();
  if (add) out.add(add);
  return [...out];
}

export function buildExclusiveFailureConversionPatch(input: {
  nowIso: string;
  searchingExpiresAtIso: string;
  scheduledBroadcastAt?: string | null;
  excludeDriverId?: string | null;
  existingExcludedDriverIds?: unknown;
  maxExistingBroadcastRound?: number | null;
  maxBroadcastSequences?: number | null;
  /** Preserve airport / fare-enrich hold when currently false. */
  currentBroadcastEnabled?: boolean | null;
  /** Phase 5: stamp ack resolution when converting after timeout/cancel. */
  ackResolution?: {
    status: "timed_out" | "cancelled" | "declined";
    reason: string;
  } | null;
}): Record<string, unknown> {
  const excluded = mergeExcludedDriverIds(
    input.existingExcludedDriverIds,
    input.excludeDriverId,
  );
  const ackFields = input.ackResolution
    ? {
      scheduled_ack_status: input.ackResolution.status,
      scheduled_ack_resolved_at: input.nowIso,
      scheduled_ack_resolution_reason: input.ackResolution.reason,
    }
    : {};
  return {
    ...buildScheduledUrgentConversionPatch({
      nowIso: input.nowIso,
      searchingExpiresAtIso: input.searchingExpiresAtIso,
      maxExistingBroadcastRound: input.maxExistingBroadcastRound,
      maxBroadcastSequences: input.maxBroadcastSequences,
      broadcastEnabled: resolveConversionBroadcastEnabled({
        currentBroadcastEnabled: input.currentBroadcastEnabled,
      }),
    }),
    driver_id: null,
    confirmed_driver_id: null,
    scheduled_broadcast_at: input.scheduledBroadcastAt ?? input.nowIso,
    commitment_time: null,
    scheduled_committed_at: null,
    excluded_driver_ids: excluded,
    // Invalidate dynamic JIT stamps so a later assignee cannot inherit them.
    scheduled_jit_activate_at: null,
    scheduled_jit_eta_minutes: null,
    scheduled_jit_eta_observed_at: null,
    scheduled_jit_distance_kind: null,
    scheduled_jit_eta_source: null,
    scheduled_jit_basis_scheduled_at: null,
    scheduled_jit_eta_spike_samples: 0,
    ...ackFields,
  };
}

/** CAS statuses that may still be exclusive-armed when rescue runs. */
export const EXCLUSIVE_RESCUE_SCHEDULED_STATUSES = [
  "scheduled_committed",
  "driver_assigned",
  "awaiting_activation_accept",
] as const;

export function isExclusiveActivationArmedStatus(
  scheduledStatus: string | null | undefined,
): boolean {
  return String(scheduledStatus ?? "").trim().toLowerCase() === "awaiting_activation_accept";
}
