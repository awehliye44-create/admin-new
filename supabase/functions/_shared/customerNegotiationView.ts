/**
 * Customer/Driver in-card negotiation payload (backend SSOT).
 * Never invent chip amounts in mobile.
 * Deadline SSOT is negotiation_expires_at (absolute, also mirrored as expires_at).
 * countdown_seconds is the Admin configured duration from the offer snapshot,
 * not a hardcoded 20s window.
 */
import {
  buildNegotiationFromPresetOptions,
  extractPresetOptionsFromOffer,
  type PresetOptionCanonical,
} from "./presetOptionsCanonical.ts";
import { normalizeCountdownSeconds } from "./presetNegotiationEligibility.ts";

export type CustomerNegotiationPhase = "waiting_customer" | "waiting_driver_final";

export type CustomerNegotiationView = {
  offer_id: string;
  phase: CustomerNegotiationPhase;
  original_fare_pence: number;
  driver_offer_pence: number;
  customer_counter_pence: number | null;
  remaining_options: PresetOptionCanonical[];
  expires_at: string | null;
  negotiation_expires_at: string | null;
  countdown_seconds: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function snapshotCountdownSeconds(snapshot: unknown): number | null {
  const rec = asRecord(snapshot);
  if (!rec) return null;
  return (
    normalizeCountdownSeconds(rec.countdown_seconds) ??
    normalizeCountdownSeconds(rec.presetCountdownSeconds)
  );
}

export function buildCustomerNegotiationView(args: {
  offer: {
    id: string;
    negotiation_status?: string | null;
    driver_offer_fare?: number | null;
    customer_counter_fare?: number | null;
    customer_respond_by?: string | null;
    driver_respond_by?: string | null;
    negotiation_expires_at?: string | null;
    expires_at?: string | null;
    offer_snapshot?: unknown;
  };
  originalFarePence: number;
}): CustomerNegotiationView | null {
  const status = args.offer.negotiation_status ?? "";
  const phase: CustomerNegotiationPhase | null =
    status === "waiting_customer"
      ? "waiting_customer"
      : status === "waiting_driver_final"
      ? "waiting_driver_final"
      : null;
  if (!phase) return null;

  const driverOffer = Math.round(Number(args.offer.driver_offer_fare ?? 0));
  if (!Number.isFinite(driverOffer) || driverOffer <= 0) return null;

  const presets = extractPresetOptionsFromOffer(args.offer);
  const { remainingOptions } = buildNegotiationFromPresetOptions(
    presets,
    driverOffer,
  );
  const expiresAt =
    phase === "waiting_driver_final"
      ? args.offer.driver_respond_by ?? args.offer.negotiation_expires_at ?? args.offer.expires_at
      : args.offer.customer_respond_by ?? args.offer.negotiation_expires_at ?? args.offer.expires_at;

  return {
    offer_id: args.offer.id,
    phase,
    original_fare_pence: args.originalFarePence,
    driver_offer_pence: driverOffer,
    customer_counter_pence:
      Number(args.offer.customer_counter_fare) > 0
        ? Math.round(Number(args.offer.customer_counter_fare))
        : null,
    remaining_options: remainingOptions.slice(0, 2),
    expires_at: expiresAt ?? null,
    negotiation_expires_at: expiresAt ?? null,
    countdown_seconds: snapshotCountdownSeconds(args.offer.offer_snapshot),
  };
}

export async function loadCustomerNegotiationView(
  supabase: { from: (table: string) => any },
  tripId: string,
  originalFarePence: number,
): Promise<CustomerNegotiationView | null> {
  const { data } = await supabase
    .from("ride_offers")
    .select(
      "id, negotiation_status, driver_offer_fare, customer_counter_fare, customer_respond_by, driver_respond_by, negotiation_expires_at, expires_at, offer_snapshot",
    )
    .eq("trip_id", tripId)
    .in("negotiation_status", ["waiting_customer", "waiting_driver_final"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const offer = asRecord(data);
  if (!offer?.id || typeof offer.id !== "string") return null;
  return buildCustomerNegotiationView({
    offer: {
      id: offer.id,
      negotiation_status: typeof offer.negotiation_status === "string" ? offer.negotiation_status : null,
      driver_offer_fare: Number(offer.driver_offer_fare) || null,
      customer_counter_fare: Number(offer.customer_counter_fare) || null,
      customer_respond_by: typeof offer.customer_respond_by === "string" ? offer.customer_respond_by : null,
      driver_respond_by: typeof offer.driver_respond_by === "string" ? offer.driver_respond_by : null,
      negotiation_expires_at:
        typeof offer.negotiation_expires_at === "string" ? offer.negotiation_expires_at : null,
      expires_at: typeof offer.expires_at === "string" ? offer.expires_at : null,
      offer_snapshot: offer.offer_snapshot,
    },
    originalFarePence,
  });
}
