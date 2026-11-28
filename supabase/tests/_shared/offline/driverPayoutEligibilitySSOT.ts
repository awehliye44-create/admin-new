/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Canonical driver payout eligibility SSOT (pure — no I/O).
 */
import { FINANCIAL_MODEL, resolveFinancialModelStamp } from "../../../functions/_shared/financialModelScopeSSOT.ts";

import { resolveStablePayoutClearingOriginMs } from "../../../functions/_shared/paymentSessionCaptureTimestampSSOT.ts";

import {
  resolveTerminalEntitledDriverId,
  resolveTerminalOutcomeKind,
  type TerminalOutcomeKind,
} from "../../../functions/_shared/terminalOutcomeKindSSOT.ts";


/** Idempotency key for DES companion / backfill rows. */
export function desCompanionIdempotencyKey(ledgerEntryId: string, source: string): string {
  return `des:${source}:${ledgerEntryId}`;
}

export * from "../../../functions/_shared/driverPayoutEligibilitySSOT.ts";
