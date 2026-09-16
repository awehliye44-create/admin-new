/**
 * Testable POST money-path orchestration for driver-withdraw.
 * Production index wires the same helpers; tests inject mocks for reserve/provider.
 */
import {
  assertClientAmountWithinWithdrawable,
  buildDriverPayoutWithdrawalQuote,
  DRIVER_WITHDRAW_QUOTE_VERSION,
  type DriverPayoutWithdrawalQuote,
} from "./driverPayoutWithdrawalQuoteSSOT.ts";
import {
  DRIVER_WITHDRAW_CLIENT_SERVICE_AREA_REJECTED,
  DRIVER_WITHDRAW_DRIVER_COLLECTED_REJECTED,
  DRIVER_WITHDRAW_SERVICE_AREA_MISSING,
  DRIVER_WITHDRAW_SERVICE_AREA_MISMATCH,
  rejectClientServiceAreaOverride,
  resolveAuthoritativeWithdrawServiceArea,
  type DriverWithdrawDiag,
  type DriverWithdrawPostStage,
  buildDriverWithdrawDiag,
  hashIdempotencyKeyForDiagnostics,
} from "./driverWithdrawPostScopeSSOT.ts";

export type WithdrawDest = {
  id: string;
  last4: string | null;
  provider_link_status: string;
  provider_counterparty_id: string | null;
  provider_recipient_account_id: string | null;
};

export type WithdrawOrchestrationPorts = {
  reserve: (args: {
    payout_item_id: string;
    service_area_id: string;
    amount_pence: number;
    net_pence: number;
  }) => Promise<{ ok: true } | { ok: false; code: string }>;
  providerPay: (args: {
    payout_item_id: string;
    amount_pence: number;
    service_area_id: string;
    destination_last4: string | null;
  }) => Promise<{ ok: true; provider_payment_id: string } | { ok: false; code: string }>;
  createPayoutItem: (args: {
    service_area_id: string;
    amount_pence: number;
    net_pence: number;
    fee_pence: number;
    destination_id: string;
    idempotency_key: string;
  }) => Promise<
    | { ok: true; payout_item_id: string; already_provider_submitted?: boolean }
    | { ok: false; code: string }
  >;
};

export type WithdrawOrchestrationInput = {
  request_id: string;
  driver_id: string;
  body: Record<string, unknown>;
  idempotency_key: string;
  quote: DriverPayoutWithdrawalQuote;
  summary_service_area_id: unknown;
  driver_primary_service_area_id: unknown;
  driver_membership_service_area_ids: readonly unknown[];
  financial_model: unknown;
  destination: WithdrawDest | null;
  ports: WithdrawOrchestrationPorts;
};

export type WithdrawOrchestrationResult =
  | {
    ok: true;
    stage: DriverWithdrawPostStage;
    service_area_id: string;
    gross_pence: number;
    fee_pence: number;
    net_pence: number;
    destination_last4: string | null;
    payout_item_id: string;
    provider_payment_id: string | null;
    provider_calls: number;
    reservation_ok: true;
    diag: DriverWithdrawDiag;
  }
  | {
    ok: false;
    stage: DriverWithdrawPostStage;
    error_code: string;
    driver_message: string;
    http_status: number;
    provider_calls: number;
    reservation_attempted: boolean;
    diag: DriverWithdrawDiag;
  };

function baseDiag(input: WithdrawOrchestrationInput, stage: DriverWithdrawPostStage): DriverWithdrawDiag {
  return buildDriverWithdrawDiag({
    request_id: input.request_id,
    idempotency_key_hash: hashIdempotencyKeyForDiagnostics(input.idempotency_key),
    driver_id: input.driver_id,
    stage,
    quote_version: DRIVER_WITHDRAW_QUOTE_VERSION,
    gross_pence: input.quote.withdrawable_pence,
    fee_pence: input.quote.fee_pence,
    net_pence: input.quote.net_payout_pence,
  });
}

