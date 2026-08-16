import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { fetchCompanyBranding, formatCompanyAddress } from "./companyBranding.ts";
import {
  getTripSettlementFarePence,
  sumPaymentsCapturedPence,
  type PaymentCaptureFields,
} from "./tripSettlementFinanceSSOT.ts";
import type { InvoiceLineItem, TripInvoicePayload } from "./tripInvoiceTypes.ts";
import { computeNetPaidAfterRefund, resolveRefundStatus } from "../../../shared/providerRefundSSOT.ts";

function formatPaymentMethod(method: string | null | undefined): string {
  const m = (method ?? "").trim().toLowerCase();
  if (!m) return "Cash";
  if (m === "card" || m.includes("card")) return "Card";
  if (m === "cash") return "Cash";
  if (m === "wallet") return "Card";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function nonNegPence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** Booking ride fare after promo — excludes approved route-change charges. */
function resolveRideFareAfterPromotionPence(trip: Record<string, unknown>): number {
  const mod = nonNegPence(trip.customer_modification_charge_pence);
  const finalCustomer = nonNegPence(trip.final_customer_fare_pence);
  const snap = trip.fare_snapshot_json as Record<string, unknown> | null | undefined;
  const snapPayable =
    nonNegPence(snap?.final_customer_fare_pence) ||
    nonNegPence(snap?.canonical_payable_fare_pence) ||
    nonNegPence(snap?.committed_fare_pence) ||
    nonNegPence(snap?.accepted_fare_pence);
  if (snapPayable > 0) return snapPayable;
  if (mod > 0 && finalCustomer > mod) return finalCustomer - mod;
  if (finalCustomer > 0) return finalCustomer;
  const gross = nonNegPence(trip.gross_fare_pence) || nonNegPence(trip.locked_base_fare_pence);
  const discount =
    nonNegPence(trip.offer_discount_pence) ||
    nonNegPence(trip.promotion_discount_pence) ||
    nonNegPence(trip.discount_pence);
  if (gross > 0 && discount > 0 && gross > discount) return gross - discount;
  return nonNegPence(trip.final_fare_pence) || gross;
}

function resolveOriginalFarePence(trip: Record<string, unknown>, rideAfterPromo: number): number {
  const snap = trip.fare_snapshot_json as Record<string, unknown> | null | undefined;
  const discount =
    nonNegPence(trip.offer_discount_pence) ||
    nonNegPence(trip.promotion_discount_pence) ||
    nonNegPence(trip.discount_pence) ||
    nonNegPence(snap?.offer_discount_pence) ||
    nonNegPence(snap?.promotion_discount_pence);
  const gross =
    nonNegPence(trip.gross_fare_pence) ||
    nonNegPence(snap?.gross_fare_pence) ||
    nonNegPence(snap?.original_fare_pence);
  // Only treat gross as original when it matches promo (not waiting baked into gross).
  if (discount > 0 && gross > rideAfterPromo && gross - rideAfterPromo === discount) {
    return gross;
  }
  if (discount > 0) return rideAfterPromo + discount;
  return rideAfterPromo;
}

function resolveWaitingChargePence(trip: Record<string, unknown>): number {
  const pickup = nonNegPence(trip.pickup_waiting_charge_pence);
  const stop =
    nonNegPence(trip.stop_waiting_charge_pence) || nonNegPence(trip.stop_charge_total_pence);
  if (pickup + stop > 0) return pickup + stop;
  return (
    nonNegPence(trip.total_waiting_charge_pence) || nonNegPence(trip.waiting_charge_pence)
  );
}

function resolveNonModExtraFeesPence(trip: Record<string, unknown>): number {
  const mod = nonNegPence(trip.customer_modification_charge_pence);
  const extras = nonNegPence(trip.extras_pence);
  const extrasUnique = extras > 0 && extras === mod ? 0 : extras;
  return (
    nonNegPence(trip.airport_charge_pence) +
    nonNegPence(trip.other_pass_through_charges_pence) +
    extrasUnique
  );
}

function buildLineItems(
  trip: Record<string, unknown>,
  _tripStops?: Array<{ stop_index?: number | null; type?: string | null; waiting_total_amount_pence?: number | null }>,
): InvoiceLineItem[] {
  const tripDate = formatDateOnly((trip.completed_at as string) ?? (trip.created_at as string));
  const items: InvoiceLineItem[] = [];
  let idx = 1;

  const push = (
    description: string,
    amountPence: number,
    qty = 1,
    includeInSubtotal = true,
  ) => {
    if (
      amountPence <= 0
      && description !== "Original fare"
      && description !== "Ride fare after promotion"
      && description !== "Discount"
    ) {
      return;
    }
    if (amountPence === 0 && description === "Discount") return;
    if (amountPence < 0 && description !== "Discount") return;
    items.push({
      index: idx++,
      description,
      date: tripDate,
      qty,
      unitPricePence: amountPence,
      amountPence: amountPence * qty,
      includeInSubtotal,
    });
  };

  // Customer fare breakdown SSOT (presentation order).
  const rideFarePence = resolveRideFareAfterPromotionPence(trip);
  const originalFarePence = resolveOriginalFarePence(trip, rideFarePence);
  const discountPence = Math.max(0, originalFarePence - rideFarePence);
  const waitingPence = resolveWaitingChargePence(trip);
  const routeChangePence = nonNegPence(trip.customer_modification_charge_pence);
  const extraFeesPence = resolveNonModExtraFeesPence(trip);
  const tip = Math.max(0, Math.round(Number(trip.tip_pence ?? trip.tip_amount_pence ?? 0)));

  // Original fare + discount are explanatory only — ride fare after promotion is the billable base.
  push("Original fare", originalFarePence, 1, false);
  if (discountPence > 0) push("Discount", -discountPence, 1, false);
  push("Ride fare after promotion", rideFarePence);
  if (waitingPence > 0) push("Waiting charge", waitingPence);
  if (routeChangePence !== 0) push("Route change / added stop", routeChangePence);
  if (extraFeesPence > 0) push("Extra fees", extraFeesPence);
  if (tip > 0) push("Tip", tip);

  if (items.length === 0) {
    const fallback = resolveTotalPaidPence(trip, []);
    push("Trip fare", fallback);
  }

  return items;
}

/** Sum only billable invoice rows — excludes original fare / discount breakdown lines. */
export function computeInvoiceSubtotalPence(lineItems: InvoiceLineItem[]): number {
  return lineItems.reduce((sum, li) => {
    if (li.includeInSubtotal === false) return sum;
    return sum + li.amountPence;
  }, 0);
}

function tripSettlementFields(trip: Record<string, unknown>) {
  return {
    payment_method: trip.payment_method as string | null | undefined,
    payment_status: trip.payment_status as string | null | undefined,
    final_fare_pence: trip.final_fare_pence as number | null | undefined,
    gross_fare_pence: trip.gross_fare_pence as number | null | undefined,
    capture_amount_pence: trip.capture_amount_pence as number | null | undefined,
    final_customer_fare_pence: trip.final_customer_fare_pence as number | null | undefined,
  };
}

/**
 * Final Settlement Total for customer invoice PDFs — settlement SSOT only.
 * Card: payments.captured_amount_pence. Cash: final_fare_pence / collected.
 * Never gross_fare_pence, estimated_fare, or fare − commission.
 */
function resolveTotalPaidPence(
  trip: Record<string, unknown>,
  lineItems: InvoiceLineItem[],
  payments: PaymentCaptureFields[] = [],
): number {
  const paymentCaptured = payments.length > 0 ? sumPaymentsCapturedPence(payments) : null;
  const settlement = getTripSettlementFarePence(tripSettlementFields(trip), {
    paymentCapturedPence: paymentCaptured,
  });
  if (settlement > 0) return settlement;

  return computeInvoiceSubtotalPence(lineItems);
}

export async function resolveCustomerUserId(
  supabase: SupabaseClient,
  passengerId: string | null,
): Promise<string | null> {
  if (!passengerId) return null;

  let authUserId: string | null = null;

  const { data: customerById, error: customerByIdErr } = await supabase
    .from("customers")
    .select("user_id")
    .eq("id", passengerId)
    .maybeSingle();
  if (!customerByIdErr && customerById?.user_id) {
    authUserId = customerById.user_id;
  }

  if (!authUserId) {
    const { data: customerByUserId, error: customerByUserIdErr } = await supabase
      .from("customers")
      .select("user_id")
      .eq("user_id", passengerId)
      .maybeSingle();
    if (!customerByUserIdErr && customerByUserId?.user_id) {
      authUserId = customerByUserId.user_id;
    }
  }

  if (!authUserId) {
    authUserId = passengerId;
  }

  return authUserId;
}

export async function resolveCustomerEmail(
  supabase: SupabaseClient,
  passengerId: string | null,
): Promise<string | null> {
  const authUserId = await resolveCustomerUserId(supabase, passengerId);
  if (!authUserId) return null;

  const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(authUserId);
  if (!authErr && authData?.user?.email) {
    return authData.user.email.trim() || null;
  }

  return null;
}

export function isTripReadyForInvoice(trip: Record<string, unknown>): boolean {
  if ((trip.status ?? "").toString().toLowerCase() !== "completed") return false;

  const pm = (trip.payment_method ?? "").toString().toLowerCase();
  const ps = (trip.payment_status ?? "").toString().toLowerCase();

  if (pm === "cash") return true;
  if (["captured", "paid", "collected_cash", "refunded", "partially_refunded"].includes(ps)) return true;
  if (!trip.provider_order_id && !trip.payment_intent_id && ps === "paid") return true;
  return false;
}

export async function buildTripInvoicePayload(
  supabase: SupabaseClient,
  trip: Record<string, unknown>,
  invoiceNo: string,
): Promise<TripInvoicePayload> {
  const { company, branding } = await fetchCompanyBranding(supabase);

  const [{ data: tripStops }, { data: payments }] = await Promise.all([
    supabase
      .from("trip_stops")
      .select("stop_index, type, address, waiting_total_amount_pence")
      .eq("trip_id", trip.id as string)
      .order("stop_index", { ascending: true }),
    supabase
      .from("payments")
      .select("captured_amount_pence, amount_pence, status, refunded_amount_pence, refund_status, provider_refund_id, refunded_at")
      .eq("trip_id", trip.id as string),
  ]);

  const primaryPayment = (payments ?? [])[0] ?? null;
  const refundAmountPence = Math.max(
    0,
    Math.round(Number(trip.refund_amount_pence ?? primaryPayment?.refunded_amount_pence ?? 0)),
  );
  const capturedPence = Math.max(
    0,
    Number(primaryPayment?.captured_amount_pence ?? trip.capture_amount_pence ?? 0),
  );
  const refundStatus = resolveRefundStatus(
    capturedPence,
    refundAmountPence,
  );
  const providerRefundId = (primaryPayment?.provider_refund_id as string | null) ?? null;
  const refundedAtIso = (trip.refunded_at as string | null)
    ?? (primaryPayment?.refunded_at as string | null)
    ?? null;

  const intermediateStops = (tripStops ?? [])
    .filter((stop) => stop.type === "stop" && stop.address)
    .map((stop) => stop.address as string);

  const lineItems = buildLineItems(trip, tripStops ?? []);
  const billableSubtotalPence = computeInvoiceSubtotalPence(lineItems);
  const taxRatePercent = 0;
  const taxPence = 0;
  const totalPaidPence = resolveTotalPaidPence(trip, lineItems, payments ?? []);
  const originalPaidPence = totalPaidPence;
  const netPaidAfterRefundPence = computeNetPaidAfterRefund({
    customerPaidPence: originalPaidPence,
    refundPence: refundAmountPence,
  });
  const displayTotalPence = refundAmountPence > 0 ? netPaidAfterRefundPence : originalPaidPence;

  console.log("TRIP_INVOICE_ISOLATION_CHECK", {
    trip_id: trip.id,
    trip_code: trip.trip_code ?? null,
    passenger_id: trip.passenger_id ?? null,
    invoice_no: invoiceNo,
    total_paid_pence: totalPaidPence,
    capture_amount_pence: trip.capture_amount_pence ?? null,
    parent_trip_id: null,
  });

  const customerEmail = await resolveCustomerEmail(
    supabase,
    (trip.passenger_id as string) ?? null,
  );

  return {
    invoiceNo,
    tripId: (trip.trip_code as string) || `MK-${trip.id}`,
    tripUuid: trip.id as string,
    invoiceDate: formatDateOnly(new Date().toISOString()),
    paymentMethod: refundStatus !== "none"
      ? `${formatPaymentMethod(trip.payment_method as string)} — ${refundStatus === "refunded" ? "Refunded" : "Partially refunded"}`
      : formatPaymentMethod(trip.payment_method as string),
    currency: "GBP",
    customerName: (trip.passenger_name as string) || "Customer",
    customerEmail: customerEmail ?? "",
    customerPhone: (trip.passenger_phone as string) || "—",
    pickupAddress: (trip.pickup_address as string) || "—",
    dropoffAddress: (trip.dropoff_address as string) || "—",
    pickupAt: formatDateTime((trip.started_at as string) ?? (trip.created_at as string)),
    dropoffAt: formatDateTime(trip.completed_at as string),
    driverName: "—",
    vehicleRegistration: "—",
    intermediateStops,
    lineItems,
    subtotalPence: billableSubtotalPence || originalPaidPence,
    taxPence,
    taxRatePercent,
    totalPaidPence: displayTotalPence,
    originalPaidPence,
    refundAmountPence,
    netPaidAfterRefundPence,
    refundStatus: refundStatus === "none" ? null : refundStatus,
    refundedAt: refundedAtIso ? formatDateTime(refundedAtIso) : null,
    providerRefundId,
    company: { ...company, address: formatCompanyAddress(company) || company.address },
    branding,
  };
}

export function invoicePdfFileName(invoiceNo: string, tripId: string): string {
  return `ONECAB_Invoice_${invoiceNo}_${tripId}.pdf`;
}

/** @internal Exported for invoice SSOT tests. */
export { buildLineItems, resolveTotalPaidPence };
