/**
 * Structured diagnostics for payment_authorization_ledger writes.
 *
 * Logs identifiers and the Postgres/PostgREST classification only. Never logs the
 * raw error message/details (details echo row values), amounts, card data, saved-card
 * tokens, fingerprint data or customer PII.
 */

export type PaymentLedgerErrorCategory =
  | "owner_missing"
  | "fk_violation"
  | "unique_violation"
  | "check_violation"
  | "not_null_violation"
  | "undefined_column"
  | "permission_denied"
  | "network"
  | "unknown";

export type PaymentLedgerErrorClassification = {
  error_code: string | null;
  error_category: PaymentLedgerErrorCategory;
  constraint: string | null;
  column: string | null;
};

export type PaymentLedgerWriteContext = {
  operation: string;
  stage: string;
  paymentSessionId?: string | null;
  clientActionId?: string | null;
  tripId?: string | null;
  providerOrderId?: string | null;
  /** What the caller does next — e.g. "booking_continues_trigger_backstop". */
  consequence: string;
};

export type PaymentLedgerWriteFailedEvent = {
  event: "PAYMENT_LEDGER_WRITE_FAILED";
  operation: string;
  stage: string;
  payment_session_id: string | null;
  client_action_id: string | null;
  trip_id: string | null;
  provider_order_id: string | null;
  consequence: string;
} & PaymentLedgerErrorClassification;

export class PaymentLedgerWriteError extends Error {
  readonly classification: PaymentLedgerErrorClassification;
  constructor(classification: PaymentLedgerErrorClassification) {
    super(
      `payment ledger write failed: ${classification.error_category}` +
        (classification.constraint ? ` (${classification.constraint})` : "") +
        (classification.error_code ? ` [${classification.error_code}]` : ""),
    );
    this.name = "PaymentLedgerWriteError";
    this.classification = classification;
  }
}

const SQLSTATE_CATEGORY: Record<string, PaymentLedgerErrorCategory> = {
  "23503": "fk_violation",
  "23505": "unique_violation",
  "23514": "check_violation",
  "23502": "not_null_violation",
  "42703": "undefined_column",
  PGRST204: "undefined_column",
  "42501": "permission_denied",
};

function quoted(message: string, pattern: RegExp): string | null {
  const m = message.match(pattern);
  return m?.[1] ? m[1].slice(0, 120) : null;
}

export function classifyPaymentLedgerError(err: unknown): PaymentLedgerErrorClassification {
  if (err instanceof PaymentLedgerWriteError) return err.classification;
  const e = (err ?? {}) as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof e.code === "string" && e.code.trim() ? e.code.trim() : null;
  const message = typeof e.message === "string" ? e.message : "";
  let category: PaymentLedgerErrorCategory = code ? SQLSTATE_CATEGORY[code] ?? "unknown" : "unknown";
  if (category === "unknown" && !code) {
    if (/fetch|network|timed? ?out|ECONN|socket|connection/i.test(message) || e.name === "TypeError") {
      category = "network";
    } else if (/row-level security|permission denied/i.test(message)) {
      category = "permission_denied";
    }
  }
  return {
    error_code: code,
    error_category: category,
    constraint: quoted(message, /constraint "([A-Za-z0-9_]+)"/),
    column: quoted(message, /column "([A-Za-z0-9_]+)"/) ?? quoted(message, /the '([A-Za-z0-9_]+)' column/),
  };
}

export function buildPaymentLedgerWriteFailedEvent(
  ctx: PaymentLedgerWriteContext,
  err: unknown,
): PaymentLedgerWriteFailedEvent {
  return {
    event: "PAYMENT_LEDGER_WRITE_FAILED",
    operation: ctx.operation,
    stage: ctx.stage,
    payment_session_id: ctx.paymentSessionId ?? null,
    client_action_id: ctx.clientActionId ?? null,
    trip_id: ctx.tripId ?? null,
    provider_order_id: ctx.providerOrderId ?? null,
    consequence: ctx.consequence,
    ...classifyPaymentLedgerError(err),
  };
}

export function reportPaymentLedgerWriteFailure(
  ctx: PaymentLedgerWriteContext,
  err: unknown,
  log: (line: string) => void = (line) => console.error(line),
): PaymentLedgerWriteFailedEvent {
  const event = buildPaymentLedgerWriteFailedEvent(ctx, err);
  log(JSON.stringify(event));
  return event;
}
