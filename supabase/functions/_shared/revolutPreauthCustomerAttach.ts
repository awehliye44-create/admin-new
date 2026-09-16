/**
 * When a booking preauth may attach a Revolut customer to POST /orders.
 *
 * Customer id is required for explicit card save and for saved-card reuse.
 * Apple Pay and Google Pay must not receive it — a stale cached id 404s the
 * order create before the wallet sheet opens, and those paths send no save flags.
 */

export const REVOLUT_PAYMENT_SETUP_FAILED_MESSAGE =
  "Payment setup failed. Please try again or choose another payment method.";

const WALLET_METHODS = new Set(["apple_pay", "applepay", "google_pay", "googlepay"]);

export function normalizePreauthPaymentMethod(paymentMethodType?: string | null): string {
  return String(paymentMethodType ?? "card").trim().toLowerCase();
}

export function isWalletPreauthMethod(paymentMethodType?: string | null): boolean {
  return WALLET_METHODS.has(normalizePreauthPaymentMethod(paymentMethodType));
}

/**
 * Attach Revolut customer only for card save and saved-card reuse.
 * Wallets never attach, even if a stale platform id is also present.
 */
export function shouldAttachRevolutCustomerForPreauth(args: {
  paymentMethodType?: string | null;
  /** Rider opted in and vault is under the cap — pending platform id allocated. */
  saveCardEligible: boolean;
  /** Client sent an existing platform payment method id (saved-card reuse). */
  savedCardReuse: boolean;
}): boolean {
  if (isWalletPreauthMethod(args.paymentMethodType)) return false;
  const method = normalizePreauthPaymentMethod(args.paymentMethodType);
  if (method !== "card" && method !== "") return false;
  return args.savedCardReuse || args.saveCardEligible;
}

export type PreauthOrderCreateMetadata = Record<string, string>;

/** Order metadata written by create-preauth. Does not itself attach a customer. */
export function buildPreauthOrderCreateMetadata(args: {
  metadataExtra: Record<string, string>;
  estimatedTotalPence: number;
  bufferPence: number;
  paymentMethodType?: string | null;
  saveCardEligible: boolean;
  clientActionId?: string | null;
  userId?: string | null;
  platformPaymentMethodId?: string | null;
}): PreauthOrderCreateMetadata {
  return {
    ...args.metadataExtra,
    type: "trip_preauth",
    estimated_total_pence: String(args.estimatedTotalPence),
    buffer_pence: String(args.bufferPence),
    payment_method_type: String(args.paymentMethodType ?? "card"),
    save_card_eligible: args.saveCardEligible ? "true" : "false",
    ...(args.clientActionId ? { client_action_id: args.clientActionId } : {}),
    ...(args.userId ? { customer_user_id: args.userId } : {}),
    ...(args.platformPaymentMethodId
      ? { platform_payment_method_id: args.platformPaymentMethodId }
      : {}),
  };
}

export type RevolutOrderCustomerRef = {
  id?: string;
  email?: string;
  full_name?: string;
};

/** Same customer field createRevolutOrder sends. Omitted entirely when there is no id or email. */
export function buildRevolutOrderCustomerField(
  customer?: RevolutOrderCustomerRef | null,
): { id: string } | { email: string; full_name?: string } | undefined {
  const id = customer?.id?.trim();
  if (id) return { id };
  const email = customer?.email?.trim();
  if (!email) return undefined;
  const fullName = customer?.full_name?.trim();
  return fullName ? { email, full_name: fullName } : { email };
}

export type CreateRevolutOrderBodyInput = {
  amountMinor: number;
  currency: string;
  tripId: string;
  description?: string;
  metadata?: Record<string, string>;
  customer?: RevolutOrderCustomerRef | null;
  enableIncrementalAuthorisation?: boolean;
  /** Hosted checkout return URL — mapped to Revolut's `redirect_url` field. */
  redirectUrl?: string | null;
};

/** Merchant POST /orders body. `customer` is absent unless a customer ref was supplied. */
export function buildCreateRevolutOrderRequestBody(
  p: CreateRevolutOrderBodyInput,
): Record<string, unknown> {
  const customer = buildRevolutOrderCustomerField(p.customer);
  const enableIncrement = p.enableIncrementalAuthorisation !== false;
  const redirectUrl = typeof p.redirectUrl === "string" ? p.redirectUrl.trim() : "";
  return {
    amount: p.amountMinor,
    currency: p.currency.toUpperCase(),
    capture_mode: "manual",
    ...(enableIncrement ? { authorisation_type: "pre_authorisation" } : {}),
    merchant_order_ext_ref: p.tripId,
    description: p.description ?? "ONECAB trip payment",
    metadata: p.metadata ?? {},
    ...(customer ? { customer } : {}),
    ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
  };
}

export function isStaleCachedRevolutCustomerError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { status?: unknown; message?: unknown };
  const message = String(record.message ?? "").toLowerCase();
  const status = typeof record.status === "number" ? record.status : null;
  if (
    message.includes("requested resource is not found")
    || message.includes("resource is not found")
    || message.includes("resource not found")
    || message.includes("endpoint not found")
  ) {
    return true;
  }
  return status === 404;
}

/**
 * One retry, only when the first POST failed before any payment_session insert
 * and we had sent a cached customer id. Does not authorise a second order if
 * the first call did not fail this way.
 */
export function planStaleCachedCustomerOrderRetry(args: {
  sentCachedCustomerId: boolean;
  alreadyRetried: boolean;
  err: unknown;
}): "refresh_and_retry" | "none" {
  if (args.alreadyRetried || !args.sentCachedCustomerId) return "none";
  if (!isStaleCachedRevolutCustomerError(args.err)) return "none";
  return "refresh_and_retry";
}

/**
 * After a stale-id 404, retry with a refreshed id only when it is new.
 * Same id or email-only refresh omits customer so the retry cannot repeat the 404.
 */
export function customerForStaleOrderRetry(args: {
  staleCustomerId: string;
  refreshed?: RevolutOrderCustomerRef | null;
}): RevolutOrderCustomerRef | null {
  const nextId = args.refreshed?.id?.trim() || "";
  if (!nextId || nextId === args.staleCustomerId.trim()) return null;
  return args.refreshed ?? null;
}
