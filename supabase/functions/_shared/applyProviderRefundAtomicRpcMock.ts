/**
 * Test harness simulating apply_confirmed_provider_refund_atomic semantics.
 * Used when PostgreSQL is unavailable — mirrors migration RPC formula.
 */
import {
  applyRefundToTripAmounts,
  resolveRefundStatus,
  resolveTripPaymentStatusFromRefund,
} from "./providerRefundSSOT.ts";
import { PAYMENT_SESSION_PURPOSE_RIDE_BOOKING } from "./paymentSessionCaptureGateSSOT.ts";

export type AtomicRpcMockState = {
  refundChildren: Array<Record<string, unknown>>;
  ledgerRows: Array<Record<string, unknown>>;
  psBook: Record<string, unknown>;
  psRecovery: Record<string, unknown>;
  tripRow: Record<string, unknown>;
  rideBookingSessionCount: number;
  historicalNullDebit: boolean;
  rpcCalls: number;
  providerRefundCreates: number;
  failNextRpc: boolean;
  failRpcCount: number;
};

export function createAtomicRpcMockState(overrides?: Partial<AtomicRpcMockState>): AtomicRpcMockState {
  return {
    refundChildren: [],
    ledgerRows: [],
    psBook: {
      id: "ps-book",
      trip_id: "trip-1",
      purpose: PAYMENT_SESSION_PURPOSE_RIDE_BOOKING,
      captured_amount_pence: 1250,
      refunded_amount_pence: 0,
      payment_provider: "revolut",
      provider_order_id: "order-1",
      currency: "gbp",
    },
    psRecovery: {
      id: "ps-recovery",
      trip_id: "trip-1",
      purpose: "PAYMENT_RECOVERY",
      captured_amount_pence: 100,
      refunded_amount_pence: 0,
    },
    tripRow: {
      id: "trip-1",
      driver_id: "driver-1",
      financial_model: "PLATFORM_COLLECTED",
      capture_amount_pence: 1250,
      final_fare_pence: 1250,
      final_customer_fare_pence: 1250,
      commission_pence: 250,
      driver_net_pence: 1000,
      payment_status: "captured",
      refund_amount_pence: 0,
    },
    rideBookingSessionCount: 1,
    historicalNullDebit: false,
    rpcCalls: 0,
    providerRefundCreates: 0,
    failNextRpc: false,
    failRpcCount: 0,
    ...overrides,
  };
}

function authoritativeDebitSum(state: AtomicRpcMockState): number {
  return state.ledgerRows
    .filter((r) =>
      r.type === "REFUND_DEBIT"
      && r.related_trip_id === state.tripRow.id
      && r.provider_refund_id != null
    )
    .reduce((sum, r) => sum + Math.abs(Number(r.amount_pence ?? 0)), 0);
}

function creditedPence(state: AtomicRpcMockState): number {
  return state.ledgerRows
    .filter((r) =>
      r.driver_id === state.tripRow.driver_id
      && r.related_trip_id === state.tripRow.id
      && (r.type === "TRIP_EARNING_NET" || r.type === "DRIVER_TIP_CREDIT")
    )
    .reduce((sum, r) => sum + Math.max(0, Number(r.amount_pence ?? 0)), 0);
}

