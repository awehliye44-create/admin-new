/**
 * Sanitised provider snapshots for admin Payment Sessions inspect (Phase 1C).
 * Phase 1A: contract + redaction helpers only.
 */

const REVOLUT_REDACT_KEYS = new Set([
  "token",
  "checkout_url",
  "public_id",
  "client_secret",
  "saved_payment_method",
]);

export type SanitisedRevolutOrderSnapshot = {
  id: string | null;
  state: string | null;
  amount: number | null;
  currency: string | null;
  payment_method_type: string | null;
  card_brand: string | null;
  card_last4: string | null;
  authorisation_state: string | null;
  capture_state: string | null;
  refund_state: string | null;
  fetched_at: string;
  sanitisation_version: "v1";
};

export type SanitisedStripePaymentIntentSnapshot = {
  id: string | null;
  status: string | null;
  amount: number | null;
  amount_capturable: number | null;
  amount_received: number | null;
  currency: string | null;
  capture_method: string | null;
  payment_method_type: string | null;
  card_brand: string | null;
  card_last4: string | null;
  latest_charge_id: string | null;
  refund_status: string | null;
  fetched_at: string;
  sanitisation_version: "v1";
};

export function sanitiseRevolutOrder(raw: Record<string, unknown>): SanitisedRevolutOrderSnapshot {
  const pm = raw.payment_method as Record<string, unknown> | undefined;
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    state: typeof raw.state === "string" ? raw.state : null,
    amount: typeof raw.amount === "number" ? raw.amount : null,
    currency: typeof raw.currency === "string" ? raw.currency : null,
    payment_method_type: typeof pm?.type === "string" ? pm.type : null,
    card_brand: typeof pm?.card_brand === "string" ? pm.card_brand : null,
    card_last4: typeof pm?.card_last_four === "string"
      ? pm.card_last_four
      : typeof pm?.last_four === "string"
        ? pm.last_four
        : null,
    authorisation_state: typeof raw.state === "string" ? raw.state : null,
    capture_state: null,
    refund_state: null,
    fetched_at: new Date().toISOString(),
    sanitisation_version: "v1",
  };
}

export function assertNoRedactedKeysInSnapshot(
  snapshot: Record<string, unknown>,
  raw: Record<string, unknown>,
): string[] {
  const leaks: string[] = [];
  for (const key of REVOLUT_REDACT_KEYS) {
    if (key in snapshot && snapshot[key] != null) leaks.push(key);
    if (JSON.stringify(snapshot).includes(String(raw[key] ?? "")) && raw[key] != null && key === "token") {
      leaks.push(`leaked:${key}`);
    }
  }
  return leaks;
}

export function sanitiseStripePaymentIntent(raw: Record<string, unknown>): SanitisedStripePaymentIntentSnapshot {
  const pm = raw.payment_method as Record<string, unknown> | undefined;
  const card = pm?.card as Record<string, unknown> | undefined;
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    status: typeof raw.status === "string" ? raw.status : null,
    amount: typeof raw.amount === "number" ? raw.amount : null,
    amount_capturable: typeof raw.amount_capturable === "number" ? raw.amount_capturable : null,
    amount_received: typeof raw.amount_received === "number" ? raw.amount_received : null,
    currency: typeof raw.currency === "string" ? raw.currency : null,
    capture_method: typeof raw.capture_method === "string" ? raw.capture_method : null,
    payment_method_type: typeof pm?.type === "string" ? pm.type : null,
    card_brand: typeof card?.brand === "string" ? card.brand : null,
    card_last4: typeof card?.last4 === "string" ? card.last4 : null,
    latest_charge_id: typeof raw.latest_charge === "string" ? raw.latest_charge : null,
    refund_status: null,
    fetched_at: new Date().toISOString(),
    sanitisation_version: "v1",
  };
}
