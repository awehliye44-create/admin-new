/**
 * Canonical payout-item lifecycle resolver.
 *
 * Terminal `status` must not be overridden by a stale non-terminal `execution_status`.
 * Provider UNKNOWN / incomplete settlement evidence remains fail-closed (blocks new pay).
 */

export const PAYOUT_ITEM_TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "FAILED_PERMANENT",
  "FAILED_TERMINAL",
  "FAILED_RETRYABLE",
  "CANCELLED",
  "CANCELED",
  "RELEASED",
  "RETURNED",
  "REVERSED",
  "RESERVATION_RELEASED",
  "INELIGIBLE",
  "DECLINED",
]);

/** Non-terminal execution/status tokens that mean an open money path (uppercase). */
export const PAYOUT_ITEM_IN_FLIGHT_STATUSES = new Set([
  "PENDING",
  "PROCESSING",
  "CREATED",
  "VALIDATED",
  "RESERVING",
  "RESERVED",
  "READY",
  "SCHEDULED",
  "TRANSFER_CREATED",
  "SUBMITTING",
  "SUBMITTED",
  "SENT",
  "UNKNOWN",
  "PROVIDER_ACCEPTED",
]);

export type PayoutItemLifecycle =
  | "COMPLETED"
  | "FAILED_TERMINAL"
  | "CANCELLED_TERMINAL"
  | "IN_FLIGHT"
  | "MANUAL_REVIEW"
  | "IDLE";

export type PayoutItemLifecycleEvidence = {
  status?: string | null;
  execution_status?: string | null;
  /** Optional settlement evidence — when provided, contradictions → MANUAL_REVIEW. */
  reservation_status?: string | null;
  provider_intent_execution_status?: string | null;
  provider_state?: string | null;
  wallet_debit_count?: number | null;
  has_unresolved_provider_intent?: boolean | null;
};

export type PayoutItemLifecycleDecision = {
  lifecycle: PayoutItemLifecycle;
  /** True → must block a new EARLY_CASHOUT / WEEKLY reservation for this driver. */
  blocks_new_payout: boolean;
  reason: string;
  status_normalized: string;
  execution_status_normalized: string;
};

