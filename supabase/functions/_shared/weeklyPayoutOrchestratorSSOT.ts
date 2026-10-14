/**
 * Canonical weekly payout orchestrator SSOT (read-model + pure gates).
 * Owns planning statuses, funding gate, blockers, idempotency keys, batch aggregate.
 * Never mutates wallets or calls Revolut by itself — the edge executor does that.
 */

import { isConflictingActivePayoutItem } from "./payoutItemLifecycleSSOT.ts";

export const ORCHESTRATOR_ITEM_STATUS = {
  ELIGIBLE: "ELIGIBLE",
  RESERVED: "RESERVED",
  SUBMITTING: "SUBMITTING",
  PROVIDER_ACCEPTED: "PROVIDER_ACCEPTED",
  COMPLETED: "COMPLETED",
  FAILED_RETRYABLE: "FAILED_RETRYABLE",
  FAILED_PERMANENT: "FAILED_PERMANENT",
  RESERVATION_RELEASED: "RESERVATION_RELEASED",
} as const;

export type OrchestratorItemStatus =
  (typeof ORCHESTRATOR_ITEM_STATUS)[keyof typeof ORCHESTRATOR_ITEM_STATUS];

export const ORCHESTRATOR_BATCH_STATUS = {
  COMPLETED: "COMPLETED",
  PARTIALLY_COMPLETED: "PARTIALLY_COMPLETED",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
  PROCESSING: "PROCESSING",
  PLANNED: "PLANNED",
} as const;

export type OrchestratorBatchStatus =
  (typeof ORCHESTRATOR_BATCH_STATUS)[keyof typeof ORCHESTRATOR_BATCH_STATUS];

export const ORCHESTRATOR_RUN_STATUS = {
  CLAIMED: "CLAIMED",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
} as const;

export const ORCHESTRATOR_BLOCKER = {
  LIVE_PAYOUT_ROLLOUT_DISABLED: "LIVE_PAYOUT_ROLLOUT_DISABLED",
  INSUFFICIENT_SETTLED_FUNDS: "INSUFFICIENT_SETTLED_FUNDS",
  RECIPIENT_VERIFICATION_MISSING: "RECIPIENT_VERIFICATION_MISSING",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_STATUS_PENDING: "PROVIDER_STATUS_PENDING",
  PAYOUTS_DISABLED: "PAYOUTS_DISABLED",
  WRONG_PAYOUT_DAY: "WRONG_PAYOUT_DAY",
  WRONG_PAYOUT_TIME: "WRONG_PAYOUT_TIME",
  PAYMENT_TRANSPORT_DISABLED: "PAYMENT_TRANSPORT_DISABLED",
  ZERO_ELIGIBLE_DRIVERS: "ZERO_ELIGIBLE_DRIVERS",
  OCCURRENCE_ALREADY_COMPLETED: "OCCURRENCE_ALREADY_COMPLETED",
} as const;

/** Claim-RPC infrastructure failure. Never classified as SCHEDULER_NOT_INVOKED. */
export const ORCHESTRATOR_CLAIM_ERROR = {
  OCCURRENCE_CLAIM_FAILED: "OCCURRENCE_CLAIM_FAILED",
} as const;

export type OrchestratorClaimErrorCode =
  (typeof ORCHESTRATOR_CLAIM_ERROR)[keyof typeof ORCHESTRATOR_CLAIM_ERROR];

export function classifyWeeklyOccurrenceClaimFailure(input: {
  message?: string | null;
  code?: string | null;
}): {
  success: false;
  error: "OCCURRENCE_CLAIM_FAILED";
  error_code: "OCCURRENCE_CLAIM_FAILED";
  classification: "OCCURRENCE_CLAIM_FAILED";
  message: string;
  hint: string;
} {
  const raw = String(input.message ?? input.code ?? "").trim();
  return {
    success: false,
    error: ORCHESTRATOR_CLAIM_ERROR.OCCURRENCE_CLAIM_FAILED,
    error_code: ORCHESTRATOR_CLAIM_ERROR.OCCURRENCE_CLAIM_FAILED,
    classification: ORCHESTRATOR_CLAIM_ERROR.OCCURRENCE_CLAIM_FAILED,
    message: raw || "weekly occurrence claim failed",
    hint:
      "ON CONFLICT must target UNIQUE (schedule_occurrence_key, dry_run). Do not classify as SCHEDULER_NOT_INVOKED.",
  };
}

