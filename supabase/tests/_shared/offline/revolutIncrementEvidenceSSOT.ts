/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Revolut incremental-authorisation provider evidence (pure helpers).
 *
 * Documented contract (Merchant API 2026-04-20):
 *   incremental_authorisations[].state   pending | processing | authorised | declined | failed
 *   incremental_authorisations[].reason  present only when state is declined or failed
 *   declined = declined by the card issuer / card network
 *   failed   = technical error, NOT an issuer decline
 *
 * Evidence is an allow-list of scalar fields. Card numbers, CVV, payment
 * tokens, last_four, checkout URLs and customer data are never copied.
 *
 * Bug #18 Tier A: enrich method/brand/order/timestamps without changing
 * payment behaviour.
 */

import type { RevolutOrder } from "../../../functions/_shared/revolutOrders.ts";
import { INCREMENT_EVIDENCE_FORBIDDEN_TOKENS } from "../../../functions/_shared/revolutIncrementEvidenceSSOT.ts";


export function evidencePayloadLooksSafe(payload: unknown): boolean {
  const raw = JSON.stringify(payload ?? {}).toLowerCase();
  for (const token of INCREMENT_EVIDENCE_FORBIDDEN_TOKENS) {
    // Allow benign words like "authorised_amount" — only flag card-number-ish keys.
    if (token === "number") {
      if (raw.includes("card_number") || raw.includes('"number"')) return false;
      continue;
    }
    if (raw.includes(token)) return false;
  }
  return true;
}

export * from "../../../functions/_shared/revolutIncrementEvidenceSSOT.ts";
