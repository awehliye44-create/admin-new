/**
 * Server-authoritative opaque booking quote issuance.
 *
 *   server fare artifact (pricing-engine.ts gross)
 *   − server discount (offer / validated personal voucher)
 *   = trip_fare_pence
 *   + server buffer (service_area_preauth_settings on that payable)
 *   (+ folded receivable)
 *   = total_authorisation_pence
 *
 * The request contributes route/vehicle identity and opaque ids only.
 * Lock: serverFareAuthorityLock.test.ts — if it fails, fix the code.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { sumOpenReceivableOutstandingForCustomer } from "./customerReceivableLifecycle.ts";
import { readCustomerReceivableFoldGate } from "./customerReceivableConsentSSOT.ts";
import {
  issueBookingPaymentQuote,
  parseBookingQuoteRequestBody,
  quotePublicResponseFields,
  resolveBookingQuoteServerBuffer,
} from "./bookingPaymentQuoteSSOT.ts";
import { FARE_QUOTE_UNAVAILABLE, loadServerFareArtifactForQuote } from "./serverFareAuthoritySSOT.ts";
import {
  buildBookingPricingFingerprint,
  resolveServerBookingDiscount,
} from "./serverBookingDiscountSSOT.ts";

export const FARE_UNAVAILABLE_COPY =
  "We couldn't confirm the fare for this trip. Please refresh and try again.";

export type ServerBookingQuoteResult = { status: number; body: Record<string, unknown> };

export async function issueServerAuthoritativeBookingQuote(
  admin: SupabaseClient,
  input: {
    userId: string;
    body: Record<string, unknown>;
    nowMs?: number;
    gate?: { enabled: boolean; allowlist: Set<string> };
  },
): Promise<ServerBookingQuoteResult> {
  const fields = parseBookingQuoteRequestBody(input.body);
  if (!fields.client_action_id) {
    return { status: 400, body: { error: "client_action_id_required", code: "BOOKING_QUOTE_INVALID" } };
  }
  if (!fields.service_area_id) {
    return { status: 400, body: { error: "service_area_id_required", code: "BOOKING_QUOTE_INVALID" } };
  }
  if (!fields.vehicle_type_id || !fields.route_key) {
    return {
      status: 400,
      body: {
        ok: false,
        error: FARE_UNAVAILABLE_COPY,
        code: FARE_QUOTE_UNAVAILABLE,
        note: !fields.vehicle_type_id ? "vehicle_type_id_required" : "route_coordinates_required",
      },
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const [{ data: customer }, { data: serviceArea }, fareArtifact] = await Promise.all([
    admin.from("customers").select("id").eq("user_id", input.userId).maybeSingle(),
    admin.from("service_areas").select("id, is_active").eq("id", fields.service_area_id)
      .maybeSingle(),
    loadServerFareArtifactForQuote(admin, {
      userId: input.userId,
      routeKey: fields.route_key,
      vehicleTypeId: fields.vehicle_type_id,
      serviceAreaId: fields.service_area_id,
      serverFareQuoteId: fields.server_fare_quote_id,
      nowMs,
    }),
  ]);
  const customerId = customer?.id ? String(customer.id) : null;
  if (!customerId) {
    return { status: 404, body: { error: "customer_not_found" } };
  }
  if (!serviceArea || serviceArea.is_active === false) {
    return { status: 400, body: { error: "service_area_invalid", code: "BOOKING_QUOTE_INVALID" } };
  }
  if (!fareArtifact.ok) {
    console.warn("[booking-quote] server fare artifact rejected", {
      code: fareArtifact.code,
      note: fareArtifact.note,
      client_claimed_trip_fare_pence: fields.client_claimed_trip_fare_pence,
    });
    return {
      status: 409,
      body: { ok: false, error: FARE_UNAVAILABLE_COPY, code: fareArtifact.code, note: fareArtifact.note },
    };
  }
  const artifact = fareArtifact.artifact;
  if (fields.currency !== artifact.currency) {
    return {
      status: 409,
      body: { ok: false, error: FARE_UNAVAILABLE_COPY, code: "FARE_QUOTE_CHANGED", note: "currency_mismatch" },
    };
  }

  const outstandingP = sumOpenReceivableOutstandingForCustomer(admin, {
    customer_id: customerId,
    currency: artifact.currency,
  });
  const discountResult = await resolveServerBookingDiscount(admin, {
    serviceAreaId: artifact.service_area_id,
    grossFarePence: artifact.gross_fare_pence,
    userId: input.userId,
    customerId,
    personalVoucherCode: fields.personal_voucher_code,
  });
  if (!discountResult.ok) {
    await outstandingP.catch(() => 0);
    return {
      status: 422,
      body: { ok: false, error: discountResult.message, code: "VOUCHER_INVALID", note: discountResult.error },
    };
  }
  const discount = discountResult.discount;
  const serverTripFarePence = artifact.gross_fare_pence - discount.discount_pence;
  if (serverTripFarePence <= 0) {
    await outstandingP.catch(() => 0);
    return {
      status: 409,
      body: {
        ok: false,
        error: FARE_UNAVAILABLE_COPY,
        code: FARE_QUOTE_UNAVAILABLE,
        note: "server_payable_not_positive",
      },
    };
  }

  const [outstanding, serverBuffer] = await Promise.all([
    outstandingP,
    resolveBookingQuoteServerBuffer(admin, {
      service_area_id: artifact.service_area_id,
      server_trip_fare_pence: serverTripFarePence,
      server_discount_applied: discount.discount_pence > 0,
    }),
  ]);
  const frozenGate = input.gate ?? readCustomerReceivableFoldGate();
  const pricingFingerprint = buildBookingPricingFingerprint({
    server_fare_quote_id: artifact.id,
    pricing_hash: artifact.pricing_hash,
    gross_fare_pence: artifact.gross_fare_pence,
    discount,
    trip_fare_pence: serverTripFarePence,
    buffer_pence: serverBuffer.bufferPence,
  });

  if (
    fields.client_claimed_trip_fare_pence > 0
    && fields.client_claimed_trip_fare_pence !== serverTripFarePence
  ) {
    console.warn("[booking-quote] client fare ignored", {
      client_claimed_trip_fare_pence: fields.client_claimed_trip_fare_pence,
      server_trip_fare_pence: serverTripFarePence,
      server_fare_quote_id: artifact.id,
    });
  }

  const issued = await issueBookingPaymentQuote(admin, {
    customer_id: customerId,
    user_id: input.userId,
    client_action_id: fields.client_action_id,
    service_area_id: artifact.service_area_id,
    ride_category: fields.ride_category,
    route_fingerprint: fields.route_fingerprint,
    currency: artifact.currency,
    server_trip_fare_pence: serverTripFarePence,
    server_fare_quote_id: artifact.id,
    pricing_fingerprint: pricingFingerprint,
    pricing_metadata: {
      server_fare_quote_id: artifact.id,
      route_quote_id: artifact.route_quote_id,
      pricing_hash: artifact.pricing_hash,
      gross_fare_pence: artifact.gross_fare_pence,
      discount_pence: discount.discount_pence,
      discount_source: discount.discount_source,
      applied_offer_id: discount.applied_offer_id,
      applied_offer_code: discount.applied_offer_code,
      applied_personal_voucher_id: discount.applied_personal_voucher_id,
      applied_personal_voucher_code: discount.applied_personal_voucher_code,
      client_claimed_trip_fare_pence: fields.client_claimed_trip_fare_pence,
    },
    server_buffer: serverBuffer,
    server_outstanding_pence: outstanding,
    gate: frozenGate,
  });

  if (!issued.ok) {
    return { status: 500, body: { ok: false, error: issued.error, code: "BOOKING_QUOTE_INVALID" } };
  }

  const quote = issued.quote;
  const informational = quote.receivable_pence > 0 && !quote.fold_eligible
    ? `Outstanding balance £${(quote.receivable_pence / 100).toFixed(2)} — it will be added to a future eligible booking.`
    : null;

  return {
    status: 200,
    body: {
      ...quotePublicResponseFields(quote),
      reason: quote.fold_eligible
        ? "fold_eligible"
        : (frozenGate.enabled ? "not_eligible" : "RECEIVABLE_FOLD_GATE_OFF"),
      informational_copy: informational,
      reused: issued.reused,
    },
  };
}
