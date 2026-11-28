import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(), retrieve: vi.fn(), snapshot: vi.fn(), claim: vi.fn(),
  dispatched: vi.fn(), complete: vi.fn(), sessionClaim: vi.fn(),
  increment: vi.fn(), settlement: vi.fn(), sessionCaptured: vi.fn(), shortfall: vi.fn(),
}));
vi.mock("../../functions/_shared/revolutOrders.ts", () => ({
  captureRevolutOrder: mocks.capture,
  retrieveRevolutOrder: mocks.retrieve,
  revolutProviderAuthorisedTotalPence: () => 788,
}));
vi.mock("../../functions/_shared/paymentSsotCutoverSSOT.ts", () => ({
  loadPaymentSsotCutoverConfig: async () => ({ stage: "D", require_financial_op_claim: true }),
}));
vi.mock("../../functions/_shared/paymentFinancialOperationPersistSSOT.ts", () => ({
  loadLatestPayableSnapshot: mocks.snapshot,
  claimFinancialOperationForPost: mocks.claim,
  markFinancialOperationPostDispatched: mocks.dispatched,
  completeFinancialOperationFromProvider: mocks.complete,
  persistPayableFareSnapshot: vi.fn(async () => ({ id: "snapshot", version: 7 })),
}));
vi.mock("../../functions/_shared/paymentFinancialDiagnosticsSSOT.ts", () => ({
  recordPaymentFinancialEvent: vi.fn(async () => undefined),
}));
vi.mock("../../functions/_shared/paymentSessionFinancialLockSSOT.ts", () => ({
  claimPaymentSessionFinancialLock: mocks.sessionClaim,
  releasePaymentSessionFinancialLock: vi.fn(async () => undefined),
  readPaymentSessionFinancialLock: () => ({ state: "CAPTURING", owner: "completion" }),
  reclaimExpiredPaymentSessionFinancialLock: vi.fn(async () => undefined),
}));
vi.mock("../../functions/_shared/revolutMerchantContext.ts", () => ({
  resolveRevolutMerchantContext: async () => ({ environment: "sandbox", secretKey: "unused-mocked-provider" }),
}));
vi.mock("../../functions/_shared/executeSameOrderIncrementSSOT.ts", () => ({ executeSameOrderIncrement: mocks.increment }));
vi.mock("../../functions/_shared/executeFareIncreaseModificationPayment.ts", () => ({
  assertPlatformCollectedCompletionPaymentGate: async () => ({ ok: true }),
  CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED: "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED",
}));
vi.mock("../../functions/_shared/reconcilePendingIncrementAuthorisationSSOT.ts", () => ({
  reconcilePendingIncrementAuthorisationsFromProvider: async () => ({ results: [] }),
}));
vi.mock("../../functions/_shared/reconcileFinancialOperationFromEvidenceSSOT.ts", () => ({
  reconcileIncrementOperationsToCoverConfirmed: vi.fn(),
}));
vi.mock("../../functions/_shared/captureCompositionAcquireSSOT.ts", () => ({
  acquireLockAndResolveCaptureComposition: vi.fn(),
  failClosedWithoutSessionWhenReceivableEvidence: () => null,
}));
vi.mock("../../functions/_shared/applyCanonicalSettlementAfterCapture.ts", () => ({ applyCanonicalSettlementAfterCapture: mocks.settlement }));
vi.mock("../../functions/_shared/paymentSessionSSOT.ts", () => ({
  loadPaymentSession: vi.fn(), markPaymentSessionCaptured: mocks.sessionCaptured,
  markPaymentSessionCompletedPendingCapture: vi.fn(async () => undefined),
  safePersistCaptureResidualReleaseEvidence: vi.fn(async () => null),
}));
vi.mock("../../functions/_shared/shortfallReceivableSafety.ts", () => ({
  recordShortfallAfterConfirmedMarker: mocks.shortfall,
  ensureShortfallReceivableOrException: vi.fn(), isWithinReceivablesLedger: vi.fn(), shortfallPenceFromSessionMarker: vi.fn(),
}));
vi.mock("../../functions/_shared/walletPostingMismatchSSOT.ts", () => ({ recordPaymentSessionPersistFailureMetadata: vi.fn() }));
vi.mock("../../functions/_shared/terminalizeAbandonedModificationSSOT.ts", () => ({ terminalizeAbandonedTripChangeRequests: vi.fn(async () => undefined) }));

