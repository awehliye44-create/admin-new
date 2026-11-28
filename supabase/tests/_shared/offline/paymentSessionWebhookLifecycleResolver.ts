/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Canonical monotonic Payment Session lifecycle resolver for Revolut webhooks.
 *
 * Webhook updates must never regress payment_sessions.status backwards.
 * Provider evidence (provider_state, captured_amount_pence) is separate from
 * application lifecycle status.
 *
 * Lock: paymentSessionWebhookLifecycleLock.test.ts
 */

import { fromDbPaymentSessionStatus } from "../../../functions/_shared/revolutPaymentHoldSSOT.ts";

import {
  isCanonicalTerminalNegative,
  normalizeLifecycleProviderState,
  terminalNegativeSessionStatus,
} from "../../../functions/_shared/paymentSessionLifecycleStateSSOT.ts";

import { revolutProviderStateRank } from "../../../functions/_shared/revolutProviderStateRankSSOT.ts";


/** Exported transition policy for audit reports and lock tests. */
export const PAYMENT_SESSION_WEBHOOK_TRANSITION_POLICY: ReadonlyArray<{
  from: string;
  to: string;
  allowed: boolean;
  condition: string;
}> = [
  { from: "trip_created", to: "captured", allowed: true, condition: "verified capture evidence present" },
  { from: "captured", to: "captured", allowed: true, condition: "idempotent duplicate webhook" },
  { from: "captured", to: "trip_created", allowed: false, condition: "forbidden regression" },
  { from: "captured", to: "payment_authorised", allowed: false, condition: "forbidden regression to pre-capture" },
  { from: "captured", to: "pending_payment", allowed: false, condition: "forbidden regression to pre-capture" },
  { from: "refunded", to: "trip_created", allowed: false, condition: "forbidden regression" },
  { from: "refunded", to: "captured", allowed: false, condition: "forbidden after refund" },
  { from: "cancelled", to: "trip_created", allowed: false, condition: "forbidden regression" },
  { from: "failed", to: "trip_created", allowed: false, condition: "forbidden regression" },
  { from: "released", to: "trip_created", allowed: false, condition: "forbidden regression" },
  { from: "released_after_recovery", to: "trip_created", allowed: false, condition: "forbidden regression" },
];

export * from "../../../functions/_shared/paymentSessionWebhookLifecycleResolver.ts";
