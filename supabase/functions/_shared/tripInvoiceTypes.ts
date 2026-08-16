/**
 * Customer trip invoice payload types (recovered for Slice A tip-window capture deps).
 */

export type InvoiceLineItem = {
  index: number;
  description: string;
  date: string;
  qty: number;
  unitPricePence: number;
  amountPence: number;
  includeInSubtotal?: boolean;
};

export type TripInvoicePayload = {
  invoiceNo: string;
  tripId: string;
  tripUuid: string;
  invoiceDate: string;
  paymentMethod: string;
  currency: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  pickupAddress: string;
  dropoffAddress: string;
  pickupAt: string;
  dropoffAt: string;
  driverName: string;
  vehicleRegistration: string;
  intermediateStops: string[];
  lineItems: InvoiceLineItem[];
  subtotalPence: number;
  taxPence: number;
  taxRatePercent: number;
  totalPaidPence: number;
  originalPaidPence: number;
  refundAmountPence: number;
  netPaidAfterRefundPence: number;
  refundStatus: string | null;
  refundedAt: string | null;
  providerRefundId: string | null;
  company: Record<string, unknown>;
  branding: Record<string, unknown>;
};
