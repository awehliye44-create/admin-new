/**
 * Admin capture preconditions — fail closed before provider retrieve/capture.
 */
import {
  captureDifferencePence,
  resolveCanonicalCustomerPayablePence,
} from "./paymentSessionsCaptureConfirmationSSOT.ts";
import {
  FINANCIAL_MODEL_VIOLATION,
  SERVICE_AREA_FINANCIAL_MODEL,
} from "./commissionWalletSSOT.ts";

export const ADMIN_CAPTURE_PRECONDITION = {
  TRIP_NOT_FOUND: "TRIP_NOT_FOUND",
  TRIP_NOT_COMPLETED: "TRIP_NOT_COMPLETED",
  FINANCIAL_MODEL_VIOLATION: FINANCIAL_MODEL_VIOLATION,
  FINANCIAL_MODEL_NOT_PLATFORM_COLLECTED: "FINANCIAL_MODEL_NOT_PLATFORM_COLLECTED",
  SETTLEMENT_INPUTS_MISSING: "SETTLEMENT_INPUTS_MISSING",
  SETTLEMENT_STAMPS_INVALID: "SETTLEMENT_STAMPS_INVALID",
  CANONICAL_PAYABLE_UNRESOLVABLE: "CANONICAL_PAYABLE_UNRESOLVABLE",
  CAPTURE_AMOUNT_MISMATCH: "CAPTURE_AMOUNT_MISMATCH",
} as const;

export type AdminCapturePreconditionResult =
  | {
    ok: true;
    canonicalPayablePence: number;
    captureAmountPence: number;
  }
  | {
    ok: false;
    error_code: string;
    error: string;
  };

function positivePence(value: unknown): number | null {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function nonNegativePence(value: unknown): number | null {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function validateAdminCaptureTripPreconditions(args: {
  trip: Record<string, unknown>;
  amountPence?: number;
}): AdminCapturePreconditionResult {
  const tripId = String(args.trip.id ?? "").trim();
  if (!tripId) {
    return {
      ok: false,
      error_code: ADMIN_CAPTURE_PRECONDITION.TRIP_NOT_FOUND,
      error: "Trip not found",
    };
  }

  const financialModel = String(args.trip.financial_model ?? "").toUpperCase();
  if (financialModel === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET) {
    return {
      ok: false,
      error_code: FINANCIAL_MODEL_VIOLATION,
      error: `${FINANCIAL_MODEL_VIOLATION}: Admin provider capture forbidden on DRIVER_COLLECTED_COMMISSION_WALLET`,
    };
  }
  if (financialModel !== "PLATFORM_COLLECTED") {
    return {
      ok: false,
      error_code: ADMIN_CAPTURE_PRECONDITION.FINANCIAL_MODEL_NOT_PLATFORM_COLLECTED,
      error: "Admin provider capture requires financial_model=PLATFORM_COLLECTED",
    };
  }

  if (String(args.trip.status ?? "").toLowerCase() !== "completed") {
    return {
      ok: false,
      error_code: ADMIN_CAPTURE_PRECONDITION.TRIP_NOT_COMPLETED,
      error: "Trip must be completed before admin capture",
    };
  }

  const driverId = String(args.trip.driver_id ?? "").trim();
  if (!driverId) {
    return {
      ok: false,
      error_code: ADMIN_CAPTURE_PRECONDITION.SETTLEMENT_INPUTS_MISSING,
      error: "Missing driver_id for settlement",
    };
  }

  const payable = resolveCanonicalCustomerPayablePence({
    finalCustomerFarePence: args.trip.final_customer_fare_pence,
    finalFarePence: args.trip.final_fare_pence,
    noShowChargePence: args.trip.no_show_charge_pence,
    cancellationFeePence: args.trip.cancellation_fee_pence,
    outstandingBalancePence: args.trip.outstanding_balance_pence,
    estimatedTotalPence: args.trip.estimated_total_pence,
  });
  if (payable.payable_pence == null || payable.payable_pence <= 0) {
    return {
      ok: false,
      error_code: ADMIN_CAPTURE_PRECONDITION.CANONICAL_PAYABLE_UNRESOLVABLE,
      error: "Canonical customer payable amount is missing or zero",
    };
  }

  const commissionable = positivePence(args.trip.commissionable_fare_pence);
  const commission = nonNegativePence(args.trip.commission_pence);
  const driverNet = positivePence(args.trip.driver_net_pence);
  const formulaVersion = String(args.trip.settlement_formula_version ?? "").trim();

  if (commissionable == null || commission == null || driverNet == null || !formulaVersion) {
    return {
      ok: false,
      error_code: ADMIN_CAPTURE_PRECONDITION.SETTLEMENT_STAMPS_INVALID,
      error: "Missing or invalid settlement stamps (commissionable_fare_pence, commission_pence, driver_net_pence, settlement_formula_version)",
    };
  }

  const requestedCapture = args.amountPence ?? payable.payable_pence;
  if (requestedCapture <= 0) {
    return {
      ok: false,
      error_code: "INVALID_CAPTURE_AMOUNT",
      error: "amount_pence must be > 0",
    };
  }

  const diff = captureDifferencePence({
    providerCapturedPence: requestedCapture,
    canonicalPayablePence: payable.payable_pence,
  });
  if (diff != null && diff !== 0) {
    return {
      ok: false,
      error_code: ADMIN_CAPTURE_PRECONDITION.CAPTURE_AMOUNT_MISMATCH,
      error: `Capture amount (${requestedCapture}) must equal canonical payable (${payable.payable_pence}) exactly`,
    };
  }

  return {
    ok: true,
    canonicalPayablePence: payable.payable_pence,
    captureAmountPence: requestedCapture,
  };
}