/**
 * Authenticated POST orchestration from rebuilt quote through mocked
 * reservation + provider boundary. No out-of-scope summary locals.
 */
export async function runDriverWithdrawPostOrchestration(
  input: WithdrawOrchestrationInput,
): Promise<WithdrawOrchestrationResult> {
  let providerCalls = 0;
  let reservationAttempted = false;
  let stage: DriverWithdrawPostStage = "quote_rebuilt";
  let diag = baseDiag(input, stage);

  const clientSa = rejectClientServiceAreaOverride(input.body);
  if (!clientSa.ok) {
    stage = "failed_closed";
    diag = { ...diag, stage, error_code: clientSa.code, final_status: "rejected" };
    return {
      ok: false,
      stage,
      error_code: clientSa.code,
      driver_message: clientSa.copy,
      http_status: 403,
      provider_calls: 0,
      reservation_attempted: false,
      diag,
    };
  }

  const sa = resolveAuthoritativeWithdrawServiceArea({
    summary_service_area_id: input.summary_service_area_id,
    driver_primary_service_area_id: input.driver_primary_service_area_id,
    driver_membership_service_area_ids: input.driver_membership_service_area_ids,
    financial_model: input.financial_model,
  });
  if (!sa.ok) {
    stage = "failed_closed";
    diag = { ...diag, stage, error_code: sa.code, final_status: "rejected" };
    return {
      ok: false,
      stage,
      error_code: sa.code,
      driver_message: sa.copy,
      http_status: sa.code === DRIVER_WITHDRAW_SERVICE_AREA_MISSING ? 409 : 403,
      provider_calls: 0,
      reservation_attempted: false,
      diag,
    };
  }
  stage = "service_area_resolved";
  diag = { ...diag, stage, service_area_id: sa.service_area_id };

  const clientRequested = input.body.amount_pence ?? input.body.requested_cashout_pence ?? null;
  const clientCheck = assertClientAmountWithinWithdrawable({
    client_requested_pence: clientRequested == null ? null : Number(clientRequested),
    quote: input.quote,
  });
  if (!clientCheck.ok) {
    stage = "failed_closed";
    diag = { ...diag, stage, error_code: clientCheck.code, final_status: "rejected" };
    return {
      ok: false,
      stage,
      error_code: clientCheck.code,
      driver_message: clientCheck.copy,
      http_status: 409,
      provider_calls: 0,
      reservation_attempted: false,
      diag,
    };
  }

  if (!input.quote.payout_allowed || input.quote.withdrawable_pence <= 0) {
    const code = input.quote.blocking_reason_code ?? "NO_AVAILABLE_BALANCE";
    stage = "failed_closed";
    diag = { ...diag, stage, error_code: code, final_status: "rejected" };
    return {
      ok: false,
      stage,
      error_code: code,
      driver_message: input.quote.blocking_reason_copy ?? "Withdrawals are not available right now.",
      http_status: 409,
      provider_calls: 0,
      reservation_attempted: false,
      diag,
    };
  }
  stage = "amount_validated";
  diag = { ...diag, stage };

  const dest = input.destination;
  if (
    !dest?.id
    || String(dest.provider_link_status ?? "").toUpperCase() !== "PROVIDER_VERIFIED"
    || !dest.provider_counterparty_id
    || !dest.provider_recipient_account_id
  ) {
    stage = "failed_closed";
    diag = { ...diag, stage, error_code: "PAYOUT_ACCOUNT_NOT_VERIFIED", final_status: "rejected" };
    return {
      ok: false,
      stage,
      error_code: "PAYOUT_ACCOUNT_NOT_VERIFIED",
      driver_message: "Add a verified payout account before withdrawing.",
      http_status: 409,
      provider_calls: 0,
      reservation_attempted: false,
      diag,
    };
  }
  stage = "destination_validated";
  diag = { ...diag, stage };

  const gross = input.quote.withdrawable_pence;
  const fee = input.quote.fee_pence;
  const net = input.quote.net_payout_pence;

  const created = await input.ports.createPayoutItem({
    service_area_id: sa.service_area_id,
    amount_pence: gross,
    net_pence: net,
    fee_pence: fee,
    destination_id: dest.id,
    idempotency_key: input.idempotency_key,
  });
  if (!created.ok) {
    stage = "failed_closed";
    diag = { ...diag, stage, error_code: created.code, final_status: "rejected" };
    return {
      ok: false,
      stage,
      error_code: created.code,
      driver_message: "Could not create withdrawal item.",
      http_status: 500,
      provider_calls: 0,
      reservation_attempted: false,
      diag,
    };
  }

  // Idempotent reuse of an already-submitted item — do not call provider again.
  if (created.already_provider_submitted) {
    stage = "finalized";
    diag = {
      ...diag,
      stage,
      reservation_ok: true,
      provider_boundary_reached: false,
      final_status: "SUBMITTED",
    };
    return {
      ok: true,
      stage,
      service_area_id: sa.service_area_id,
      gross_pence: gross,
      fee_pence: fee,
      net_pence: net,
      destination_last4: dest.last4,
      payout_item_id: created.payout_item_id,
      provider_payment_id: null,
      provider_calls: 0,
      reservation_ok: true,
      diag,
    };
  }

  reservationAttempted = true;
  stage = "reservation";
  const reserved = await input.ports.reserve({
    payout_item_id: created.payout_item_id,
    service_area_id: sa.service_area_id,
    amount_pence: gross,
    net_pence: net,
  });
  if (!reserved.ok) {
    stage = "failed_closed";
    diag = {
      ...diag,
      stage,
      reservation_ok: false,
      error_code: reserved.code,
      final_status: "rejected",
      provider_boundary_reached: false,
    };
    return {
      ok: false,
      stage,
      error_code: reserved.code,
      driver_message: "Could not reserve withdrawal funds.",
      http_status: 409,
      provider_calls: 0,
      reservation_attempted: true,
      diag,
    };
  }
  diag = { ...diag, reservation_ok: true };

  stage = "provider_boundary";
  providerCalls += 1;
  const paid = await input.ports.providerPay({
    payout_item_id: created.payout_item_id,
    amount_pence: net,
    service_area_id: sa.service_area_id,
    destination_last4: dest.last4,
  });
  if (!paid.ok) {
    stage = "failed_closed";
    diag = {
      ...diag,
      stage,
      provider_boundary_reached: true,
      error_code: paid.code,
      final_status: "provider_rejected",
    };
    return {
      ok: false,
      stage,
      error_code: paid.code,
      driver_message: "Provider rejected the withdrawal.",
      http_status: 422,
      provider_calls: providerCalls,
      reservation_attempted: true,
      diag,
    };
  }

  stage = "finalized";
  diag = {
    ...diag,
    stage,
    provider_boundary_reached: true,
    final_status: "SUBMITTED",
    error_code: null,
  };
  return {
    ok: true,
    stage,
    service_area_id: sa.service_area_id,
    gross_pence: gross,
    fee_pence: fee,
    net_pence: net,
    destination_last4: dest.last4,
    payout_item_id: created.payout_item_id,
    provider_payment_id: paid.provider_payment_id,
    provider_calls: providerCalls,
    reservation_ok: true,
    diag,
  };
}

/** Re-export quote builder for tests that need STAGE_C2 shapes without Edge. */
export { buildDriverPayoutWithdrawalQuote, DRIVER_WITHDRAW_QUOTE_VERSION };
export {
  DRIVER_WITHDRAW_CLIENT_SERVICE_AREA_REJECTED,
  DRIVER_WITHDRAW_DRIVER_COLLECTED_REJECTED,
  DRIVER_WITHDRAW_SERVICE_AREA_MISSING,
  DRIVER_WITHDRAW_SERVICE_AREA_MISMATCH,
};
