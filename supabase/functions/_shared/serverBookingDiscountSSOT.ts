/**
 * Server discount for an opaque booking quote. Discount state is resolved on
 * the server from the server fare artifact gross and bound into the quote's
 * pricing fingerprint; the client never supplies a discount or a voucher id.
 *
 * Mirrors create-preauth precedence: a valid personal voucher replaces any
 * auto-applied offer.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveBestOfferForTrip } from "./resolve-offer.ts";
import {
  PERSONAL_VOUCHER_ERROR_MESSAGES,
  type PersonalVoucherValidationError,
  resolvePersonalVoucherForTrip,
} from "./resolve-personal-voucher.ts";

export type ServerBookingDiscount = {
  discount_pence: number;
  discount_source: "global_offer" | "personal_voucher" | null;
  applied_offer_id: string | null;
  applied_offer_code: string | null;
  applied_personal_voucher_id: string | null;
  applied_personal_voucher_code: string | null;
};

export const NO_SERVER_DISCOUNT: ServerBookingDiscount = {
  discount_pence: 0,
  discount_source: null,
  applied_offer_id: null,
  applied_offer_code: null,
  applied_personal_voucher_id: null,
  applied_personal_voucher_code: null,
};

export function normalizePersonalVoucherCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const n = code.trim().toUpperCase();
  return n.length > 0 ? n : null;
}

export async function resolveServerBookingDiscount(
  admin: SupabaseClient,
  input: {
    serviceAreaId: string;
    grossFarePence: number;
    userId: string;
    customerId: string;
    personalVoucherCode?: string | null;
  },
): Promise<
  | { ok: true; discount: ServerBookingDiscount }
  | { ok: false; error: PersonalVoucherValidationError; message: string }
> {
  const gross = Math.max(0, Math.floor(Number(input.grossFarePence) || 0));
  const code = normalizePersonalVoucherCode(input.personalVoucherCode);
  if (code) {
    const v = await resolvePersonalVoucherForTrip({
      admin,
      code,
      customerId: input.customerId,
      estimatedFarePence: gross,
    });
    if (!v.ok) {
      return { ok: false, error: v.error, message: PERSONAL_VOUCHER_ERROR_MESSAGES[v.error] };
    }
    const d = Math.min(v.resolved.discountPence, gross);
    return {
      ok: true,
      discount: {
        ...NO_SERVER_DISCOUNT,
        discount_pence: d,
        discount_source: d > 0 ? "personal_voucher" : null,
        applied_personal_voucher_id: v.resolved.voucherId,
        applied_personal_voucher_code: v.resolved.voucherCode,
      },
    };
  }
  let offer: Awaited<ReturnType<typeof resolveBestOfferForTrip>> = null;
  try {
    offer = await resolveBestOfferForTrip({
      admin,
      serviceAreaId: input.serviceAreaId,
      estimatedFarePence: gross,
      userId: input.userId,
      customerId: input.customerId,
    });
  } catch (err) {
    console.warn("[serverBookingDiscount] offer resolution failed (no offer)", String(err));
    offer = null;
  }
  if (!offer || offer.discountPence <= 0) return { ok: true, discount: NO_SERVER_DISCOUNT };
  return {
    ok: true,
    discount: {
      ...NO_SERVER_DISCOUNT,
      discount_pence: Math.min(offer.discountPence, gross),
      discount_source: "global_offer",
      applied_offer_id: offer.offerId,
      applied_offer_code: offer.offerCode,
    },
  };
}

/**
 * Everything the payable depends on. Quote reuse requires equality; any
 * change (new fare artifact, voucher added/removed/changed, offer change,
 * buffer change) forces a fresh quote.
 */
export function buildBookingPricingFingerprint(input: {
  server_fare_quote_id: string;
  pricing_hash: string;
  gross_fare_pence: number;
  discount: ServerBookingDiscount;
  trip_fare_pence: number;
  buffer_pence: number;
}): string {
  return [
    "pf1",
    `sfq:${input.server_fare_quote_id}`,
    `h:${input.pricing_hash}`,
    `g:${input.gross_fare_pence}`,
    `d:${input.discount.discount_pence}`,
    `src:${input.discount.discount_source ?? ""}`,
    `o:${input.discount.applied_offer_id ?? ""}`,
    `v:${input.discount.applied_personal_voucher_id ?? ""}`,
    `t:${input.trip_fare_pence}`,
    `b:${input.buffer_pence}`,
  ].join("|");
}