export function simulateAtomicRpc(
  state: AtomicRpcMockState,
  params: Record<string, unknown>,
): Record<string, unknown> {
  state.rpcCalls += 1;
  if (state.failNextRpc) {
    state.failNextRpc = false;
    state.failRpcCount += 1;
    throw new Error("simulated_rpc_failure");
  }

  if (state.historicalNullDebit) {
    throw new Error("HISTORICAL_REFUND_DEBIT_REQUIRES_MANUAL_RECONCILIATION");
  }

  if (state.rideBookingSessionCount === 0) {
    throw new Error("PAYMENT_SESSION_MISSING");
  }
  if (state.rideBookingSessionCount > 1) {
    throw new Error("CAPTURE_AMBIGUOUS");
  }

  const provider = String(params.p_payment_provider ?? "revolut");
  const providerRefundId = String(params.p_provider_refund_id ?? "").trim();
  const eventPence = Math.round(Number(params.p_event_refund_amount_pence ?? 0));
  const cumulative = Math.round(Number(params.p_cumulative_refunded_pence ?? 0));
  const skipWallet = params.p_skip_driver_wallet_reversal === true;

  const existingChild = state.refundChildren.find((r) =>
    r.payment_provider === provider && r.provider_refund_id === providerRefundId);
  const existingDebit = state.ledgerRows.find((r) =>
    r.payment_provider === provider
    && r.provider_refund_id === providerRefundId
    && r.type === "REFUND_DEBIT");

  if (existingChild && existingDebit) {
    return {
      status: "already_applied",
      trip_id: state.tripRow.id,
      payment_session_id: state.psBook.id,
      provider_refund_id: providerRefundId,
      refund_child_id: existingChild.id,
      ledger_debit_id: existingDebit.id,
      cumulative_refunded_pence: cumulative,
    };
  }

  if (!existingChild) {
    state.refundChildren.push({
      id: `child-${state.refundChildren.length + 1}`,
      payment_session_id: state.psBook.id,
      payment_provider: provider,
      provider_refund_id: providerRefundId,
      amount_pence: eventPence,
    });
  }

  const childSum = state.refundChildren
    .filter((r) => r.payment_session_id === state.psBook.id)
    .reduce((sum, r) => sum + Number(r.amount_pence ?? 0), 0);

  if (childSum !== cumulative) {
    throw new Error(`cumulative_refund_mismatch: expected ${cumulative} got ${childSum}`);
  }

  state.psBook.refunded_amount_pence = childSum;
  state.tripRow.refund_amount_pence = cumulative;
  state.tripRow.payment_status = resolveTripPaymentStatusFromRefund(
    Number(state.tripRow.capture_amount_pence),
    cumulative,
  );

  const captured = Number(state.tripRow.capture_amount_pence ?? 0);
  const adjusted = applyRefundToTripAmounts({
    capturedPence: captured,
    refundPence: cumulative,
    commissionPence: Number(state.tripRow.commission_pence ?? 0),
    driverNetPence: Number(state.tripRow.driver_net_pence ?? 0),
  });

  const priorDebitSum = authoritativeDebitSum(state);
  let missing = Math.max(0, adjusted.driver_reversal_pence - priorDebitSum);
  let inserted = 0;
  let ledgerId: string | null = existingDebit ? String(existingDebit.id) : null;

  if (missing > 0 && !skipWallet && !existingDebit) {
    const credit = creditedPence(state);
    inserted = credit > 0
      ? Math.min(Math.max(0, credit - priorDebitSum), missing)
      : missing;
    if (inserted > 0) {
      ledgerId = `ledger-${state.ledgerRows.length + 1}`;
      state.ledgerRows.push({
        id: ledgerId,
        driver_id: state.tripRow.driver_id,
        related_trip_id: state.tripRow.id,
        type: "REFUND_DEBIT",
        amount_pence: -inserted,
        payment_provider: provider,
        provider_refund_id: providerRefundId,
        description: `provider refund reversal (${providerRefundId}) — ${params.p_source ?? "admin_refund"}`,
      });
    }
  }

  const refundStatus = resolveRefundStatus(captured, cumulative);

  return {
    status: "applied",
    trip_id: state.tripRow.id,
    payment_session_id: state.psBook.id,
    provider_refund_id: providerRefundId,
    refund_child_id: existingChild?.id ?? state.refundChildren.at(-1)?.id,
    ledger_debit_id: ledgerId,
    cumulative_refunded_pence: cumulative,
    target_driver_reversal_pence: adjusted.driver_reversal_pence,
    authoritative_debit_sum_pence: priorDebitSum + inserted,
    inserted_debit_pence: inserted,
    payment_status: state.tripRow.payment_status,
    refund_status: refundStatus,
  };
}

export function buildClientWithAtomicRpcMock(state: AtomicRpcMockState) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq(col: string, val: unknown) { filters[col] = val; return chain; },
        order() { return chain; },
        in() { return chain; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => {
          if (table === "trips" && filters.id === state.tripRow.id) {
            return { data: { ...state.tripRow }, error: null };
          }
          return { data: null, error: { message: "not found" } };
        },
        update(payload: Record<string, unknown>) {
          const upd = {
            eq() { return upd; },
            then(resolve: (v: { error: null }) => unknown) {
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          if (table === "trips") Object.assign(state.tripRow, payload);
          return upd;
        },
        insert() { return Promise.resolve({ error: null }); },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return chain;
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name === "log_audit_event") return { data: null, error: null };
      if (name === "apply_confirmed_provider_refund_atomic") {
        try {
          return { data: simulateAtomicRpc(state, params), error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      }
      return { data: null, error: null };
    },
  };
}

export function seedTripEarning(state: AtomicRpcMockState, amountPence: number) {
  state.ledgerRows.push({
    id: "earn-1",
    driver_id: state.tripRow.driver_id,
    related_trip_id: state.tripRow.id,
    type: "TRIP_EARNING_NET",
    amount_pence: amountPence,
  });
}