export type OrchestratorBlockerCode =
  (typeof ORCHESTRATOR_BLOCKER)[keyof typeof ORCHESTRATOR_BLOCKER];

export const FUNDING_RESULT = {
  SUFFICIENT: "SUFFICIENT",
  INSUFFICIENT: "INSUFFICIENT",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type FundingResult = (typeof FUNDING_RESULT)[keyof typeof FUNDING_RESULT];

export function orchestratorBlockerLabel(code: string | null | undefined): string {
  const c = String(code ?? "").trim().toUpperCase();
  switch (c) {
    case ORCHESTRATOR_BLOCKER.LIVE_PAYOUT_ROLLOUT_DISABLED:
      return "Live payout rollout disabled";
    case ORCHESTRATOR_BLOCKER.INSUFFICIENT_SETTLED_FUNDS:
      return "Insufficient settled funds";
    case ORCHESTRATOR_BLOCKER.RECIPIENT_VERIFICATION_MISSING:
      return "Recipient verification missing";
    case ORCHESTRATOR_BLOCKER.PROVIDER_UNAVAILABLE:
      return "Provider unavailable";
    case ORCHESTRATOR_BLOCKER.PROVIDER_STATUS_PENDING:
      return "Provider status pending confirmation";
    case ORCHESTRATOR_BLOCKER.PAYOUTS_DISABLED:
      return "Automatic payouts disabled";
    case ORCHESTRATOR_BLOCKER.WRONG_PAYOUT_DAY:
      return "Not the configured payout day";
    case ORCHESTRATOR_BLOCKER.WRONG_PAYOUT_TIME:
      return "Before configured payout time";
    case ORCHESTRATOR_BLOCKER.PAYMENT_TRANSPORT_DISABLED:
      return "Revolut payment transport disabled";
    case ORCHESTRATOR_BLOCKER.ZERO_ELIGIBLE_DRIVERS:
      return "No eligible drivers";
    case ORCHESTRATOR_BLOCKER.OCCURRENCE_ALREADY_COMPLETED:
      return "Occurrence already completed";
    case ORCHESTRATOR_CLAIM_ERROR.OCCURRENCE_CLAIM_FAILED:
      return "Weekly occurrence claim failed";
    case "BLOCKED_EXECUTION_DISABLED":
      return "Live payout rollout disabled";
    default:
      return c ? c.replace(/_/g, " ").toLowerCase().replace(/^\w/, (x) => x.toUpperCase()) : "Unknown blocker";
  }
}

/** Batch funding vs configured Revolut payout source available (settled cash only). */
export function evaluateBatchFundingGate(args: {
  required_batch_pence: number;
  available_pence: number | null | undefined;
}): {
  result: FundingResult;
  required_batch_pence: number;
  available_pence: number | null;
  blocker_code: OrchestratorBlockerCode | null;
} {
  const required = Math.max(0, Math.round(Number(args.required_batch_pence ?? 0)));
  if (args.available_pence == null || !Number.isFinite(Number(args.available_pence))) {
    return {
      result: FUNDING_RESULT.UNAVAILABLE,
      required_batch_pence: required,
      available_pence: null,
      blocker_code: ORCHESTRATOR_BLOCKER.INSUFFICIENT_SETTLED_FUNDS,
    };
  }
  const available = Math.max(0, Math.round(Number(args.available_pence)));
  if (available < required) {
    return {
      result: FUNDING_RESULT.INSUFFICIENT,
      required_batch_pence: required,
      available_pence: available,
      blocker_code: ORCHESTRATOR_BLOCKER.INSUFFICIENT_SETTLED_FUNDS,
    };
  }
  return {
    result: FUNDING_RESULT.SUFFICIENT,
    required_batch_pence: required,
    available_pence: available,
    blocker_code: null,
  };
}

export type RunningFundingDecision = {
  key: string;
  amount_pence: number;
  funded: boolean;
  remaining_before_pence: number | null;
  remaining_after_pence: number | null;
};

/**
 * One funding allowance per pass, drawn down item by item so two drivers can
 * never both be approved against the same pence. Smallest amount first (driver
 * key breaks ties) so the order is deterministic and an unaffordable large item
 * cannot block smaller ones behind it. Unknown balance funds nothing.
 */
export function allocateRunningPayoutFunding(args: {
  available_pence: number | null | undefined;
  items: ReadonlyArray<{ key: string; amount_pence: number }>;
}): { decisions: RunningFundingDecision[]; funded_count: number; remaining_pence: number | null } {
  const known = args.available_pence != null && Number.isFinite(Number(args.available_pence));
  let remaining = known ? Math.max(0, Math.round(Number(args.available_pence))) : null;
  const ordered = [...args.items]
    .map((it) => ({ key: String(it.key), amount_pence: Math.max(0, Math.round(Number(it.amount_pence ?? 0))) }))
    .sort((a, b) => a.amount_pence - b.amount_pence || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const decisions: RunningFundingDecision[] = [];
  let funded_count = 0;
  for (const it of ordered) {
    if (remaining == null || it.amount_pence <= 0 || it.amount_pence > remaining) {
      decisions.push({
        key: it.key,
        amount_pence: it.amount_pence,
        funded: false,
        remaining_before_pence: remaining,
        remaining_after_pence: remaining,
      });
      continue;
    }
    const before = remaining;
    remaining -= it.amount_pence;
    funded_count += 1;
    decisions.push({
      key: it.key,
      amount_pence: it.amount_pence,
      funded: true,
      remaining_before_pence: before,
      remaining_after_pence: remaining,
    });
  }
  return { decisions, funded_count, remaining_pence: remaining };
}

/** Immutable per-attempt record of the funding the pay decision relied on. */
export function buildPayoutFundingAttemptSnapshot(args: {
  run_id: string | null;
  schedule_occurrence_key: string | null;
  payout_item_id: string;
  intent_id: string;
  driver_id: string;
  claim_token: string;
  source_account_id: string;
  source_account_label?: string | null;
  balance_read_at: string;
  provider_available_pence: number;
  decision: RunningFundingDecision;
}): Readonly<Record<string, unknown>> {
  if (!args.decision.funded || args.decision.remaining_before_pence == null
    || args.decision.remaining_after_pence == null) {
    throw new Error("FUNDING_SNAPSHOT_REQUIRES_FUNDED_DECISION");
  }
  return Object.freeze({
    run_id: args.run_id,
    schedule_occurrence_key: args.schedule_occurrence_key,
    payout_item_id: args.payout_item_id,
    intent_id: args.intent_id,
    driver_id: args.driver_id,
    claim_token: args.claim_token,
    source_account_id: args.source_account_id,
    source_account_label: args.source_account_label ?? null,
    balance_read_at: args.balance_read_at,
    provider_available_pence: Math.round(args.provider_available_pence),
    remaining_before_pence: args.decision.remaining_before_pence,
    amount_pence: args.decision.amount_pence,
    remaining_after_pence: args.decision.remaining_after_pence,
    allocation_order: "amount_asc_driver_id",
  });
}

/** Provider states that undo a completed driver payout. Flag only — never auto-correct money. */
export function classifyPayoutReversalProviderState(
  state: string | null | undefined,
): "REVERSED" | "FAILED" | null {
  const s = String(state ?? "").trim().toLowerCase();
  if (s === "reverted" || s === "reversed" || s === "returned" || s === "refunded") return "REVERSED";
  if (s === "failed" || s === "declined" || s === "cancelled" || s === "canceled") return "FAILED";
  return null;
}

export function mayOrchestratorMoveMoney(env: {
  get(key: string): string | undefined;
}): { ok: true } | { ok: false; blocker_code: OrchestratorBlockerCode } {
  const live =
    (env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
  const transport =
    (env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").trim().toLowerCase() === "true";
  if (!live) {
    return { ok: false, blocker_code: ORCHESTRATOR_BLOCKER.LIVE_PAYOUT_ROLLOUT_DISABLED };
  }
  if (!transport) {
    return { ok: false, blocker_code: ORCHESTRATOR_BLOCKER.PAYMENT_TRANSPORT_DISABLED };
  }
  return { ok: true };
}

export function orchestratorIdempotencyKey(args: {
  occurrence_key: string;
  driver_id: string;
  payout_item_id: string;
  purpose: "reserve" | "submit" | "finalize" | "release";
}): string {
  return [
    "weekly-payout",
    args.purpose,
    args.occurrence_key,
    args.driver_id,
    args.payout_item_id,
  ].join(":");
}

export function orchestratorProviderRequestId(args: {
  payout_item_id: string;
  purpose?: "submit";
}): string {
  // Revolut request ids max 40 chars â keep stable short form.
  const id = String(args.payout_item_id).replace(/-/g, "").slice(0, 32);
  return `wp${id}`.slice(0, 40);
}

export function aggregateOrchestratorBatchStatus(
  items: ReadonlyArray<{ status: string }>,
  args?: { blocked?: boolean; blocker_code?: string | null },
): {
  status: OrchestratorBatchStatus;
  successful: number;
  failed: number;
  unfinished: number;
  total: number;
} {
  if (args?.blocked) {
    return {
      status: ORCHESTRATOR_BATCH_STATUS.BLOCKED,
      successful: 0,
      failed: 0,
      unfinished: items.length,
      total: items.length,
    };
  }
  let successful = 0;
  let failed = 0;
  let unfinished = 0;
  for (const item of items) {
    const st = String(item.status ?? "").toUpperCase();
    if (st === ORCHESTRATOR_ITEM_STATUS.COMPLETED) successful += 1;
    else if (
      st === ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE
      || st === ORCHESTRATOR_ITEM_STATUS.FAILED_PERMANENT
      || st === ORCHESTRATOR_ITEM_STATUS.RESERVATION_RELEASED
    ) {
      failed += 1;
    } else unfinished += 1;
  }
  const total = items.length;
  if (total === 0) {
    return {
      status: ORCHESTRATOR_BATCH_STATUS.BLOCKED,
      successful,
      failed,
      unfinished,
      total,
    };
  }
  if (successful === total) {
    return { status: ORCHESTRATOR_BATCH_STATUS.COMPLETED, successful, failed, unfinished, total };
  }
  if (successful > 0 && (failed > 0 || unfinished > 0)) {
    return {
      status: ORCHESTRATOR_BATCH_STATUS.PARTIALLY_COMPLETED,
      successful,
      failed,
      unfinished,
      total,
    };
  }
  if (failed === total) {
    return { status: ORCHESTRATOR_BATCH_STATUS.FAILED, successful, failed, unfinished, total };
  }
  if (unfinished === total && successful === 0 && failed === 0) {
    return { status: ORCHESTRATOR_BATCH_STATUS.PLANNED, successful, failed, unfinished, total };
  }
  return { status: ORCHESTRATOR_BATCH_STATUS.PROCESSING, successful, failed, unfinished, total };
}

/** Terminal for occurrence claim â FAILED_RETRYABLE / PROVIDER_ACCEPTED must allow cron re-entry. */
export function isOrchestratorItemTerminalForOccurrence(
  status: string | null | undefined,
): boolean {
  const st = String(status ?? "").toUpperCase();
  return (
    st === ORCHESTRATOR_ITEM_STATUS.COMPLETED
    || st === ORCHESTRATOR_ITEM_STATUS.FAILED_PERMANENT
    || st === ORCHESTRATOR_ITEM_STATUS.RESERVATION_RELEASED
  );
}

/**
 * Item already entered provider submission â later ticks must poll/finalize only.
 * Never re-reserve or call /pay again (includes UNKNOWN timeout-after-possible-accept).
 */
export function isOrchestratorReconcileOnlyItemStatus(
  status: string | null | undefined,
): boolean {
  const st = String(status ?? "").toUpperCase();
  return (
    st === "SUBMITTED"
    || st === "SUBMITTING"
    || st === "SENT"
    || st === "TRANSFER_CREATED"
    || st === "PROCESSING"
    || st === "UNKNOWN"
    || st === ORCHESTRATOR_ITEM_STATUS.PROVIDER_ACCEPTED
    || st === ORCHESTRATOR_ITEM_STATUS.SUBMITTING
  );
}

/** Claim failures that must keep the reservation (no blind retry / no release). */
export function shouldReleaseReservationOnSubmitClaimFailure(
  errorCode: string | null | undefined,
): boolean {
  const code = String(errorCode ?? "").toUpperCase();
  if (!code) return true;
  if (code === "ALREADY_SUBMITTED") return false;
  if (code === "SUBMISSION_IN_FLIGHT") return false;
  if (code === "UNKNOWN_NO_BLIND_RETRY") return false;
  if (code.includes("UNKNOWN")) return false;
  return true;
}

/** Item still needs money-path work (reserve/submit/poll/finalize) — not occurrence-terminal. */
export function isOrchestratorInFlightItemStatus(
  status: string | null | undefined,
  executionStatus?: string | null,
): boolean {
  if (executionStatus !== undefined) {
    return isConflictingActivePayoutItem({
      status,
      execution_status: executionStatus,
    });
  }
  // Legacy single-token probe (caller already coalesced). Terminal tokens are not in-flight.
  return isConflictingActivePayoutItem({
    status,
    execution_status: null,
  });
}

/**
 * Continue LIVE money path when either fresh eligible drivers exist OR the
 * occurrence batch already has in-flight items (reserved/submitted/unknown).
 * Prevents ZERO_ELIGIBLE after reservation from abandoning provider reconciliation.
 * In-flight SUBMITTED pays already reduced settled funds — INSUFFICIENT_SETTLED_FUNDS
 * must not block GET-only reconcile of the existing provider reference.
 */
export function shouldContinueOrchestratorMoneyPath(args: {
  dry_run: boolean;
  live_enabled: boolean;
  transport_enabled: boolean;
  has_batch: boolean;
  fresh_eligible_count: number;
  in_flight_item_count: number;
  blocker_code: string | null | undefined;
  /** Items the running funding allowance can cover; a batch-wide shortfall must not block them. */
  fundable_item_count?: number;
}): { continue: boolean; reconciling_in_flight: boolean; ignore_zero_eligible_blocker: boolean } {
  const reconciling_in_flight = args.in_flight_item_count > 0;
  const partially_fundable = (args.fundable_item_count ?? 0) > 0
    && args.blocker_code === "INSUFFICIENT_SETTLED_FUNDS";
  const ignore_zero_eligible_blocker = partially_fundable || (reconciling_in_flight
    && (
      args.blocker_code == null
      || args.blocker_code === "ZERO_ELIGIBLE_DRIVERS"
      || args.blocker_code === "INSUFFICIENT_SETTLED_FUNDS"
    ));
  const blockerBlocks = args.blocker_code != null && !ignore_zero_eligible_blocker;
  const continuePath = !args.dry_run
    && args.live_enabled
    && args.transport_enabled
    && args.has_batch
    && !blockerBlocks
    && (args.fresh_eligible_count > 0 || args.in_flight_item_count > 0);
  return {
    continue: continuePath,
    reconciling_in_flight,
    ignore_zero_eligible_blocker,
  };
}

/**
 * Finish run only when every item is occurrence-terminal.
 * Pending provider / retryable failures stay RUNNING with money_path_executed=false
 * so later cron ticks reconcile without duplicating pays.
 */
export function resolveOrchestratorRunFinish(args: {
  item_statuses: ReadonlyArray<string>;
  any_pay_called: boolean;
  any_debited: boolean;
}): {
  run_status: (typeof ORCHESTRATOR_RUN_STATUS)[keyof typeof ORCHESTRATOR_RUN_STATUS];
  money_path_executed: boolean;
  batch_aggregate: ReturnType<typeof aggregateOrchestratorBatchStatus>;
} {
  const batch_aggregate = aggregateOrchestratorBatchStatus(
    args.item_statuses.map((status) => ({ status })),
  );
  const allTerminal = args.item_statuses.length > 0
    && args.item_statuses.every(isOrchestratorItemTerminalForOccurrence);
  if (!allTerminal) {
    return {
      run_status: ORCHESTRATOR_RUN_STATUS.RUNNING,
      money_path_executed: false,
      batch_aggregate,
    };
  }
  const run_status = batch_aggregate.status === ORCHESTRATOR_BATCH_STATUS.FAILED
    ? ORCHESTRATOR_RUN_STATUS.FAILED
    : ORCHESTRATOR_RUN_STATUS.COMPLETED;
  return {
    run_status,
    money_path_executed: args.any_pay_called || args.any_debited
      || batch_aggregate.failed === batch_aggregate.total,
    batch_aggregate,
  };
}

export type EarlierOccurrenceRunItem = {
  status: string | null | undefined;
  execution_status: string | null | undefined;
  open_intent_count: number;
  active_reservation_count: number;
};

const FINAL_INTENT_EXECUTION_STATUSES = new Set(["COMPLETED", "FAILED", "DECLINED", "REVERTED", "CANCELLED"]);
const FINAL_RESERVATION_STATUSES = new Set(["RELEASED", "CANCELLED", "FAILED", "CONSUMED"]);

/** A cancelled item must never have reached the provider: any intent at all blocks closing. */
export function countBlockingIntentsForEarlierRun(
  itemStatus: string | null | undefined,
  intentExecutionStatuses: ReadonlyArray<string | null | undefined>,
): number {
  if (String(itemStatus ?? "").toUpperCase() === "CANCELLED") return intentExecutionStatuses.length;
  return intentExecutionStatuses.filter((s) => !FINAL_INTENT_EXECUTION_STATUSES.has(String(s ?? "").toUpperCase()))
    .length;
}

export function countActiveReservationsForEarlierRun(
  reservationStatuses: ReadonlyArray<string | null | undefined>,
): number {
  return reservationStatuses.filter((s) => !FINAL_RESERVATION_STATUSES.has(String(s ?? "").toUpperCase())).length;
}

/**
 * An earlier occurrence run is only revisited by its own claim, which later ticks never
 * repeat. Close it once every item is settled: COMPLETED, or CANCELLED before any
 * provider intent or live reservation existed. Anything else stays RUNNING for review.
 */
export function resolveEarlierOccurrenceRunClose(items: ReadonlyArray<EarlierOccurrenceRunItem>): {
  close: boolean;
  run_status: (typeof ORCHESTRATOR_RUN_STATUS)[keyof typeof ORCHESTRATOR_RUN_STATUS];
  money_path_executed: boolean;
  completed: number;
  cancelled: number;
  reason: string;
} {
  let completed = 0;
  let cancelled = 0;
  const keepRunning = (reason: string) => ({
    close: false,
    run_status: ORCHESTRATOR_RUN_STATUS.RUNNING,
    money_path_executed: false,
    completed,
    cancelled,
    reason,
  });
  if (items.length === 0) return keepRunning("NO_ITEMS");
  for (const item of items) {
    const st = String(item.status ?? "").toUpperCase();
    const ex = String(item.execution_status ?? "").toUpperCase();
    if (item.open_intent_count > 0 || item.active_reservation_count > 0) {
      return keepRunning("ITEM_HAS_OPEN_INTENT_OR_RESERVATION");
    }
    if (st === "COMPLETED" && (ex === "" || ex === "COMPLETED")) {
      completed += 1;
    } else if (st === "CANCELLED" && (ex === "" || ex === "CANCELLED")) {
      cancelled += 1;
    } else {
      return keepRunning(`ITEM_NOT_SETTLED:${st || "UNKNOWN"}`);
    }
  }
  return {
    close: true,
    run_status: ORCHESTRATOR_RUN_STATUS.COMPLETED,
    money_path_executed: completed > 0,
    completed,
    cancelled,
    reason: "ALL_ITEMS_SETTLED",
  };
}

export type PlannedOrchestratorItem = {
  driver_id: string;
  driver_name: string | null;
  amount_pence: number;
  payout_destination_id: string | null;
  provider_counterparty_id: string | null;
  provider_recipient_account_id: string | null;
  status: OrchestratorItemStatus;
  destination_verified: boolean;
  idempotency_reserve_key: string;
  idempotency_submit_key: string;
  provider_request_id: string;
};

export type OrchestratorPlanSnapshot = {
  schedule_occurrence_key: string;
  required_batch_pence: number;
  eligible_driver_count: number;
  items: PlannedOrchestratorItem[];
  funding: ReturnType<typeof evaluateBatchFundingGate>;
  money_path_allowed: boolean;
  blocker_code: OrchestratorBlockerCode | null;
  blocker_label: string | null;
  revolut_pay_would_occur: boolean;
  wallet_debit_would_occur: boolean;
};

/**
 * Pure planning verdict after eligibility + funding + flag gates.
 * Does not move money.
 */
export function buildOrchestratorPlanSnapshot(args: {
  schedule_occurrence_key: string;
  items: Array<{
    driver_id: string;
    driver_name?: string | null;
    amount_pence: number;
    payout_item_id?: string | null;
    payout_destination_id?: string | null;
    provider_counterparty_id?: string | null;
    provider_recipient_account_id?: string | null;
    destination_verified: boolean;
  }>;
  available_pence: number | null | undefined;
  live_enabled: boolean;
  transport_enabled: boolean;
  dry_run?: boolean;
}): OrchestratorPlanSnapshot {
  const planned: PlannedOrchestratorItem[] = args.items.map((item) => {
    const itemId = item.payout_item_id ?? `pending:${item.driver_id}`;
    return {
      driver_id: item.driver_id,
      driver_name: item.driver_name ?? null,
      amount_pence: Math.max(0, Math.round(item.amount_pence)),
      payout_destination_id: item.payout_destination_id ?? null,
      provider_counterparty_id: item.provider_counterparty_id ?? null,
      provider_recipient_account_id: item.provider_recipient_account_id ?? null,
      status: ORCHESTRATOR_ITEM_STATUS.ELIGIBLE,
      destination_verified: item.destination_verified === true,
      idempotency_reserve_key: orchestratorIdempotencyKey({
        occurrence_key: args.schedule_occurrence_key,
        driver_id: item.driver_id,
        payout_item_id: itemId,
        purpose: "reserve",
      }),
      idempotency_submit_key: orchestratorIdempotencyKey({
        occurrence_key: args.schedule_occurrence_key,
        driver_id: item.driver_id,
        payout_item_id: itemId,
        purpose: "submit",
      }),
      provider_request_id: orchestratorProviderRequestId({ payout_item_id: itemId }),
    };
  });

  const required = planned.reduce((s, p) => s + p.amount_pence, 0);
  const funding = evaluateBatchFundingGate({
    required_batch_pence: required,
    available_pence: args.available_pence,
  });

  let blocker: OrchestratorBlockerCode | null = null;
  if (planned.length === 0) blocker = ORCHESTRATOR_BLOCKER.ZERO_ELIGIBLE_DRIVERS;
  else if (planned.some((p) => !p.destination_verified)) {
    blocker = ORCHESTRATOR_BLOCKER.RECIPIENT_VERIFICATION_MISSING;
  } else if (funding.blocker_code) blocker = funding.blocker_code;
  else if (!args.live_enabled) blocker = ORCHESTRATOR_BLOCKER.LIVE_PAYOUT_ROLLOUT_DISABLED;
  else if (!args.transport_enabled) blocker = ORCHESTRATOR_BLOCKER.PAYMENT_TRANSPORT_DISABLED;

  const moneyOk =
    !args.dry_run
    && args.live_enabled
    && args.transport_enabled
    && blocker == null;

  return {
    schedule_occurrence_key: args.schedule_occurrence_key,
    required_batch_pence: required,
    eligible_driver_count: planned.length,
    items: planned,
    funding,
    money_path_allowed: moneyOk,
    blocker_code: blocker,
    blocker_label: blocker ? orchestratorBlockerLabel(blocker) : null,
    revolut_pay_would_occur: moneyOk,
    wallet_debit_would_occur: moneyOk,
  };
}

/** Admin pre-run summary copy helpers. */
export function formatOrchestratorScheduleSummary(args: {
  scheduled_local_label: string;
  eligible_driver_count: number;
  required_batch_pence: number;
  funding_result: FundingResult;
}): {
  headline: string;
  expected_drivers_label: string;
  expected_amount_pence: number;
  funding_label: string;
} {
  return {
    headline: `Scheduled for ${args.scheduled_local_label}`,
    expected_drivers_label: `Expected drivers: ${args.eligible_driver_count}`,
    expected_amount_pence: args.required_batch_pence,
    funding_label: args.funding_result === FUNDING_RESULT.SUFFICIENT
      ? "Funding: Ready"
      : args.funding_result === FUNDING_RESULT.INSUFFICIENT
      ? "Funding: Insufficient"
      : "Funding: Unavailable",
  };
}