function norm(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

function isTerminalStatus(st: string): boolean {
  return PAYOUT_ITEM_TERMINAL_STATUSES.has(st);
}

function isFailedTerminal(st: string): boolean {
  return (
    st === "FAILED"
    || st === "FAILED_PERMANENT"
    || st === "FAILED_TERMINAL"
    || st === "FAILED_RETRYABLE"
    || st === "DECLINED"
  );
}

function isCancelledTerminal(st: string): boolean {
  return (
    st === "CANCELLED"
    || st === "CANCELED"
    || st === "RELEASED"
    || st === "RETURNED"
    || st === "REVERSED"
    || st === "RESERVATION_RELEASED"
    || st === "INELIGIBLE"
  );
}

function providerLooksUnknown(state: string, intentExec: string): boolean {
  return state === "UNKNOWN" || intentExec === "UNKNOWN";
}

function providerLooksCompleted(state: string, intentExec: string): boolean {
  const s = state.toLowerCase();
  return intentExec === "COMPLETED" || s === "completed";
}

/**
 * Resolve canonical lifecycle for a payout item.
 *
 * Precedence:
 * 1. Contradictory settlement evidence → MANUAL_REVIEW (blocks)
 * 2. Terminal status=COMPLETED with agreeing / absent evidence → COMPLETED (not in flight)
 * 3. Terminal failed/cancelled without unresolved provider → terminal (not in flight)
 * 4. In-flight status or execution_status (when status non-terminal) → IN_FLIGHT (blocks)
 * 5. Else IDLE
 */
export function resolvePayoutItemLifecycle(
  evidence: PayoutItemLifecycleEvidence,
): PayoutItemLifecycleDecision {
  const status = norm(evidence.status);
  const execution = norm(evidence.execution_status);
  const reservation = norm(evidence.reservation_status);
  const intentExec = norm(evidence.provider_intent_execution_status);
  const providerState = norm(evidence.provider_state);
  const hasUnresolved = evidence.has_unresolved_provider_intent === true;
  const debitCount = evidence.wallet_debit_count;
  const hasSettlementEvidence =
    evidence.reservation_status != null
    || evidence.provider_intent_execution_status != null
    || evidence.provider_state != null
    || evidence.wallet_debit_count != null
    || evidence.has_unresolved_provider_intent != null;

  const base = {
    status_normalized: status,
    execution_status_normalized: execution,
  };

  if (hasSettlementEvidence && status === "COMPLETED") {
    if (providerLooksUnknown(providerState, intentExec) || hasUnresolved) {
      return {
        ...base,
        lifecycle: "MANUAL_REVIEW",
        blocks_new_payout: true,
        reason: "COMPLETED_STATUS_BUT_PROVIDER_UNKNOWN_OR_UNRESOLVED",
      };
    }
    if (debitCount != null && debitCount !== 1) {
      return {
        ...base,
        lifecycle: "MANUAL_REVIEW",
        blocks_new_payout: true,
        reason: "COMPLETED_STATUS_BUT_WALLET_DEBIT_COUNT_NOT_ONE",
      };
    }
    if (reservation && reservation !== "CONSUMED") {
      return {
        ...base,
        lifecycle: "MANUAL_REVIEW",
        blocks_new_payout: true,
        reason: "COMPLETED_STATUS_BUT_RESERVATION_NOT_CONSUMED",
      };
    }
    if (
      intentExec
      && !providerLooksCompleted(providerState, intentExec)
      && intentExec !== "COMPLETED"
    ) {
      // Intent still non-terminal while item COMPLETED — fail closed.
      if (PAYOUT_ITEM_IN_FLIGHT_STATUSES.has(intentExec) || intentExec === "SUBMITTED") {
        return {
          ...base,
          lifecycle: "MANUAL_REVIEW",
          blocks_new_payout: true,
          reason: "COMPLETED_STATUS_BUT_PROVIDER_INTENT_NON_TERMINAL",
        };
      }
    }
  }

  // status=SUBMITTED/PROCESSING with provider completed but missing debit → MANUAL_REVIEW
  if (
    !isTerminalStatus(status)
    && hasSettlementEvidence
    && providerLooksCompleted(providerState, intentExec)
    && debitCount != null
    && debitCount < 1
  ) {
    return {
      ...base,
      lifecycle: "MANUAL_REVIEW",
      blocks_new_payout: true,
      reason: "PROVIDER_COMPLETED_BUT_WALLET_DEBIT_MISSING",
    };
  }

  if (status === "COMPLETED") {
    // Stale execution_status (e.g. SUBMITTED) must not keep the item in flight.
    return {
      ...base,
      lifecycle: "COMPLETED",
      blocks_new_payout: false,
      reason: execution && execution !== "COMPLETED"
        ? "TERMINAL_STATUS_PRECEDENCE_OVER_STALE_EXECUTION"
        : "COMPLETED",
    };
  }

  if (isFailedTerminal(status)) {
    if (hasUnresolved || providerLooksUnknown(providerState, intentExec)) {
      return {
        ...base,
        lifecycle: "MANUAL_REVIEW",
        blocks_new_payout: true,
        reason: "FAILED_STATUS_BUT_UNRESOLVED_PROVIDER",
      };
    }
    return {
      ...base,
      lifecycle: "FAILED_TERMINAL",
      blocks_new_payout: false,
      reason: "FAILED_TERMINAL",
    };
  }

  if (isCancelledTerminal(status)) {
    if (hasUnresolved || providerLooksUnknown(providerState, intentExec)) {
      return {
        ...base,
        lifecycle: "MANUAL_REVIEW",
        blocks_new_payout: true,
        reason: "CANCELLED_STATUS_BUT_UNRESOLVED_PROVIDER",
      };
    }
    return {
      ...base,
      lifecycle: "CANCELLED_TERMINAL",
      blocks_new_payout: false,
      reason: "CANCELLED_TERMINAL",
    };
  }

  // Non-terminal status: prefer execution_status when present, else status.
  const probe = execution || status;
  if (probe && PAYOUT_ITEM_IN_FLIGHT_STATUSES.has(probe)) {
    return {
      ...base,
      lifecycle: "IN_FLIGHT",
      blocks_new_payout: true,
      reason: execution ? "IN_FLIGHT_EXECUTION_STATUS" : "IN_FLIGHT_STATUS",
    };
  }

  return {
    ...base,
    lifecycle: "IDLE",
    blocks_new_payout: false,
    reason: "IDLE",
  };
}

/**
 * Weekly / early-cashout conflict gate (row-level, no settlement join required).
 * Terminal status wins over stale execution_status.
 */
export function isConflictingActivePayoutItem(item: {
  status?: string | null;
  execution_status?: string | null;
}): boolean {
  return resolvePayoutItemLifecycle({
    status: item.status,
    execution_status: item.execution_status,
  }).blocks_new_payout;
}

/** Canonical completed execution_status persisted by finalize / repair. */
export const CANONICAL_COMPLETED_EXECUTION_STATUS = "COMPLETED" as const;
