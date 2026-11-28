/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Phase 5 — per-device capability gate for departure acknowledgement.
 *
 * Global scheduled_departure_ack_enabled alone is insufficient.
 * Arm arm_ack only when the driver's *sole active* installation
 * (`driver_active_devices`) advertises the capability token that the *loaded*
 * Driver JS/OTA sent on bind. Never infer capability from native app_version /
 * runtimeVersion alone — an older OTA on the same native binary must stay on
 * Phase 4 exclusive NRO (`ack_nro`).
 *
 * Push delivery (`resolveDriverAuthoritativeToken`) uses the same active
 * device_id, so notification recipient and capability decision stay aligned.
 *
 * Bind always replaces `client_capabilities` (missing body → []). OTA adopt
 * rebinds with the new token; rollback OTA rebinds without it and clears.
 */

/** Legacy token — older OTAs may still advertise; never grants Phase 5 once key=v2. */
export const SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1 = "scheduled_departure_ack_v1" as const;

export * from "../../../functions/_shared/scheduledDepartureAckCapabilitySSOT.ts";
