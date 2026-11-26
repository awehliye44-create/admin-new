/**
 * Canonical CAPTURE POST guard — session lock → claim → mark dispatched → POST → GET confirm.
 * Mixed-version: session CAPTURING lock interlocks with pre-#92 workers that use the same lock.
 * Does not change Revolut capture amount semantics.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  captureRevolutOrder,
  retrieveRevolutOrder,
  type ProviderEnvironment,
  type RevolutOrder,
} from "./revolutOrders.ts";
import { loadPaymentSsotCutoverConfig } from "./paymentSsotCutoverSSOT.ts";
import {
  claimFinancialOperationForPost,
  completeFinancialOperationFromProvider,
  loadLatestPayableSnapshot,
  markFinancialOperationPostDispatched,
} from "./paymentFinancialOperationPersistSSOT.ts";
import { recordPaymentFinancialEvent } from "./paymentFinancialDiagnosticsSSOT.ts";
import { extractConfirmedCaptureAmountPence } from "./paymentHoldProviderTerminalPure.ts";
import { isProviderCaptureTerminalState } from "./paymentSessionsCaptureConfirmationSSOT.ts";
import {
  claimPaymentSessionFinancialLock,
  readPaymentSessionFinancialLock,
  releasePaymentSessionFinancialLock,
} from "./paymentSessionFinancialLockSSOT.ts";
import { assertProviderCaptureEvidenceBinding } from "./paymentSsotQuiescenceSSOT.ts";

export type GuardedCaptureResult =
  | {
    ok: true;
    order: RevolutOrder;
    confirmedCapturedPence: number;
    requestedPence: number;
    executionId: string | null;
    payableSnapshotVersion: number | null;
  }
  | {
    ok: false;
    code: "CLAIM_REFUSED" | "CAPTURE_UNKNOWN" | "PROVIDER_ERROR" | "STALE_PAYABLE";
    message: string;
    order: RevolutOrder | null;
    reconcileOnly: boolean;
  };

export async function guardedCaptureRevolutOrder(args: {
  supabase: SupabaseClient;
  environment: ProviderEnvironment;
  secretKey: string;
  tripId: string;
  paymentSessionId: string;
  providerOrderId: string;
  amountPence: number;
  payableSnapshotVersion?: number;
  /** When set, refuse capture if a newer snapshot total exceeds this version's basis. */
  expectedPayablePence?: number | null;
  merchantAccountRef?: string | null;
  currency?: string;
  /**
   * fare = trip fare settlement; terminal_fee / orphan_fee / lifecycle_fee = non-fare.
   * Never treat fee captures as trip fare settlement.
   */
  purpose?: "fare" | "terminal_fee" | "orphan_fee" | "lifecycle_fee";
  /**
   * When true, caller already holds the session CAPTURING/RECONCILING lock.
   * Must be accompanied by a genuine live lock on the session — never a bare flag.
   */
  sessionLockAlreadyHeld?: boolean;
  /** When already held, optional expected owner (must match live lock owner). */
  sessionLockOwner?: string | null;
}): Promise<GuardedCaptureResult> {
  const amount = Math.max(0, Math.round(Number(args.amountPence) || 0));
  const purpose = args.purpose ?? "fare";
  const currency = args.currency ?? "GBP";
  const cutover = await loadPaymentSsotCutoverConfig(args.supabase);

  // Stale payable guard: never capture against an obsolete agreed fare snapshot.
  let snapshotVersion = args.payableSnapshotVersion ?? 0;
  const latestSnap = await loadLatestPayableSnapshot(args.supabase, args.tripId);
  if (latestSnap && !("error" in latestSnap) && latestSnap !== null) {
    if (snapshotVersion > 0 && latestSnap.version > snapshotVersion) {
      return {
        ok: false,
        code: "STALE_PAYABLE",
        message:
          `Stale payable snapshot v${snapshotVersion}; latest is v${latestSnap.version}`,
        order: null,
        reconcileOnly: true,
      };
    }
    if (
      args.expectedPayablePence != null
      && Number.isFinite(args.expectedPayablePence)
      && latestSnap.total_payable_pence > Math.round(Number(args.expectedPayablePence))
      && purpose === "fare"
    ) {
      return {
        ok: false,
        code: "STALE_PAYABLE",
        message:
          `Capture payable ${args.expectedPayablePence}p behind snapshot ${latestSnap.total_payable_pence}p`,
        order: null,
        reconcileOnly: true,
      };
    }
    snapshotVersion = Math.max(snapshotVersion, latestSnap.version);
  }

  // Mixed-version interlock with #91A workers that claim CAPTURING on the session.
  const lockOwner = `guarded_capture:${purpose}:${args.tripId}:${args.providerOrderId}:${amount}`;
  let sessionLockHeld = false;
  if (args.sessionLockAlreadyHeld === true) {
    // #110 P4C: flag alone is insufficient — require a live CAPTURING/RECONCILING owner.
    const { data: lockRow } = await args.supabase
      .from("payment_sessions")
      .select(
        "id, metadata, financial_operation_state, financial_operation_owner, financial_operation_started_at",
      )
      .eq("id", args.paymentSessionId)
      .maybeSingle();
    const live = readPaymentSessionFinancialLock(
      (lockRow ?? null) as Record<string, unknown> | null,
    );
    const expectedOwner = String(args.sessionLockOwner ?? "").trim();
    const ownerOk = live.owner != null
      && (expectedOwner.length === 0 || live.owner === expectedOwner);
    const stateOk = live.state === "CAPTURING" || live.state === "RECONCILING";
    if (!lockRow || !stateOk || !ownerOk) {
      return {
        ok: false,
        code: "CLAIM_REFUSED",
        message:
          `sessionLockAlreadyHeld without genuine lock (${live.state}/${live.owner ?? "none"})`,
        order: null,
        reconcileOnly: true,
      };
    }
    sessionLockHeld = true;
  } else {
    const sessionLock = await claimPaymentSessionFinancialLock(args.supabase, {
      paymentSessionId: args.paymentSessionId,
      owner: lockOwner,
      state: "CAPTURING",
      operationKey: `capture:${purpose}:${amount}`,
    });
    if (!sessionLock.ok) {
      return {
        ok: false,
        code: "CLAIM_REFUSED",
        message:
          `Session CAPTURING busy (${sessionLock.currentState}/${sessionLock.currentOwner})`,
        order: null,
        reconcileOnly: true,
      };
    }
    sessionLockHeld = true;
  }

  const releaseSession = async () => {
    if (!args.sessionLockAlreadyHeld && sessionLockHeld) {
      await releasePaymentSessionFinancialLock(args.supabase, {
        paymentSessionId: args.paymentSessionId,
        owner: lockOwner,
        nextState: "IDLE",
      }).catch(() => undefined);
    }
  };

  const claim = await claimFinancialOperationForPost(args.supabase, {
    opType: "CAPTURE",
    tripId: args.tripId,
    paymentSessionId: args.paymentSessionId,
    providerOrderId: args.providerOrderId,
    targetAmountPence: amount,
    payableSnapshotVersion: snapshotVersion > 0 ? snapshotVersion : 1,
    merchantAccountRef: args.merchantAccountRef,
    currency,
    purpose,
  }).catch((err) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err),
    action: "error" as const,
  }));

  // Missing migration may soft-skip in Stage A–B only.
  // Inflight / busy / Stage C+ / Stage D require refusal — never silent duplicate POST.
  const missingMigration = !claim.ok &&
    /relation .* does not exist|payment_financial_operations/i.test(claim.reason);

  if (!claim.ok) {
    if (
      claim.action === "reconcile_only" ||
      claim.action === "busy" ||
      cutover.require_financial_op_claim ||
      (!missingMigration && cutover.stage !== "A" && cutover.stage !== "B")
    ) {
      await releaseSession();
      return {
        ok: false,
        code: "CLAIM_REFUSED",
        message: `Capture claim refused: ${claim.reason}`,
        order: null,
        reconcileOnly: claim.action === "reconcile_only" || claim.action === "busy",
      };
    }
    await recordPaymentFinancialEvent(args.supabase, {
      paymentSessionId: args.paymentSessionId,
      tripId: args.tripId,
      opType: "CAPTURE",
      eventType: missingMigration ? "claim_soft_skip_missing_migration" : "claim_soft_skip",
      requestedAmountPence: amount,
      detail: { reason: claim.reason, stage: cutover.stage, purpose },
    });
  }

  if (claim.ok) {
    await markFinancialOperationPostDispatched(args.supabase, {
      operationId: claim.operationId,
      fence: claim.fence,
      opType: "CAPTURE",
    });
  }

  try {
    await captureRevolutOrder(
      args.environment,
      args.secretKey,
      args.providerOrderId,
      amount,
    );
  } catch (err) {
    if (claim.ok) {
      await completeFinancialOperationFromProvider(args.supabase, {
        operationId: claim.operationId,
        fence: claim.fence,
        state: "CAPTURE_UNKNOWN",
        httpStatus: 500,
      }).catch(() => undefined);
    }
    await releaseSession();
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: err instanceof Error ? err.message : String(err),
      order: null,
      reconcileOnly: true,
    };
  }

  const order = await retrieveRevolutOrder(
    args.environment,
    args.secretKey,
    args.providerOrderId,
  );
  const confirmed = extractConfirmedCaptureAmountPence(
    order as unknown as Record<string, unknown>,
    order.state,
  );
  const terminal = isProviderCaptureTerminalState(order.state);
  const binding = assertProviderCaptureEvidenceBinding({
    claimedProviderOrderId: args.providerOrderId,
    retrievedOrderId: order.id,
    claimedPaymentSessionId: args.paymentSessionId,
    claimedCurrency: currency,
    retrievedCurrency: (order as { currency?: string }).currency ?? currency,
    requestedAmountPence: amount,
    confirmedAmountPence: confirmed,
    providerTerminal: terminal === true,
  });

  if (!binding.ok) {
    if (claim.ok) {
      await completeFinancialOperationFromProvider(args.supabase, {
        operationId: claim.operationId,
        fence: claim.fence,
        state: "CAPTURE_UNKNOWN",
      }).catch(() => undefined);
    }
    await releaseSession();
    return {
      ok: false,
      code: "CAPTURE_UNKNOWN",
      message: `Provider evidence not bound: ${binding.reason}`,
      order,
      reconcileOnly: true,
    };
  }

  if (claim.ok) {
    await completeFinancialOperationFromProvider(args.supabase, {
      operationId: claim.operationId,
      fence: claim.fence,
      state: confirmed === amount
        ? "FULLY_CAPTURED"
        : confirmed! < amount
        ? "PARTIALLY_CAPTURED"
        : "FULLY_CAPTURED",
      confirmedAmountPence: confirmed!,
    }).catch(() => undefined);
  }

  // Leave session lock to caller when they held it; otherwise release to IDLE
  // (completion path advances CAPTURED via its own finalizer).
  await releaseSession();

  return {
    ok: true,
    order,
    confirmedCapturedPence: confirmed!,
    requestedPence: amount,
    executionId: claim.ok ? claim.executionId : null,
    payableSnapshotVersion: snapshotVersion > 0 ? snapshotVersion : null,
  };
}
