/**
 * Channel preauth amounts — WhatsApp guest + corporate-book parity with the
 * Customer App: hold = server fare + service-area buffer from
 * resolvePreauthBuffer (service_area_preauth_settings).
 *
 * The buffer is authorisation headroom only: never fare, never commissionable,
 * never driver earnings, never invoice fare, never auto-captured. Inputs are
 * the server-priced fare and the authoritative service area only — client
 * amount / buffer / hold values must never reach this module.
 */
import { resolvePreauthBuffer, type PreauthBufferSource } from "./preauthBufferResolverSSOT.ts";

export type ChannelPreauthAmounts = {
  farePence: number;
  bufferPence: number;
  authorisedAmountPence: number;
  bufferSource: PreauthBufferSource;
};

export async function resolveChannelPreauthAmounts(
  // deno-lint-ignore no-explicit-any
  supabaseClient: any,
  serverFarePence: number,
  serviceAreaId: string,
): Promise<ChannelPreauthAmounts> {
  const farePence = Math.round(Number(serverFarePence));
  const { bufferPence, source } = await resolvePreauthBuffer(supabaseClient, farePence, serviceAreaId);
  return {
    farePence,
    bufferPence,
    authorisedAmountPence: farePence + bufferPence,
    bufferSource: source,
  };
}

/**
 * Session fare_snapshot amount fields. final_fare_pence / estimated_total_pence
 * are required alongside authorised_amount_pence: resolve_booking_customer_payable_pence
 * and create-trip-after-payment read those first, so the payable stays the fare
 * and never resolves to the hold.
 */
export function buildChannelPreauthFareSnapshotFields(
  amounts: ChannelPreauthAmounts,
): Record<string, unknown> {
  return {
    final_fare_pence: amounts.farePence,
    estimated_total_pence: amounts.farePence,
    gross_fare_pence: amounts.farePence,
    offer_discount_pence: 0,
    estimated_fare_pence: amounts.farePence,
    buffer_pence: amounts.bufferPence,
    buffer_source: amounts.bufferSource,
    authorised_amount_pence: amounts.authorisedAmountPence,
    fare_snapshot_authority: "server",
  };
}