import { guardedCaptureRevolutOrder } from "../../functions/_shared/guardedProviderCaptureSSOT";
import { safeCaptureAfterIncrementDecline } from "../../functions/_shared/paymentRecoveryGuardSSOT";
import { buildAuthoritativePayableFromTrip } from "../../functions/_shared/writeAuthoritativePayableSnapshotSSOT";
import { computeCaptureAmount } from "../../functions/_shared/tripFareSSOT";
import { executeRevolutTripCompletionCapture } from "../../functions/_shared/revolutCompletionCapture";

const captureArgs = {
  supabase: {} as Parameters<typeof guardedCaptureRevolutOrder>[0]["supabase"],
  environment: "sandbox" as const,
  secretKey: "unused-mocked-provider",
  tripId: "trip", paymentSessionId: "session", providerOrderId: "order",
  purpose: "fare" as const,
};

describe("completion top-up decline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshot.mockResolvedValue({ id: "snapshot", version: 7, total_payable_pence: 875, currency: "GBP" });
    mocks.claim.mockResolvedValue({ ok: true, operationId: "op", fence: "fence", executionId: "exec" });
    mocks.complete.mockResolvedValue(undefined);
    mocks.sessionClaim.mockResolvedValue({ ok: true, owner: "completion" });
    mocks.retrieve.mockResolvedValue({ id: "order", state: "COMPLETED", completed_amount: 788, currency: "GBP" });
  });

  it("collects the 788p confirmed hold against the unchanged 875p payable and retains 87p shortfall", async () => {
    const safe = safeCaptureAfterIncrementDecline({ finalFarePence: 875, providerConfirmedAuthorisedTotalPence: 788 });
    expect(safe.capturePence).toBe(788);
    expect(safe.shortfallPence).toBe(87);
    expect(safe.payablePence).toBe(875);
    const result = await guardedCaptureRevolutOrder({
      ...captureArgs, amountPence: safe.capturePence, expectedPayablePence: safe.payablePence,
    });
    expect(result.ok).toBe(true);
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith("sandbox", "unused-mocked-provider", "order", 788);
    expect(mocks.claim).toHaveBeenCalledWith(captureArgs.supabase, expect.objectContaining({ targetAmountPence: 788, payableSnapshotVersion: 7 }));
  });

  it("still rejects a newer 900p payable instead of bypassing the fare guard", async () => {
    mocks.snapshot.mockResolvedValue({ id: "snapshot", version: 8, total_payable_pence: 900, currency: "GBP" });
    const result = await guardedCaptureRevolutOrder({ ...captureArgs, amountPence: 788, expectedPayablePence: 875 });
    expect(result).toMatchObject({ ok: false, code: "STALE_PAYABLE" });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("still refuses an old snapshot version even if its amount is covered", async () => {
    const result = await guardedCaptureRevolutOrder({ ...captureArgs, amountPence: 788, expectedPayablePence: 875, payableSnapshotVersion: 6 });
    expect(result).toMatchObject({ ok: false, code: "STALE_PAYABLE" });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("retains the genuine session lock requirement", async () => {
    const supabase = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    const result = await guardedCaptureRevolutOrder({ ...captureArgs, supabase: supabase as typeof captureArgs.supabase,
      amountPence: 788, expectedPayablePence: 875, sessionLockAlreadyHeld: true, sessionLockOwner: "completion" });
    expect(result).toMatchObject({ ok: false, code: "CLAIM_REFUSED" });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not POST again while a financial operation is inflight", async () => {
    mocks.claim.mockResolvedValue({ ok: false, reason: "inflight", action: "reconcile_only" });
    const result = await guardedCaptureRevolutOrder({ ...captureArgs, amountPence: 788, expectedPayablePence: 875 });
    expect(result).toMatchObject({ ok: false, code: "CLAIM_REFUSED", reconcileOnly: true });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("runs completion through a declined top-up, capture confirmation, settlement and shortfall recording", async () => {
    const trip = { id: "trip", status: "completed", provider_order_id: "order", payment_session_id: "session",
      financial_model: "PLATFORM_COLLECTED", final_customer_fare_pence: 875, currency_code: "GBP" };
    const session = { id: "session", status: "authorized", provider_state: "AUTHORISED", captured_amount_pence: 0, buffer_pence: 0 };
    const db = {
      from(table: string) {
        const reply = { data: table === "trips" ? trip : table === "payments" ? [] : session, error: null };
        const query = {
          select: () => query, eq: () => query, neq: () => query, order: () => query, limit: () => query,
          maybeSingle: async () => reply,
          then: (resolve: (value: typeof reply) => unknown) => Promise.resolve(reply).then(resolve),
        };
        return query;
      },
    };
    // Snapshot persistence is mocked, but its real builder and capture guard run.
    mocks.snapshot.mockResolvedValue({ id: "snapshot", version: 7, total_payable_pence: 875, currency: "GBP" });
    mocks.retrieve.mockResolvedValueOnce({ id: "order", state: "AUTHORISED", amount: 788, authorised_amount: 788, currency: "GBP" });
    mocks.increment.mockResolvedValue({ ok: false, kind: "declined", providerConfirmedTotalPence: 788, message: "Bank declined top-up" });
    mocks.settlement.mockResolvedValue({ settlement_status: "SUCCEEDED", wallet_posting_status: "SUCCEEDED", reconciliation_status: "BALANCED" });
    mocks.shortfall.mockResolvedValue({ manual_review: false, state: "recorded" });
    const result = await executeRevolutTripCompletionCapture({ supabase: db as unknown as typeof captureArgs.supabase, trip });
    expect(result).toMatchObject({ success: true, status: "PARTIAL_CAPTURE_ONLY", capture_amount_pence: 788, wallet_posting_status: "SUCCEEDED" });
    expect(mocks.increment).toHaveBeenCalledWith(expect.objectContaining({ supabase: db, requiredTotalPence: 875 }));
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith("sandbox", "unused-mocked-provider", "order", 788);
    expect(mocks.sessionCaptured).toHaveBeenCalledWith(db, expect.objectContaining({ captureAmountPence: 788, payablePence: 875 }));
    expect(mocks.settlement).toHaveBeenCalledWith(expect.objectContaining({ tripId: "trip", captureAmountPence: 788 }));
    expect(mocks.shortfall).toHaveBeenCalledWith(db, expect.objectContaining({ expected_fare_pence: 875, captured_pence: 788, shortfall_pence: 87 }), expect.anything());
  });
});

describe("payable snapshot matches the shared capture fare", () => {
  it("does not add the 266p modification already inside the 716p customer fare", () => {
    const trip = { final_customer_fare_pence: 716, gross_fare_pence: 766, customer_modification_charge_pence: 266,
      discount_pence: 50, pickup_waiting_charge_pence: 12, tip_pence: 100 };
    const snapshot = buildAuthoritativePayableFromTrip({ trip, source: "completion" });
    expect(snapshot.total_payable_pence).toBe(828);
    expect(snapshot.total_payable_pence).toBe(computeCaptureAmount(trip, "completed").capture_amount_pence);
  });

  it("does not add the 700p airport charge already inside the 7700p customer fare", () => {
    const trip = { final_customer_fare_pence: 7700, commissionable_fare_pence: 7000, airport_charge_pence: 700 };
    const snapshot = buildAuthoritativePayableFromTrip({ trip, source: "completion" });
    expect(snapshot.total_payable_pence).toBe(7700);
    expect(snapshot.total_payable_pence).toBe(computeCaptureAmount(trip, "completed").capture_amount_pence);
  });

  it("adds an airport charge once when the customer fare is ride-only", () => {
    const trip = { final_customer_fare_pence: 7000, commissionable_fare_pence: 7000, airport_charge_pence: 700 };
    expect(buildAuthoritativePayableFromTrip({ trip, source: "completion" }).total_payable_pence).toBe(7700);
  });

  it("uses net customer fare rather than subtracting the offer discount a second time", () => {
    const trip = { final_customer_fare_pence: 788, gross_fare_pence: 875, offer_discount_pence: 87, fare_locked: true };
    expect(buildAuthoritativePayableFromTrip({ trip, source: "completion" }).total_payable_pence).toBe(788);
  });

  it("uses the shared stop-waiting fallback once", () => {
    const trip = { final_customer_fare_pence: 788, pickup_waiting_charge_pence: 12, total_waiting_charge_pence: 36 };
    expect(buildAuthoritativePayableFromTrip({ trip, source: "completion" }).total_payable_pence).toBe(824);
  });

  it("preserves recovered booking net fare from 875p gross less 87p discount", () => {
    const trip = { locked_base_fare_pence: 875, gross_fare_pence: 875, final_customer_fare_pence: 788,
      final_fare_pence: 788, offer_discount_pence: 87, airport_charge_pence: 0 };
    expect(buildAuthoritativePayableFromTrip({ trip, source: "booking", waitingBasis: "none" }).total_payable_pence).toBe(788);
  });
});