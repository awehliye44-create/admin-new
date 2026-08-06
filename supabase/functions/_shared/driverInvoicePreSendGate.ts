/**
 * Driver invoice pre-send validation gate.
 * Email delivery is impossible before lifecycle VALIDATED (and SEND_PENDING acquisition).
 */

import type { AggregationOutcome, ZeroTotalClassification } from "./driverInvoiceAggregationScope.ts";

export type DriverInvoiceLifecycle =
  | "DRAFT"
  | "AGGREGATING"
  | "VALIDATED"
  | "GENERATED"
  | "SEND_PENDING"
  | "SENT"
  | "SKIPPED_NO_VALID_EMAIL"
  | "FAILED"
  | "SUPERSEDED_TEST_ERROR"
  | "VOIDED_TEST_ERROR";

const TERMINAL_BLOCK_SEND = new Set([
  "SUPERSEDED_TEST_ERROR",
  "VOIDED_TEST_ERROR",
  "FAILED",
]);

export type PreSendValidationInput = {
  driverId: string | null | undefined;
  periodStart: string | null | undefined;
  periodEnd: string | null | undefined;
  lifecycleStatus: string | null | undefined;
  status: string | null | undefined;
  aggregation: AggregationOutcome | null;
  renderedNetPence: number;
  providerMessageId: string | null | undefined;
  invoiceEmailSent: boolean;
  smokeRunId: string | null | undefined;
  recipientDriverId: string | null | undefined;
  allowlistedDriverIds: string[];
  /** Development smoke: refuse zero-total email unless explicitly allowed. */
  allowEmailValidZero?: boolean;
  smokeBudgetOk: boolean;
  smokeBudgetCode?: string | null;
};

export type PreSendValidationResult =
  | { ok: true; lifecycle: "SEND_PENDING" }
  | { ok: false; code: string; message: string };

function datesValid(start: string, end: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  return start <= end;
}

export function canTransitionLifecycle(
  from: DriverInvoiceLifecycle | string | null | undefined,
  to: DriverInvoiceLifecycle,
): boolean {
  const f = (from ?? "DRAFT").toUpperCase();
  const order = ["DRAFT", "AGGREGATING", "VALIDATED", "GENERATED", "SEND_PENDING", "SENT"];
  if (to === "FAILED" || to === "SKIPPED_NO_VALID_EMAIL") return true;
  if (TERMINAL_BLOCK_SEND.has(f)) return false;
  const fi = order.indexOf(f);
  const ti = order.indexOf(to);
  if (fi < 0 || ti < 0) return false;
  return ti === fi || ti === fi + 1 || (f === "VALIDATED" && to === "GENERATED");
}

export function validateDriverInvoicePreSend(input: PreSendValidationInput): PreSendValidationResult {
  if (!input.driverId) {
    return { ok: false, code: "MISSING_DRIVER_ID", message: "Report requires exact driver_id" };
  }
  if (!input.periodStart || !input.periodEnd || !datesValid(input.periodStart, input.periodEnd)) {
    return { ok: false, code: "INVALID_PERIOD", message: "Period start/end invalid" };
  }

  const life = (input.lifecycleStatus ?? "").toUpperCase();
  const status = (input.status ?? "").toLowerCase();
  if (
    TERMINAL_BLOCK_SEND.has(life) ||
    status === "superseded_test_error" ||
    status === "voided_test_error" ||
    status === "cancelled"
  ) {
    return { ok: false, code: "INVOICE_NOT_SENDABLE", message: "Invoice voided, cancelled, or superseded" };
  }

  if (input.invoiceEmailSent || input.providerMessageId) {
    return { ok: false, code: "ALREADY_SENT", message: "Successful provider message already exists" };
  }

  if (!input.aggregation || !input.aggregation.ok) {
    return {
      ok: false,
      code: input.aggregation?.failureCode ?? "AGGREGATION_INCOMPLETE",
      message: "Ledger aggregation did not complete successfully",
    };
  }

  if (input.aggregation.failureCode === "NULL_SERVICE_AREA_FILTER_MISUSE") {
    return {
      ok: false,
      code: "NULL_SERVICE_AREA_FILTER_MISUSE",
      message: "Optional null service_area filter must not eliminate eligible ledger rows",
    };
  }

  if (typeof input.aggregation.includedRowCount !== "number") {
    return { ok: false, code: "INCLUDED_COUNT_UNKNOWN", message: "Included ledger row count unknown" };
  }

  if (input.aggregation.netDriverEarningsPence !== input.renderedNetPence) {
    return {
      ok: false,
      code: "TOTAL_MISMATCH",
      message: `Expected ${input.aggregation.netDriverEarningsPence} !== rendered ${input.renderedNetPence}`,
    };
  }

  if (life && life !== "VALIDATED" && life !== "GENERATED" && life !== "SEND_PENDING") {
    return {
      ok: false,
      code: "NOT_VALIDATED",
      message: `Email requires VALIDATED lifecycle; current=${life || "none"}`,
    };
  }

  // Zero-total: only VALID_ZERO_EARNINGS may generate; email only if explicitly allowed.
  if (input.renderedNetPence === 0) {
    const z = input.aggregation.zeroTotalClassification as ZeroTotalClassification | null;
    if (z !== "VALID_ZERO_EARNINGS") {
      return {
        ok: false,
        code: z ?? "INVALID_AGGREGATION",
        message: "Zero-total report is not classified as VALID_ZERO_EARNINGS",
      };
    }
    if (!input.allowEmailValidZero) {
      return {
        ok: false,
        code: "ZERO_TOTAL_EMAIL_BLOCKED",
        message: "Development smoke blocks emailing zero-total driver invoices unless explicitly testing VALID_ZERO_EARNINGS",
      };
    }
  }

  if (input.smokeRunId) {
    if (!input.recipientDriverId || !input.allowlistedDriverIds.includes(input.recipientDriverId)) {
      return {
        ok: false,
        code: "RECIPIENT_NOT_ALLOWLISTED",
        message: "Recipient driver is not allowlisted for the active smoke run",
      };
    }
    if (!input.smokeBudgetOk) {
      return {
        ok: false,
        code: input.smokeBudgetCode ?? "SMOKE_SEND_LIMIT_REACHED",
        message: "Smoke send budget rejected provider call",
      };
    }
  }

  return { ok: true, lifecycle: "SEND_PENDING" };
}
